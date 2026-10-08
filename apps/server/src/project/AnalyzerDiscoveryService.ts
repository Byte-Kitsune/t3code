import type { MonolithArea } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type AnalyzerScript = {
  readonly name: string;
  readonly operation: "format" | "analyze" | "guard" | "lint" | "check" | "references";
  readonly command: string;
  readonly configPath?: string;
};
export type DiscoveredAnalyzer = {
  readonly tool: "mago" | "biome";
  readonly manifestPath: string;
  readonly workingDirectory: string;
  readonly binaryPath: string;
  readonly available: boolean;
  readonly configPath?: string;
  readonly scripts: ReadonlyArray<AnalyzerScript>;
  readonly symfonyWiring: boolean;
  readonly doctrineQueryBudget?: { readonly autoloadPath: string; readonly available: boolean };
  readonly architectureGraph?: { readonly autoloadPath: string; readonly available: boolean };
  readonly symfonyWiringReference?: {
    readonly generatorPath: string;
    readonly generatorAvailable: boolean;
    readonly referencePath: string;
    readonly referenceAvailable: boolean;
    readonly autoloadPath: string;
    readonly autoloadAvailable: boolean;
  };
};
export type AreaAnalyzers = {
  readonly areaId: string;
  readonly tools: ReadonlyArray<DiscoveredAnalyzer>;
  readonly warnings: ReadonlyArray<{
    readonly path: string;
    readonly reason: "invalid_manifest" | "unsafe_path" | "unsupported_script";
  }>;
};

export class AnalyzerDiscoveryError extends Schema.TaggedError<AnalyzerDiscoveryError>()(
  "AnalyzerDiscoveryError",
  {
    operation: Schema.Literals(["root", "read"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to discover local analyzer installations.";
  }
}

export class AnalyzerDiscoveryService extends Context.Service<
  AnalyzerDiscoveryService,
  {
    readonly discover: (input: {
      readonly cwd: string;
      readonly areas: ReadonlyArray<MonolithArea>;
    }) => Effect.Effect<ReadonlyArray<AreaAnalyzers>, AnalyzerDiscoveryError>;
  }
>()("t3/project/AnalyzerDiscoveryService") {}

const manifestDecoder = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const dependencies = (manifest: Record<string, unknown>) => ({
  ...record(manifest.require),
  ...record(manifest["require-dev"]),
  ...record(manifest.dependencies),
  ...record(manifest.devDependencies),
});

// Only extract metadata from a single command. Shell recipes remain descriptive
// references, never something an automatic file-open check can execute.
const tokenize = (command: string): ReadonlyArray<string> | undefined => {
  if (/[;&|<>`$\n\r]/.test(command)) return undefined;
  const tokens: Array<string> = [];
  const expression = /"([^"\\]*)"|'([^'\\]*)'|([^\s"']+)/g;
  let consumed = 0;
  for (const match of command.matchAll(expression)) {
    if (command.slice(consumed, match.index).trim() !== "") return undefined;
    tokens.push(match[1] ?? match[2] ?? match[3]!);
    consumed = match.index + match[0].length;
  }
  return command.slice(consumed).trim() === "" ? tokens : undefined;
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const discover: AnalyzerDiscoveryService["Service"]["discover"] = Effect.fn(
    "AnalyzerDiscoveryService.discover",
  )(function* ({ cwd, areas }) {
    const root = yield* fs
      .realPath(path.resolve(cwd))
      .pipe(
        Effect.mapError(
          (cause) => new AnalyzerDiscoveryError({ operation: "root", path: cwd, cause }),
        ),
      );
    const relative = (target: string) =>
      path.relative(root, target).split(path.sep).join("/") || ".";
    const withinRoot = (target: string) => {
      const value = path.relative(root, target);
      return value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
    };
    const resolveInside = (directory: string, target: string) => {
      const absolute = path.resolve(directory, target);
      return withinRoot(absolute) ? absolute : undefined;
    };
    const results: Array<AreaAnalyzers> = [];
    for (const area of areas) {
      const tools: Array<DiscoveredAnalyzer> = [];
      const warnings: Array<AreaAnalyzers["warnings"][number]> = [];
      const areaRoot = resolveInside(root, area.path);
      if (!areaRoot || area.enabled === false || area.kind === "folder") {
        results.push({ areaId: area.id, tools, warnings });
        continue;
      }
      const canonical = yield* fs.realPath(areaRoot).pipe(Effect.option);
      if (Option.isNone(canonical)) {
        results.push({ areaId: area.id, tools, warnings });
        continue;
      }
      if (canonical.value !== areaRoot) {
        warnings.push({ path: area.path, reason: "unsafe_path" });
        results.push({ areaId: area.id, tools, warnings });
        continue;
      }
      const readManifest = Effect.fnUntraced(function* (directory: string, filename: string) {
        const target = path.join(directory, filename);
        const actual = yield* fs.realPath(target).pipe(Effect.option);
        if (Option.isNone(actual)) return Option.none<Record<string, unknown>>();
        if (actual.value !== target) {
          warnings.push({ path: relative(target), reason: "unsafe_path" });
          return Option.none<Record<string, unknown>>();
        }
        const raw = yield* fs
          .readFileString(target)
          .pipe(
            Effect.mapError(
              (cause) => new AnalyzerDiscoveryError({ operation: "read", path: target, cause }),
            ),
          );
        const parsed = yield* manifestDecoder(raw).pipe(Effect.option);
        if (Option.isNone(parsed)) {
          warnings.push({ path: relative(target), reason: "invalid_manifest" });
        }
        return parsed;
      });
      const safeExisting = Effect.fnUntraced(function* (target: string, allowLink = false) {
        const actual = yield* fs.realPath(target).pipe(Effect.option);
        if (Option.isNone(actual)) return false;
        if (!withinRoot(actual.value) || (!allowLink && actual.value !== target)) {
          warnings.push({ path: relative(target), reason: "unsafe_path" });
          return false;
        }
        return Option.exists(
          yield* fs.stat(actual.value).pipe(Effect.option),
          (info) => info.type === "File",
        );
      });
      const manifests: Array<{
        directory: string;
        filename: string;
        manifest: Record<string, unknown>;
      }> = [];
      if (area.kind === "php") {
        const directories = [areaRoot];
        const pending = [path.join(areaRoot, "tools")];
        const ignored = new Set([
          "vendor",
          "node_modules",
          ".git",
          "cache",
          ".cache",
          "build",
          "dist",
        ]);
        while (pending.length > 0 && directories.length < 1_000) {
          const directory = pending.shift()!;
          const actual = yield* fs.realPath(directory).pipe(Effect.option);
          if (Option.isNone(actual) || actual.value !== directory) continue;
          const children = yield* fs.readDirectory(directory).pipe(Effect.option);
          if (Option.isNone(children)) continue;
          directories.push(directory);
          for (const child of children.value.toSorted()) {
            if (!ignored.has(child)) pending.push(path.join(directory, child));
          }
        }
        for (const directory of directories) {
          const manifest = yield* readManifest(directory, "composer.json");
          if (Option.isSome(manifest))
            manifests.push({ directory, filename: "composer.json", manifest: manifest.value });
        }
      } else {
        // Workspace package managers can hoist Biome to a repository ancestor.
        let directory = areaRoot;
        while (withinRoot(directory)) {
          const manifest = yield* readManifest(directory, "package.json");
          if (Option.isSome(manifest))
            manifests.push({ directory, filename: "package.json", manifest: manifest.value });
          if (directory === root) break;
          directory = path.dirname(directory);
        }
      }
      // A configured container may own Composer's vendor directory in a named
      // volume or install Mago globally; host file availability is not its probe.
      if (area.kind === "php" && area.magoDocker && manifests.length === 0)
        manifests.push({ directory: areaRoot, filename: "t3.monolith.json", manifest: {} });
      const hasDeclaredMago = manifests.some(
        (entry) => "carthage-software/mago" in dependencies(entry.manifest),
      );
      const wiringManifests =
        area.kind === "php"
          ? manifests.filter(
              (entry) => "byte-kitsune/mago-symfony-wiring" in dependencies(entry.manifest),
            )
          : [];
      for (const { directory, filename, manifest } of manifests) {
        const tool = area.kind === "php" ? "mago" : "biome";
        const deps = dependencies(manifest);
        const dependency = tool === "mago" ? "carthage-software/mago" : "@biomejs/biome";
        if (
          !(dependency in deps) &&
          !(tool === "mago" && area.magoDocker && !hasDeclaredMago && directory === areaRoot)
        )
          continue;
        const manifestPath = relative(
          path.join(filename === "t3.monolith.json" ? root : directory, filename),
        );
        const scripts: Array<AnalyzerScript> = [];
        const scriptDirectories = new Map<AnalyzerScript, string>();
        const scriptManifests = manifests.filter(
          (entry) =>
            entry.directory === areaRoot ||
            entry.directory === directory ||
            wiringManifests.includes(entry),
        );
        for (const scriptManifest of scriptManifests) {
          const scriptDirectory = scriptManifest.directory;
          const composerScripts = record(scriptManifest.manifest.scripts);
          const flattenScript = (value: unknown, seen: Set<string>): Array<string> => {
            if (Array.isArray(value)) return value.flatMap((item) => flattenScript(item, seen));
            if (typeof value !== "string") return [];
            const alias = /^@([\w:.-]+)$/.exec(value.trim());
            if (alias && tool === "mago") {
              const name = alias[1]!;
              if (seen.has(name)) return [];
              return flattenScript(composerScripts[name], new Set([...seen, name]));
            }
            return [value];
          };
          for (const [name, value] of Object.entries(composerScripts)) {
            for (const command of flattenScript(value, new Set([name]))) {
              const tokens = tokenize(command);
              const reference = /create-container-reference\.php/.test(command);
              if (reference) {
                const script: AnalyzerScript = { name, operation: "references", command };
                scripts.push(script);
                scriptDirectories.set(script, scriptDirectory);
                continue;
              }
              if (!tokens) {
                if (/\bmago\b|\bbiome\b/.test(command))
                  warnings.push({ path: manifestPath, reason: "unsupported_script" });
                continue;
              }
              const toolIndex = tokens.findIndex(
                (token) => path.basename(token) === tool || token === `@${tool}`,
              );
              if (toolIndex < 0) continue;
              const operation = tokens
                .slice(toolIndex + 1)
                .find((token) =>
                  ["format", "fmt", "analyze", "guard", "lint", "check", "ci"].includes(token),
                );
              if (!operation) continue;
              const normalized =
                operation === "fmt" ? "format" : operation === "ci" ? "check" : operation;
              const configFlag = tool === "mago" ? "--config" : "--config-path";
              const flagIndex = tokens.findIndex(
                (token) => token === configFlag || token.startsWith(`${configFlag}=`),
              );
              const rawConfig =
                flagIndex < 0
                  ? undefined
                  : tokens[flagIndex]!.includes("=")
                    ? tokens[flagIndex]!.slice(configFlag.length + 1)
                    : tokens[flagIndex + 1];
              const resolvedConfig = rawConfig
                ? resolveInside(scriptDirectory, rawConfig)
                : undefined;
              if (rawConfig && !resolvedConfig)
                warnings.push({ path: manifestPath, reason: "unsafe_path" });
              let configPath =
                resolvedConfig && (yield* safeExisting(resolvedConfig))
                  ? relative(resolvedConfig)
                  : undefined;
              if (!configPath && resolvedConfig && tool === "biome") {
                for (const filename of ["biome.json", "biome.jsonc"]) {
                  const candidate = path.join(resolvedConfig, filename);
                  if (yield* safeExisting(candidate)) {
                    configPath = relative(candidate);
                    break;
                  }
                }
              }
              scripts.push({
                name,
                operation: normalized as AnalyzerScript["operation"],
                command,
                ...(configPath ? { configPath } : {}),
              });
            }
          }
        }
        let configPath = scripts.find((script) => script.configPath)?.configPath;
        if (!configPath) {
          const names =
            tool === "mago"
              ? [
                  "mago.toml",
                  "mago.yaml",
                  "mago.yml",
                  "mago.json",
                  "mago.dist.toml",
                  "mago.dist.yaml",
                  "mago.dist.yml",
                  "mago.dist.json",
                ]
              : ["biome.json", "biome.jsonc"];
          for (const configDirectory of new Set([areaRoot, directory])) {
            for (const name of names) {
              const target = path.join(configDirectory, name);
              if (yield* safeExisting(target)) {
                configPath = relative(target);
                break;
              }
            }
            if (configPath) break;
          }
        }
        const composerConfig = record(manifest.config);
        const vendorDirectory = composerConfig["vendor-dir"];
        const binDirectory = composerConfig["bin-dir"];
        let binary =
          tool === "mago"
            ? resolveInside(
                directory,
                path.join(
                  typeof binDirectory === "string"
                    ? binDirectory
                    : path.join(
                        typeof vendorDirectory === "string" ? vendorDirectory : "vendor",
                        "bin",
                      ),
                  "mago",
                ),
              )
            : path.join(directory, "node_modules", ".bin", "biome");
        if (!binary) {
          warnings.push({ path: manifestPath, reason: "unsafe_path" });
          continue;
        }
        if (tool === "biome" && !(yield* safeExisting(binary, true))) {
          let ancestor = path.dirname(directory);
          while (withinRoot(ancestor)) {
            const candidate = path.join(ancestor, "node_modules/.bin/biome");
            if (yield* safeExisting(candidate, true)) {
              binary = candidate;
              break;
            }
            if (ancestor === root) break;
            ancestor = path.dirname(ancestor);
          }
        }
        const symfonyWiring = wiringManifests.length > 0;
        let symfonyWiringReference: DiscoveredAnalyzer["symfonyWiringReference"];
        for (const wiringManifest of wiringManifests.toSorted(
          (a, b) => Number(b.directory === directory) - Number(a.directory === directory),
        )) {
          const wiringVendor = record(wiringManifest.manifest.config)["vendor-dir"];
          const generator = resolveInside(
            wiringManifest.directory,
            path.join(
              typeof wiringVendor === "string" ? wiringVendor : "vendor",
              "byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
            ),
          );
          const rootComposer = manifests.find((entry) => entry.directory === areaRoot)?.manifest;
          const appVendor = record(rootComposer?.config)["vendor-dir"];
          const autoload = resolveInside(
            areaRoot,
            path.join(typeof appVendor === "string" ? appVendor : "vendor", "autoload.php"),
          );
          const referenceScript = scripts.find((script) => script.operation === "references");
          const output = referenceScript
            ? />\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|]+))\s*$/.exec(referenceScript.command)
            : undefined;
          const outputPath = output ? (output[1] ?? output[2] ?? output[3]) : undefined;
          const reference = outputPath
            ? resolveInside(scriptDirectories.get(referenceScript!) ?? directory, outputPath)
            : path.join(areaRoot, ".mago/container-reference.dev.json");
          if (generator && autoload && reference) {
            const candidate: NonNullable<DiscoveredAnalyzer["symfonyWiringReference"]> = {
              generatorPath: relative(generator),
              generatorAvailable: yield* safeExisting(generator),
              referencePath: relative(reference),
              referenceAvailable: yield* safeExisting(reference),
              autoloadPath: relative(autoload),
              autoloadAvailable: yield* safeExisting(autoload),
            };
            if (!symfonyWiringReference || candidate.generatorAvailable)
              symfonyWiringReference = candidate;
            if (candidate.generatorAvailable) break;
          } else warnings.push({ path: manifestPath, reason: "unsafe_path" });
        }
        const discoverExtension = Effect.fnUntraced(function* (
          packageName: string,
          entryFile: string,
        ) {
          const candidates = manifests.filter(
            (entry) => packageName in dependencies(entry.manifest),
          );
          let selected: { readonly autoloadPath: string; readonly available: boolean } | undefined;
          for (const candidate of candidates.toSorted(
            (a, b) => Number(b.directory === directory) - Number(a.directory === directory),
          )) {
            const vendor = record(candidate.manifest.config)["vendor-dir"];
            const vendorPath = typeof vendor === "string" ? vendor : "vendor";
            const autoload = resolveInside(
              candidate.directory,
              path.join(vendorPath, "autoload.php"),
            );
            const entry = resolveInside(
              candidate.directory,
              path.join(vendorPath, packageName, entryFile),
            );
            if (!autoload || !entry) {
              warnings.push({
                path: relative(path.join(candidate.directory, candidate.filename)),
                reason: "unsafe_path",
              });
              continue;
            }
            const value = {
              autoloadPath: relative(autoload),
              available: (yield* safeExisting(autoload)) && (yield* safeExisting(entry)),
            };
            if (!selected || value.available) selected = value;
            if (value.available) break;
          }
          return selected;
        });
        const doctrineQueryBudget =
          tool === "mago"
            ? yield* discoverExtension(
                "byte-kitsune/mago-doctrine-query-budget",
                "src/QueryBudgetExtension.php",
              )
            : undefined;
        const architectureGraph =
          tool === "mago"
            ? yield* discoverExtension(
                "byte-kitsune/mago-architecture-graph",
                "src/ArchitectureGraphExtension.php",
              )
            : undefined;
        tools.push({
          tool,
          manifestPath,
          workingDirectory: relative(areaRoot),
          binaryPath: relative(binary),
          available: yield* safeExisting(binary, true),
          ...(configPath ? { configPath } : {}),
          scripts,
          symfonyWiring,
          ...(doctrineQueryBudget ? { doctrineQueryBudget } : {}),
          ...(architectureGraph ? { architectureGraph } : {}),
          ...(symfonyWiringReference ? { symfonyWiringReference } : {}),
        });
        if (tool === "biome") break;
      }
      results.push({ areaId: area.id, tools, warnings });
    }
    return results;
  });
  return AnalyzerDiscoveryService.of({ discover });
});

export const layer = Layer.effect(AnalyzerDiscoveryService, make);
