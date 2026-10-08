import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import {
  type MonolithAnalyzersResult,
  type MonolithAnalyzerDiagnostic,
  type MonolithAnalyzerRun,
  type MonolithCheckFileInput,
  type MonolithCheckFileResult,
} from "@t3tools/contracts";
import { matchMonolithArea } from "@t3tools/shared/monolithAreas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as AnalyzerExecution from "../analyzers/AnalyzerExecution.ts";
import * as PhpInsightsExecution from "../analyzers/PhpInsightsExecution.ts";
import * as AnalyzerDiscoveryService from "./AnalyzerDiscoveryService.ts";
import * as MonolithService from "./MonolithService.ts";

export class MonolithAnalyzerError extends Schema.TaggedError<MonolithAnalyzerError>()(
  "MonolithAnalyzerError",
  {
    operation: Schema.Literals(["discover", "check"]),
    reason: Schema.Literals(["configuration", "discovery", "file", "unsafe_path", "file_limit"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "unsafe_path"
      ? "Analyzer files must stay inside the workspace and cannot use symbolic links."
      : this.reason === "file_limit"
        ? "The file is too large for automatic analyzer checks."
        : `Could not ${this.operation} monolith analyzers (${this.reason}).`;
  }
}

export class MonolithAnalyzerService extends Context.Service<
  MonolithAnalyzerService,
  {
    readonly discover: (input: {
      readonly cwd: string;
    }) => Effect.Effect<MonolithAnalyzersResult, MonolithAnalyzerError>;
    readonly indexArea: (input: {
      readonly cwd: string;
      readonly areaId: string;
      readonly paths: readonly string[];
    }) => Effect.Effect<
      readonly { readonly path: string; readonly result: MonolithCheckFileResult }[],
      MonolithAnalyzerError
    >;
    readonly checkFile: (
      input: MonolithCheckFileInput,
    ) => Effect.Effect<MonolithCheckFileResult, MonolithAnalyzerError>;
  }
>()("t3/project/MonolithAnalyzerService") {}

const isAnalyzerError = Schema.is(MonolithAnalyzerError);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const revision = (contents: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(contents)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) => new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
      ),
    );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const monolith = yield* MonolithService.MonolithService;
  const discovery = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
  const execution = yield* AnalyzerExecution.AnalyzerExecution;
  const phpInsights = yield* PhpInsightsExecution.PhpInsightsExecution;
  // Reserve one lane for opened files so a long background format batch cannot
  // consume all capacity. At most two project-wide checks run concurrently.
  const foregroundChecks = yield* Semaphore.make(1);
  const backgroundChecks = yield* Semaphore.make(1);
  const discover: MonolithAnalyzerService["Service"]["discover"] = Effect.fn(
    "MonolithAnalyzerService.discover",
  )(function* ({ cwd }) {
    const snapshot = yield* monolith
      .get({ cwd, initialize: false })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MonolithAnalyzerError({ operation: "discover", reason: "configuration", cause }),
        ),
      );
    return yield* discovery
      .discover({ cwd, areas: snapshot.config.areas })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MonolithAnalyzerError({ operation: "discover", reason: "discovery", cause }),
        ),
      );
  });
  const checkFile = Effect.fn("MonolithAnalyzerService.checkFile")(function* (
    input: MonolithCheckFileInput,
    indexPaths?: readonly string[],
  ) {
    const root = yield* fs
      .realPath(path.resolve(input.cwd))
      .pipe(
        Effect.mapError(
          (cause) => new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
        ),
      );
    const file = path.resolve(root, input.path);
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new MonolithAnalyzerError({ operation: "check", reason: "unsafe_path" });
    }
    const actual = yield* fs
      .realPath(file)
      .pipe(
        Effect.mapError(
          (cause) => new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
        ),
      );
    if (actual !== file)
      return yield* new MonolithAnalyzerError({ operation: "check", reason: "unsafe_path" });
    const info = yield* fs
      .stat(file)
      .pipe(
        Effect.mapError(
          (cause) => new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
        ),
      );
    if (info.type !== "File")
      return yield* new MonolithAnalyzerError({ operation: "check", reason: "file" });
    if (info.size > 2 * 1024 * 1024)
      return yield* new MonolithAnalyzerError({ operation: "check", reason: "file_limit" });
    const readFile = fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          (cause) => new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
        ),
      );
    const contents = yield* readFile;
    const fingerprint = yield* revision(contents);
    const snapshot = yield* monolith
      .get({ cwd: root, initialize: false })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MonolithAnalyzerError({ operation: "check", reason: "configuration", cause }),
        ),
      );
    const area = matchMonolithArea({ path: input.path }, snapshot.config.areas);
    const diagnostics: MonolithAnalyzerDiagnostic[] = [];
    const runs: MonolithAnalyzerRun[] = [];
    let insights: PhpInsightsExecution.PhpInsightsResult | undefined;
    const configuredArea = snapshot.config.areas.find((candidate) => candidate.id === area?.id);
    const indexedSources = new Map<string, { contents: string; revision: string; file: string }>();
    if (indexPaths !== undefined) {
      if (
        indexPaths.length > 2000 ||
        new Set(indexPaths).size !== indexPaths.length ||
        area === null ||
        area.kind === "folder"
      )
        return yield* new MonolithAnalyzerError({ operation: "check", reason: "file_limit" });
      let sourceBytes = 0;
      for (const sourcePath of indexPaths) {
        const sourceFile = path.resolve(root, sourcePath);
        if (
          matchMonolithArea({ path: sourcePath }, snapshot.config.areas)?.id !== area.id ||
          path.relative(root, sourceFile).split(path.sep).join("/") !== sourcePath ||
          (yield* fs.realPath(sourceFile)) !== sourceFile
        )
          return yield* new MonolithAnalyzerError({ operation: "check", reason: "unsafe_path" });
        const sourceInfo = yield* fs.stat(sourceFile);
        if (sourceInfo.type !== "File" || sourceInfo.size > 2 * 1024 * 1024)
          return yield* new MonolithAnalyzerError({ operation: "check", reason: "file_limit" });
        const sourceContents = yield* fs.readFileString(sourceFile);
        sourceBytes += sourceContents.length;
        if (sourceBytes > 32 * 1024 * 1024)
          return yield* new MonolithAnalyzerError({ operation: "check", reason: "file_limit" });
        indexedSources.set(sourcePath, {
          file: sourceFile,
          contents: sourceContents,
          revision: yield* revision(sourceContents),
        });
      }
    }
    if (area !== null && area.kind !== "folder") {
      const tool = area.kind === "php" ? "mago" : "biome";
      const applicable =
        tool === "mago"
          ? /\.(?:php|ya?ml)$/i.test(input.path)
          : /\.(?:[cm]?[jt]sx?|jsonc?|css)$/i.test(input.path);
      if (applicable) {
        const installations = yield* discovery
          .discover({ cwd: root, areas: [area] })
          .pipe(
            Effect.mapError(
              (cause) =>
                new MonolithAnalyzerError({ operation: "check", reason: "discovery", cause }),
            ),
          );
        const runtime = tool === "mago" ? configuredArea?.magoDocker : undefined;
        const toolInstallations =
          installations[0]?.tools.filter((candidate) => candidate.tool === tool) ?? [];
        const installation =
          (!runtime ? toolInstallations.find((candidate) => candidate.available) : undefined) ??
          toolInstallations[0];
        const phpSources = [...indexedSources.values()].filter((source) =>
          /\.php$/i.test(source.file),
        );
        const operations =
          tool === "mago"
            ? /\.php$/i.test(file) || phpSources.length > 0
              ? (["format", "analyze", "guard"] as const)
              : []
            : !installation && (installations[0]?.tools.length ?? 0) > 0
              ? []
              : (["check"] as const);
        for (const operation of operations) {
          if (!installation || (!installation.available && !runtime)) {
            runs.push({
              tool,
              operation,
              status: "unavailable",
              diagnosticCount: 0,
              message: `No installed local ${tool} binary was found for this area.`,
            });
            continue;
          }
          const configPath =
            installation.scripts.find(
              (script) => script.operation === operation && script.configPath !== undefined,
            )?.configPath ?? installation.configPath;
          const execute = (
            sourceFile = tool === "mago" && !/\.php$/i.test(file) ? phpSources[0]!.file : file,
            sourceContents = tool === "mago" && !/\.php$/i.test(file)
              ? phpSources[0]!.contents
              : contents,
            batch = indexPaths !== undefined,
            formatPaths?: readonly string[],
          ) =>
            execution
              .run({
                tool,
                operation,
                command: path.resolve(root, installation.binaryPath),
                cwd: path.resolve(root, installation.workingDirectory),
                workspaceRoot: root,
                filePath: sourceFile,
                sourceText: sourceContents,
                ...(batch
                  ? {
                      filePaths:
                        formatPaths ??
                        (tool === "mago" ? phpSources : [...indexedSources.values()]).map(
                          (source) => source.file,
                        ),
                      sourceTexts: Object.fromEntries(
                        [...indexedSources]
                          .filter(([, source]) => tool !== "mago" || /\.php$/i.test(source.file))
                          .map(([sourcePath, source]) => [sourcePath, source.contents]),
                      ),
                    }
                  : {}),
                ...(runtime ? { runtime, areaPath: area.path } : {}),
                ...(configPath === undefined ? {} : { configPath: path.resolve(root, configPath) }),
              })
              .pipe(Effect.result);
          // Avoid thousands of Mago/Docker startups, while keeping argv below
          // macOS limits and individual formatter reports below output bounds.
          const formatChunks: string[][] = [];
          if (indexPaths !== undefined && operation === "format") {
            let chunk: string[] = [];
            let bytes = 0;
            for (const source of phpSources) {
              const nextBytes = Buffer.byteLength(source.file, "utf8") + 1;
              if (chunk.length && (chunk.length >= 128 || bytes + nextBytes > 32_768)) {
                formatChunks.push(chunk);
                chunk = [];
                bytes = 0;
              }
              chunk.push(source.file);
              bytes += nextBytes;
            }
            if (chunk.length) formatChunks.push(chunk);
          }
          const results = formatChunks.length
            ? yield* Effect.forEach(
                formatChunks,
                (files) =>
                  execute(
                    files[0]!,
                    indexedSources.get(path.relative(root, files[0]!).split(path.sep).join("/"))
                      ?.contents ?? contents,
                    true,
                    files,
                  ),
                { concurrency: 2 },
              )
            : [yield* execute()];
          const failed = results.find((result) => result._tag === "Failure");
          const result = failed ?? {
            _tag: "Success" as const,
            success: {
              diagnostics: results.flatMap((result) =>
                result._tag === "Success" ? result.success.diagnostics : [],
              ),
              status: results.some(
                (result) => result._tag === "Success" && result.success.status === "findings",
              )
                ? ("findings" as const)
                : ("passed" as const),
            },
          };
          if (result._tag === "Failure") {
            runs.push({
              tool,
              operation,
              status: "failed",
              diagnosticCount: 0,
              message: result.failure.message,
            });
          } else {
            diagnostics.push(...result.success.diagnostics);
            runs.push({
              tool,
              operation,
              status: result.success.status,
              diagnosticCount: result.success.diagnostics.length,
            });
          }
        }
        if (tool === "mago") {
          const insightTools = installations[0]?.tools ?? [];
          const doctrine = insightTools.find(
            (candidate) =>
              candidate.doctrineQueryBudget && (runtime || candidate.doctrineQueryBudget.available),
          )?.doctrineQueryBudget;
          const architecture = insightTools.find(
            (candidate) =>
              candidate.architectureGraph && (runtime || candidate.architectureGraph.available),
          )?.architectureGraph;
          const symfony = insightTools.find(
            (candidate) =>
              candidate.symfonyWiringReference &&
              (runtime ||
                candidate.symfonyWiringReference.autoloadAvailable ||
                candidate.symfonyWiringReference.generatorAvailable),
          )?.symfonyWiringReference;
          const reference = insightTools.find(
            (candidate) =>
              candidate.symfonyWiringReference &&
              (runtime || candidate.symfonyWiringReference.referenceAvailable),
          )?.symfonyWiringReference;
          if (
            !installation ||
            (!installation.available && !runtime) ||
            (!doctrine && !architecture && !symfony)
          ) {
            insights = {
              queryBudget: {
                status: "unavailable",
                message: "Install Mago and the Doctrine query-budget extension in this area.",
                methods: [],
              },
              entryChains: {
                status: "unavailable",
                message: "Install Mago and the architecture graph extension in this area.",
                targets: [],
              },
            };
          } else {
            const symfonyToolsAutoload = symfony
              ? path.resolve(root, path.dirname(symfony.generatorPath), "../../../autoload.php")
              : undefined;
            const autoloadPaths = [
              ...new Set(
                [
                  symfonyToolsAutoload && (runtime || (yield* fs.exists(symfonyToolsAutoload)))
                    ? path.relative(root, symfonyToolsAutoload)
                    : undefined,
                  doctrine?.autoloadPath,
                  architecture?.autoloadPath,
                  symfony?.autoloadAvailable ? symfony.autoloadPath : undefined,
                ].filter((value): value is string => value !== undefined),
              ),
            ].map((file) => path.resolve(root, file));
            const configPath =
              installation.scripts.find(
                (script) => script.operation === "analyze" && script.configPath !== undefined,
              )?.configPath ?? installation.configPath;
            const analyzed = yield* phpInsights
              .run({
                command: path.resolve(root, installation.binaryPath),
                cwd: path.resolve(root, installation.workingDirectory),
                workspaceRoot: root,
                areaPath: area.path,
                filePath: file,
                relativePath: input.path,
                ...(indexPaths === undefined ? {} : { indexPaths }),
                autoloadPaths,
                ...(runtime ? { runtime } : {}),
                ...(configPath ? { configPath: path.resolve(root, configPath) } : {}),
                ...(reference && (runtime || reference.referenceAvailable)
                  ? { referencePath: path.resolve(root, reference.referencePath) }
                  : {}),
                ...(configuredArea?.commentMarkers === undefined
                  ? {}
                  : { commentMarkers: configuredArea.commentMarkers }),
                ...(snapshot.config.areas.find((candidate) => candidate.id === area.id)
                  ?.entrypointPaths
                  ? {
                      entrypointPaths: snapshot.config.areas.find(
                        (candidate) => candidate.id === area.id,
                      )!.entrypointPaths!,
                    }
                  : {}),
              })
              .pipe(Effect.result);
            insights =
              analyzed._tag === "Success"
                ? analyzed.success
                : {
                    ...(symfony
                      ? {
                          security: {
                            diagnostics: [],
                            run: {
                              tool: "mago",
                              operation: "check",
                              status: "failed",
                              diagnosticCount: 0,
                              message:
                                "Symfony configuration security could not inspect this source snapshot.",
                            },
                          },
                        }
                      : {}),
                    queryBudget: {
                      status: "failed",
                      message: analyzed.failure.message,
                      methods: [],
                    },
                    entryChains: {
                      status: "failed",
                      message: analyzed.failure.message,
                      targets: [],
                    },
                  };
          }
          if (insights?.security) {
            diagnostics.push(...insights.security.diagnostics);
            if (insights.security.run) runs.push(insights.security.run);
          }
        }
      }
    }
    const jsSources = [...indexedSources.values()].filter((source) =>
      /\.(?:[cm]?[jt]sx?)$/i.test(source.file),
    );
    if (
      area?.kind === "react" &&
      (/\.(?:[cm]?[jt]sx?)$/i.test(input.path) || jsSources.length > 0)
    ) {
      const installations = yield* discovery
        .discover({ cwd: root, areas: [area] })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MonolithAnalyzerError({ operation: "check", reason: "discovery", cause }),
          ),
        );
      for (const tool of ["eslint", "depcruise"] as const) {
        const candidates =
          installations[0]?.tools.filter((candidate) => candidate.tool === tool) ?? [];
        const installation = candidates.find((candidate) => candidate.available) ?? candidates[0];
        if (!installation) continue;
        if (!installation.available) {
          runs.push({
            tool,
            operation: "check",
            status: "unavailable",
            diagnosticCount: 0,
            message: `No installed local ${tool} binary was found for this area.`,
          });
          continue;
        }
        const script = installation.scripts.find((script) => script.operation === "check");
        const configPath = script?.configPath ?? installation.configPath;
        const openedJs = /\.(?:[cm]?[jt]sx?)$/i.test(input.path);
        const checked = yield* execution
          .run({
            tool,
            operation: "check",
            command: path.resolve(root, installation.binaryPath),
            cwd: path.resolve(root, installation.workingDirectory),
            workspaceRoot: root,
            filePath: openedJs ? file : jsSources[0]!.file,
            sourceText: openedJs ? contents : jsSources[0]!.contents,
            ...(indexPaths === undefined
              ? {}
              : { filePaths: jsSources.map((source) => source.file) }),
            ...(configPath === undefined ? {} : { configPath: path.resolve(root, configPath) }),
            ...(tool === "depcruise"
              ? {
                  sourcePaths: (script?.sourcePaths?.length ? script.sourcePaths : [area.path]).map(
                    (source) => path.resolve(root, source),
                  ),
                }
              : {}),
          })
          .pipe(Effect.result);
        if (checked._tag === "Failure")
          runs.push({
            tool,
            operation: "check",
            status: "failed",
            diagnosticCount: 0,
            message: checked.failure.message,
          });
        else {
          diagnostics.push(...checked.success.diagnostics);
          runs.push({
            tool,
            operation: "check",
            status: checked.success.status,
            diagnosticCount: checked.success.diagnostics.length,
          });
        }
      }
    }
    let indexedSourceChanged = false;
    for (const source of indexedSources.values())
      if ((yield* revision(yield* fs.readFileString(source.file))) !== source.revision)
        indexedSourceChanged = true;
    if (indexedSourceChanged || (yield* revision(yield* readFile)) !== fingerprint) {
      return {
        areaId: area?.id ?? null,
        revision: fingerprint,
        diagnostics: [],
        ...(indexPaths === undefined
          ? {}
          : {
              indexedFiles: [...indexedSources].map(([sourcePath, source]) => ({
                path: sourcePath,
                result: {
                  areaId: area?.id ?? null,
                  revision: source.revision,
                  diagnostics: [],
                  runs: [],
                  queryBudget: {
                    status: "failed" as const,
                    methods: [],
                    message: "The source changed during indexing.",
                  },
                  entryChains: {
                    status: "failed" as const,
                    targets: [],
                    message: "The source changed during indexing.",
                  },
                },
              })),
            }),
        runs: runs.map((run) => ({
          ...run,
          status: "failed" as const,
          diagnosticCount: 0,
          message:
            "The file changed while checks were running. Reopen or save it to check the latest version.",
        })),
      };
    }
    const thresholdFields =
      configuredArea?.kind !== "php"
        ? {}
        : configuredArea.doctrineQueryThresholds !== undefined
          ? {
              doctrineQueryThresholds: configuredArea.doctrineQueryThresholds,
              doctrineQueryThresholdsSource: { kind: "override" as const },
            }
          : {
              ...(insights?.doctrineQueryThresholds === undefined
                ? {}
                : { doctrineQueryThresholds: insights.doctrineQueryThresholds }),
              doctrineQueryThresholdsSource: insights?.doctrineQueryThresholdsSource ?? {
                kind: "unresolved" as const,
                message:
                  "Query threshold configuration could not be inspected because PHP tooling is unavailable.",
              },
            };
    return {
      areaId: area?.id ?? null,
      revision: fingerprint,
      diagnostics,
      runs,
      ...(insights === undefined
        ? {}
        : /\.php$/i.test(input.path)
          ? { queryBudget: insights.queryBudget, entryChains: insights.entryChains }
          : {}),
      ...(indexPaths === undefined
        ? {}
        : {
            indexedFiles: [...indexedSources].map(([sourcePath, source]) => {
              const indexed = insights?.indexedFiles?.find((item) => item.path === sourcePath);
              const fileDiagnostics = diagnostics.filter((item) => item.path === sourcePath);
              return {
                path: sourcePath,
                result: {
                  areaId: area?.id ?? null,
                  revision: source.revision,
                  diagnostics: fileDiagnostics,
                  runs: runs
                    .filter((run) =>
                      run.tool === "eslint" || run.tool === "depcruise"
                        ? /\.(?:[cm]?[jt]sx?)$/i.test(sourcePath)
                        : /\.php$/i.test(sourcePath) || run.operation === "check",
                    )
                    .map((run) => ({
                      ...run,
                      diagnosticCount: fileDiagnostics.filter(
                        (item) => item.operation === run.operation && item.tool === run.tool,
                      ).length,
                      status:
                        run.status === "findings"
                          ? fileDiagnostics.some(
                              (item) => item.operation === run.operation && item.tool === run.tool,
                            )
                            ? ("findings" as const)
                            : ("passed" as const)
                          : run.status,
                    })),
                  ...(!/\.php$/i.test(sourcePath) && area?.kind === "php"
                    ? {}
                    : indexed
                      ? { queryBudget: indexed.queryBudget, entryChains: indexed.entryChains }
                      : insights
                        ? { queryBudget: insights.queryBudget, entryChains: insights.entryChains }
                        : {}),
                  ...thresholdFields,
                },
              };
            }),
          }),
      ...thresholdFields,
    };
  });
  return MonolithAnalyzerService.of({
    discover,
    indexArea: (input) =>
      backgroundChecks.withPermits(1)(
        Effect.gen(function* () {
          if (input.paths.length === 0) return [];
          const result = yield* checkFile({ cwd: input.cwd, path: input.paths[0]! }, input.paths);
          if (result.areaId !== input.areaId || !("indexedFiles" in result))
            return yield* new MonolithAnalyzerError({ operation: "check", reason: "unsafe_path" });
          return result.indexedFiles!;
        }).pipe(
          Effect.mapError((cause) =>
            isAnalyzerError(cause)
              ? cause
              : new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
          ),
        ),
      ),
    checkFile: (input) =>
      foregroundChecks
        .withPermits(1)(checkFile(input))
        .pipe(
          Effect.mapError((cause) =>
            isAnalyzerError(cause)
              ? cause
              : new MonolithAnalyzerError({ operation: "check", reason: "file", cause }),
          ),
        ),
  });
});
export const layer = Layer.effect(MonolithAnalyzerService, make);
