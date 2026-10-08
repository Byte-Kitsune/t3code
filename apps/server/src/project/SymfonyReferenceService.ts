import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProcessRunner from "../processRunner.ts";
import * as MagoDockerExecution from "../analyzers/MagoDockerExecution.ts";
import * as AnalyzerDiscoveryService from "./AnalyzerDiscoveryService.ts";
import * as MonolithService from "./MonolithService.ts";

const isDockerError = Schema.is(MagoDockerExecution.MagoDockerError);
const isProcessError = Schema.is(ProcessRunner.ProcessRunError);
const processFailureDetail = (cause: unknown): string => {
  if (isProcessError(cause)) return cause.message;
  if (isDockerError(cause))
    return [cause.message, processFailureDetail(cause.cause)].filter(Boolean).join(" ");
  return "";
};

// Never include container JSON: it can contain resolved service arguments and secrets.
const stderrDetail = (stderr: string): string =>
  stderr
    // eslint-disable-next-line no-control-regex -- Strip terminal ANSI color codes.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .trim()
    .slice(-4_000);

export class SymfonyReferenceError extends Schema.TaggedError<SymfonyReferenceError>()(
  "SymfonyReferenceError",
  {
    areaId: Schema.String,
    stage: Schema.Literals(["discover", "prerequisites", "types", "services", "export", "write"]),
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.detail ?? processFailureDetail(this.cause);
    return `Could not generate the Symfony container reference (${this.stage}).${detail ? ` ${detail}` : ""}`;
  }
}

export class SymfonyReferenceService extends Context.Service<
  SymfonyReferenceService,
  {
    readonly generate: (input: {
      readonly cwd: string;
      readonly areaId: string;
    }) => Effect.Effect<{ readonly areaId: string; readonly path: string }, SymfonyReferenceError>;
  }
>()("t3/project/SymfonyReferenceService") {}

const jsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const monolith = yield* MonolithService.MonolithService;
  const discovery = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
  const generation = yield* Semaphore.make(1);
  const transport = yield* Effect.serviceOption(MagoDockerExecution.MagoDockerExecution);
  const generate: SymfonyReferenceService["Service"]["generate"] = Effect.fn(
    "SymfonyReferenceService.generate",
  )(function* ({ cwd, areaId }) {
    const snapshot = yield* monolith
      .get({ cwd, initialize: false })
      .pipe(
        Effect.mapError((cause) => new SymfonyReferenceError({ areaId, stage: "discover", cause })),
      );
    const area = snapshot.config.areas.find(
      (area) => area.id === areaId && area.enabled !== false && area.kind === "php",
    );
    if (!area) return yield* new SymfonyReferenceError({ areaId, stage: "prerequisites" });
    const root = yield* fs
      .realPath(cwd)
      .pipe(
        Effect.mapError(
          (cause) => new SymfonyReferenceError({ areaId, stage: "prerequisites", cause }),
        ),
      );
    const discovered = yield* discovery
      .discover({ cwd: root, areas: [area] })
      .pipe(
        Effect.mapError((cause) => new SymfonyReferenceError({ areaId, stage: "discover", cause })),
      );
    const reference = discovered[0]?.tools.find(
      (tool) =>
        tool.symfonyWiringReference &&
        (area.magoDocker ||
          (tool.symfonyWiringReference.generatorAvailable &&
            tool.symfonyWiringReference.autoloadAvailable)),
    )?.symfonyWiringReference;
    if (!reference)
      return yield* new SymfonyReferenceError({
        areaId,
        stage: "prerequisites",
        detail:
          "No installed Symfony wiring generator and application autoloader were found for this PHP area.",
      });
    const safePath = Effect.fnUntraced(function* (relative: string, allowMissing = false) {
      const target = paths.resolve(root, relative);
      const fromRoot = paths.relative(root, target);
      if (fromRoot === ".." || fromRoot.startsWith(`..${paths.sep}`) || paths.isAbsolute(fromRoot))
        return yield* new SymfonyReferenceError({ areaId, stage: "prerequisites" });
      let ancestor = root;
      for (const component of fromRoot.split(paths.sep).filter(Boolean)) {
        ancestor = paths.join(ancestor, component);
        const link = yield* fs.readLink(ancestor).pipe(Effect.option);
        if (Option.isSome(link))
          return yield* new SymfonyReferenceError({ areaId, stage: "prerequisites" });
        const actual = yield* fs.realPath(ancestor).pipe(
          Effect.asSome,
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "NotFound" && allowMissing
                ? Effect.succeed(Option.none<string>())
                : Effect.fail(new SymfonyReferenceError({ areaId, stage: "prerequisites", cause })),
          }),
        );
        if (Option.isSome(actual) && actual.value !== ancestor)
          return yield* new SymfonyReferenceError({ areaId, stage: "prerequisites" });
      }
      return target;
    });
    const appRoot = yield* safePath(area.path);
    const consolePath = yield* safePath(paths.join(area.path, "bin/console"), !!area.magoDocker);
    const generatorPath = yield* safePath(reference.generatorPath, !!area.magoDocker);
    const autoloadPath = yield* safePath(reference.autoloadPath, !!area.magoDocker);
    const referencePath = yield* safePath(reference.referencePath, true);
    if (area.magoDocker && Option.isNone(transport))
      return yield* new SymfonyReferenceError({ areaId, stage: "prerequisites" });
    const docker =
      area.magoDocker && Option.isSome(transport)
        ? yield* transport.value
            .prepare({ workspaceRoot: root, areaPath: area.path, runtime: area.magoDocker })
            .pipe(
              Effect.mapError(
                (cause) => new SymfonyReferenceError({ areaId, stage: "prerequisites", cause }),
              ),
            )
        : undefined;
    if (docker)
      for (const target of [consolePath, generatorPath, autoloadPath]) {
        if (
          !(yield* docker
            .exists(target)
            .pipe(
              Effect.mapError(
                (cause) => new SymfonyReferenceError({ areaId, stage: "prerequisites", cause }),
              ),
            ))
        )
          return yield* new SymfonyReferenceError({ areaId, stage: "prerequisites" });
      }
    const runJson = Effect.fnUntraced(function* (
      stage: "types" | "services" | "export",
      args: ReadonlyArray<string>,
    ) {
      const failure = (cause: unknown) => new SymfonyReferenceError({ areaId, stage, cause });
      const processEffect = docker
        ? docker.runPhp(args, { APP_ENV: "dev", APP_DEBUG: "1" }).pipe(Effect.mapError(failure))
        : runner
            .run({
              command: "php",
              args,
              cwd: appRoot,
              env: { ...process.env, APP_ENV: "dev", APP_DEBUG: "1" },
              timeout: 60_000,
              maxOutputBytes: 4_000_000,
              outputMode: "error",
              timeoutBehavior: "error",
            })
            .pipe(Effect.mapError(failure));
      const output = yield* processEffect;
      if (
        output.code !== 0 ||
        output.timedOut ||
        output.stdoutTruncated ||
        output.stderrTruncated ||
        output.stdoutInvalidUtf8 ||
        output.stderrInvalidUtf8
      )
        return yield* new SymfonyReferenceError({
          areaId,
          stage,
          detail: [
            output.timedOut
              ? "PHP command timed out."
              : output.stdoutTruncated || output.stderrTruncated
                ? "PHP command exceeded its output limit."
                : output.stdoutInvalidUtf8 || output.stderrInvalidUtf8
                  ? "PHP command returned invalid UTF-8."
                  : `PHP command exited with code ${output.code}.`,
            stderrDetail(output.stderr),
          ]
            .filter(Boolean)
            .join("\n"),
        });
      yield* jsonObject(output.stdout).pipe(
        Effect.mapError(
          () =>
            new SymfonyReferenceError({
              areaId,
              stage,
              detail: [
                "PHP command did not return a valid JSON object. Check for PHP warnings or extra output on stdout.",
                stderrDetail(output.stderr),
              ]
                .filter(Boolean)
                .join("\n"),
            }),
        ),
      );
      return output.stdout;
    });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temporaryDirectory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-symfony-reference-" })
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        const typesPath = paths.join(temporaryDirectory, "types.json");
        const servicesPath = paths.join(temporaryDirectory, "services.json");
        const remote = docker
          ? yield* docker.allocateTemp.pipe(
              Effect.mapError(
                (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
              ),
            )
          : undefined;
        const base = [
          docker ? docker.toContainer(consolePath) : consolePath,
          "debug:container",
          "--env=dev",
          "--format=json",
          "--no-interaction",
        ];
        const types = yield* runJson("types", [...base, "--types"]);
        const services = yield* runJson("services", base);
        yield* fs
          .writeFileString(typesPath, types)
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        yield* fs
          .writeFileString(servicesPath, services)
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        if (remote) {
          yield* remote
            .write("types.json", types)
            .pipe(
              Effect.mapError(
                (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
              ),
            );
          yield* remote
            .write("services.json", services)
            .pipe(
              Effect.mapError(
                (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
              ),
            );
        }
        const exported = yield* runJson("export", [
          docker ? docker.toContainer(generatorPath) : generatorPath,
          `--types=${remote ? `${remote.path}/types.json` : typesPath}`,
          `--services=${remote ? `${remote.path}/services.json` : servicesPath}`,
          `--autoload=${docker ? docker.toContainer(autoloadPath) : autoloadPath}`,
        ]);
        // Nothing touches the shared reference before all three processes and the
        // JSON validation succeed. Publish in the same directory for atomic rename.
        yield* safePath(reference.referencePath, true);
        yield* fs
          .makeDirectory(paths.dirname(referencePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        const temporary = yield* fs
          .makeTempFileScoped({
            directory: paths.dirname(referencePath),
            prefix: ".t3-symfony-reference-",
            suffix: ".json",
          })
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        yield* fs
          .writeFileString(temporary, `${exported.trim()}\n`)
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        yield* fs
          .rename(temporary, referencePath)
          .pipe(
            Effect.mapError(
              (cause) => new SymfonyReferenceError({ areaId, stage: "write", cause }),
            ),
          );
        return { areaId, path: reference.referencePath };
      }),
    );
  });
  return SymfonyReferenceService.of({
    generate: (input) => generation.withPermits(1)(generate(input)),
  });
});

export const layer = Layer.effect(SymfonyReferenceService, make);
