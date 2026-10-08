import {
  MONOLITH_CONFIG_FILE_NAME,
  MonolithConfig,
  type MonolithArea,
  type MonolithGetInput,
  type MonolithSaveInput,
  type MonolithSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class MonolithError extends Schema.TaggedError<MonolithError>()("MonolithError", {
  operation: Schema.Literals(["root", "discover", "read", "validate", "write"]),
  path: Schema.String,
  reason: Schema.Literals(["io", "invalid_config", "unsafe_path", "not_directory", "scan_limit"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "invalid_config"
      ? "The monolith configuration is invalid."
      : this.reason === "unsafe_path"
        ? "Monolith paths must stay inside the repository and cannot use symbolic links."
        : this.reason === "not_directory"
          ? "The monolith workspace must be a directory."
          : this.reason === "scan_limit"
            ? "Monolith discovery exceeded the directory limit. Configure areas manually."
            : `Failed to ${this.operation} monolith areas.`;
  }
}

export class MonolithService extends Context.Service<
  MonolithService,
  {
    readonly get: (input: MonolithGetInput) => Effect.Effect<MonolithSnapshot, MonolithError>;
    readonly discover: (
      input: MonolithGetInput,
    ) => Effect.Effect<ReadonlyArray<MonolithArea>, MonolithError>;
    readonly save: (input: MonolithSaveInput) => Effect.Effect<MonolithSnapshot, MonolithError>;
  }
>()("t3/project/MonolithService") {}

const ignoredDirectories = new Set([
  "vendor",
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "build",
  "dist",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vite",
  ".vite-plus",
  ".t3",
  ".repos",
]);
const decodeConfig = Schema.decodeUnknownEffect(MonolithConfig);
const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(MonolithConfig));
const encodeConfigJson = Schema.encodeEffect(Schema.fromJsonString(MonolithConfig, { space: 2 }));
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveRoot = Effect.fnUntraced(function* (cwd: string) {
    const root = yield* fileSystem
      .realPath(path.resolve(cwd))
      .pipe(
        Effect.mapError(
          (cause) => new MonolithError({ operation: "root", path: cwd, reason: "io", cause }),
        ),
      );
    const info = yield* fileSystem
      .stat(root)
      .pipe(
        Effect.mapError(
          (cause) => new MonolithError({ operation: "root", path: root, reason: "io", cause }),
        ),
      );
    if (info.type !== "Directory") {
      return yield* new MonolithError({ operation: "root", path: root, reason: "not_directory" });
    }
    return root;
  });

  const optionalRealPath = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new MonolithError({ operation: "validate", path: target, reason: "io", cause }),
              ),
      }),
    );

  const validateConfig = Effect.fnUntraced(function* (root: string, input: MonolithConfig) {
    const config = yield* decodeConfig(input).pipe(
      Effect.mapError(
        (cause) =>
          new MonolithError({ operation: "validate", path: root, reason: "invalid_config", cause }),
      ),
    );
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const area of config.areas) {
      if (ids.has(area.id) || paths.has(area.path)) {
        return yield* new MonolithError({
          operation: "validate",
          path: root,
          reason: "invalid_config",
        });
      }
      ids.add(area.id);
      paths.add(area.path);
      // Check each ancestor, including missing descendants of a symlink. A
      // deleted area can remain configured without silently changing its path.
      let target = root;
      for (const part of area.path === "." ? [] : area.path.split("/")) {
        target = path.join(target, part);
        const resolved = yield* optionalRealPath(target);
        if (Option.isSome(resolved) && resolved.value !== target) {
          return yield* new MonolithError({
            operation: "validate",
            path: target,
            reason: "unsafe_path",
          });
        }
        // realpath reports NotFound for dangling links, so check those too.
        const link = yield* fileSystem.readLink(target).pipe(Effect.option);
        if (Option.isSome(link)) {
          return yield* new MonolithError({
            operation: "validate",
            path: target,
            reason: "unsafe_path",
          });
        }
      }
    }
    return config;
  });

  const readConfig = Effect.fnUntraced(function* (root: string) {
    const configPath = path.join(root, MONOLITH_CONFIG_FILE_NAME);
    const link = yield* fileSystem.readLink(configPath).pipe(Effect.option);
    if (Option.isSome(link)) {
      return yield* new MonolithError({
        operation: "read",
        path: configPath,
        reason: "unsafe_path",
      });
    }
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new MonolithError({ operation: "read", path: configPath, reason: "io", cause }),
              ),
      }),
    );
    if (Option.isNone(raw)) return Option.none<MonolithConfig>();
    const config = yield* decodeConfigJson(raw.value).pipe(
      Effect.mapError(
        (cause) =>
          new MonolithError({
            operation: "read",
            path: configPath,
            reason: "invalid_config",
            cause,
          }),
      ),
    );
    return Option.some(yield* validateConfig(root, config));
  });

  const scan = Effect.fnUntraced(function* (root: string) {
    const areas: Array<MonolithArea> = [];
    const queue = [{ directory: root, phpAncestor: false }];
    let visited = 0;
    const readManifest = Effect.fnUntraced(function* (directory: string, filename: string) {
      const target = path.join(directory, filename);
      const canonical = yield* optionalRealPath(target);
      if (Option.isNone(canonical) || canonical.value !== target) return Option.none();
      return yield* fileSystem
        .readFileString(target)
        .pipe(Effect.flatMap(decodeManifest), Effect.option);
    });
    while (queue.length > 0) {
      const entry = queue.pop()!;
      if (++visited > 20_000) {
        return yield* new MonolithError({
          operation: "discover",
          path: root,
          reason: "scan_limit",
        });
      }
      const composer = yield* readManifest(entry.directory, "composer.json");
      const packageJson = yield* readManifest(entry.directory, "package.json");
      const hasPhp = Option.isSome(composer);
      const hasReact =
        Option.isSome(packageJson) &&
        [
          packageJson.value.dependencies,
          packageJson.value.devDependencies,
          packageJson.value.peerDependencies,
        ].some(
          (dependencies) =>
            dependencies !== null && typeof dependencies === "object" && "react" in dependencies,
        );
      const relative = path.relative(root, entry.directory).split(path.sep).join("/") || ".";
      const addArea = (kind: "php" | "react") => {
        const id = `${kind}:${relative}`;
        areas.push({
          id,
          name: path.basename(entry.directory).slice(0, 200),
          path: relative,
          kind,
          enabled: true,
        });
      };
      if (hasPhp) addArea("php");
      if (hasReact && !hasPhp) addArea("react");
      const children = yield* fileSystem.readDirectory(entry.directory).pipe(
        Effect.mapError(
          (cause) =>
            new MonolithError({
              operation: "discover",
              path: entry.directory,
              reason: "io",
              cause,
            }),
        ),
      );
      for (const child of children.toSorted().toReversed()) {
        if (ignoredDirectories.has(child)) continue;
        if ((hasPhp || entry.phpAncestor) && child === "tools") continue;
        const directory = path.join(entry.directory, child);
        const canonical = yield* optionalRealPath(directory);
        if (Option.isNone(canonical) || canonical.value !== directory) continue;
        const info = yield* fileSystem
          .stat(directory)
          .pipe(
            Effect.mapError(
              (cause) =>
                new MonolithError({ operation: "discover", path: directory, reason: "io", cause }),
            ),
          );
        if (info.type !== "Directory") continue;
        const phpAncestor = hasPhp || entry.phpAncestor;
        queue.push({ directory, phpAncestor });
      }
    }
    return areas.toSorted((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  });

  const writeConfig = Effect.fnUntraced(function* (
    root: string,
    config: MonolithConfig,
    initial: boolean,
  ) {
    const configPath = path.join(root, MONOLITH_CONFIG_FILE_NAME);
    const contents = yield* encodeConfigJson(config).pipe(
      Effect.mapError(
        (cause) =>
          new MonolithError({
            operation: "validate",
            path: configPath,
            reason: "invalid_config",
            cause,
          }),
      ),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fileSystem.makeTempFileScoped({
          directory: root,
          prefix: ".t3-monolith-",
          suffix: ".json",
        });
        yield* fileSystem.writeFileString(temporary, `${contents}\n`);
        if (initial) {
          // Hard-link publication is atomic and cannot overwrite a simultaneous
          // first initialization or an edit made while discovery was running.
          return yield* fileSystem.link(temporary, configPath).pipe(
            Effect.as(true),
            Effect.catchTags({
              PlatformError: (cause) =>
                cause.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(cause),
            }),
          );
        }
        yield* fileSystem.rename(temporary, configPath);
        return true;
      }),
    ).pipe(
      Effect.mapError(
        (cause) => new MonolithError({ operation: "write", path: configPath, reason: "io", cause }),
      ),
    );
  });

  const get: MonolithService["Service"]["get"] = Effect.fn("MonolithService.get")(function* ({
    cwd,
    initialize,
  }) {
    const root = yield* resolveRoot(cwd);
    const configPath = path.join(root, MONOLITH_CONFIG_FILE_NAME);
    const existing = yield* readConfig(root);
    if (Option.isSome(existing)) return { config: existing.value, configPath, source: "config" };
    const config: MonolithConfig = { version: 1, initialized: true, areas: yield* scan(root) };
    if (initialize === false) return { config, configPath, source: "discovered" };
    const published = yield* writeConfig(root, config, true);
    if (published) return { config, configPath, source: "discovered" };
    const winner = yield* readConfig(root);
    if (Option.isNone(winner)) {
      return yield* new MonolithError({
        operation: "read",
        path: configPath,
        reason: "invalid_config",
      });
    }
    return { config: winner.value, configPath, source: "config" };
  });
  const discover: MonolithService["Service"]["discover"] = Effect.fn("MonolithService.discover")(
    function* ({ cwd }) {
      return yield* scan(yield* resolveRoot(cwd));
    },
  );
  const save: MonolithService["Service"]["save"] = Effect.fn("MonolithService.save")(function* ({
    cwd,
    config: input,
  }) {
    const root = yield* resolveRoot(cwd);
    const config = yield* validateConfig(root, input);
    const configPath = path.join(root, MONOLITH_CONFIG_FILE_NAME);
    const link = yield* fileSystem.readLink(configPath).pipe(Effect.option);
    if (Option.isSome(link)) {
      return yield* new MonolithError({
        operation: "write",
        path: configPath,
        reason: "unsafe_path",
      });
    }
    yield* writeConfig(root, config, false);
    return { config, configPath, source: "config" };
  });

  return MonolithService.of({ get, discover, save });
});

export const layer = Layer.effect(MonolithService, make);
