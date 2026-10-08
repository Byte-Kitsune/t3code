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
    readonly checkFile: (
      input: MonolithCheckFileInput,
    ) => Effect.Effect<MonolithCheckFileResult, MonolithAnalyzerError>;
  }
>()("t3/project/MonolithAnalyzerService") {}

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
  // Opening several files must not fan out unbounded project-wide PHP checks.
  const checks = yield* Semaphore.make(2);
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
    if (area !== null && area.kind !== "folder") {
      const tool = area.kind === "php" ? "mago" : "biome";
      const applicable =
        tool === "mago"
          ? /\.php$/i.test(input.path)
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
        const installation =
          (!runtime
            ? installations[0]?.tools.find((candidate) => candidate.available)
            : undefined) ?? installations[0]?.tools[0];
        const operations =
          tool === "mago" ? (["format", "analyze", "guard"] as const) : (["check"] as const);
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
          const result = yield* execution
            .run({
              tool,
              operation,
              command: path.resolve(root, installation.binaryPath),
              cwd: path.resolve(root, installation.workingDirectory),
              workspaceRoot: root,
              filePath: file,
              sourceText: contents,
              ...(runtime ? { runtime, areaPath: area.path } : {}),
              ...(configPath === undefined ? {} : { configPath: path.resolve(root, configPath) }),
            })
            .pipe(Effect.result);
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
          const reference = insightTools.find(
            (candidate) =>
              candidate.symfonyWiringReference &&
              (runtime || candidate.symfonyWiringReference.referenceAvailable),
          )?.symfonyWiringReference;
          if (
            !installation ||
            (!installation.available && !runtime) ||
            (!doctrine && !architecture)
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
            const autoloadPaths = [
              ...new Set(
                [
                  doctrine?.autoloadPath,
                  architecture?.autoloadPath,
                  reference && (runtime || reference.autoloadAvailable)
                    ? reference.autoloadPath
                    : undefined,
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
                autoloadPaths,
                ...(runtime ? { runtime } : {}),
                ...(configPath ? { configPath: path.resolve(root, configPath) } : {}),
                ...(reference && (runtime || reference.referenceAvailable)
                  ? { referencePath: path.resolve(root, reference.referencePath) }
                  : {}),
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
        }
      }
    }
    if ((yield* revision(yield* readFile)) !== fingerprint) {
      return {
        areaId: area?.id ?? null,
        revision: fingerprint,
        diagnostics: [],
        runs: runs.map((run) => ({
          ...run,
          status: "failed" as const,
          diagnosticCount: 0,
          message:
            "The file changed while checks were running. Reopen or save it to check the latest version.",
        })),
      };
    }
    return { areaId: area?.id ?? null, revision: fingerprint, diagnostics, runs, ...insights };
  });
  return MonolithAnalyzerService.of({
    discover,
    checkFile: (input) => checks.withPermits(1)(checkFile(input)),
  });
});
export const layer = Layer.effect(MonolithAnalyzerService, make);
