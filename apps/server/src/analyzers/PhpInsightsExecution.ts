import * as Crypto from "effect/Crypto";
import { parse as parseToml } from "smol-toml";
import type {
  MonolithEntryChains,
  MonolithQueryBudget,
  MonolithMagoDocker,
  MonolithCommentMarker,
  MonolithDoctrineQueryThresholds,
  MonolithDoctrineQueryThresholdsSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as MagoDockerExecution from "./MagoDockerExecution.ts";
import * as ProcessRunner from "../processRunner.ts";
import { analyzerFailureDetails } from "./analyzerFailureDetails.ts";
import { decodePhpQueryInsights, normalizePhpQueryInsights } from "./PhpQueryInsights.ts";
import { preparePhpEntryInsightsReport } from "./PhpEntryInsights.ts";
import { normalizePhpThresholdInsights } from "./PhpThresholdInsights.ts";
import { normalizePhpSecurityInsights, type PhpSecurityInsights } from "./PhpSecurityInsights.ts";
import { PHP_INSIGHTS_WORKER_SOURCE } from "./PhpInsightsWorkerSource.ts";

const isDockerError = Schema.is(MagoDockerExecution.MagoDockerError);

export interface PhpInsightsInput {
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly areaPath: string;
  readonly filePath: string;
  readonly relativePath: string;
  readonly indexPaths?: readonly string[];
  /** Internal background indexing scope; caller validates the full content snapshot before publishing. */
  readonly snapshot?: { readonly key: string; readonly paths: readonly string[] };
  readonly threads?: number;
  readonly configPath?: string;
  readonly autoloadPaths: readonly string[];
  readonly referencePath?: string;
  readonly entrypointPaths?: readonly string[];
  readonly commentMarkers?: readonly MonolithCommentMarker[];
  readonly runtime?: MonolithMagoDocker;
}
export interface PhpInsightsResult {
  readonly security?: PhpSecurityInsights;
  readonly doctrineQueryThresholds?: MonolithDoctrineQueryThresholds;
  readonly doctrineQueryThresholdsSource?: MonolithDoctrineQueryThresholdsSource;
  readonly queryBudget: MonolithQueryBudget;
  readonly entryChains: MonolithEntryChains;
  readonly indexedFiles?: readonly {
    readonly path: string;
    readonly queryBudget: MonolithQueryBudget;
    readonly entryChains: MonolithEntryChains;
  }[];
}
export class PhpInsightsExecutionError extends Schema.TaggedError<PhpInsightsExecutionError>()(
  "PhpInsightsExecutionError",
  {
    stage: Schema.Literals(["input", "config", "workspace", "write", "process", "report"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (isDockerError(this.cause)) return this.cause.message;
    if (this.stage === "workspace")
      return "PHP insights require the Mago workspace to match the PHP area's root. Adjust the area or its Mago workspace to refresh insights.";
    return `PHP file insights could not complete (${this.stage}).${this.detail ? ` ${this.detail}` : ""}`;
  }
}
export class PhpInsightsExecution extends Context.Service<
  PhpInsightsExecution,
  {
    readonly run: (
      input: PhpInsightsInput,
    ) => Effect.Effect<PhpInsightsResult, PhpInsightsExecutionError>;
  }
>()("t3/analyzers/PhpInsightsExecution") {}
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeConfigJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isInsightError = Schema.is(PhpInsightsExecutionError);
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a Mago configuration object.");
  return value as Record<string, unknown>;
};
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const paths = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const dockerService = yield* Effect.serviceOption(MagoDockerExecution.MagoDockerExecution);
  // Indexing can interleave two areas. Keep both prepared reports under a shared
  // byte budget; foreground checks have no validated token and remain independent.
  const cachedSnapshots = new Map<
    string,
    {
      readonly reports: ReadonlyMap<string, string>;
      readonly graph: ReturnType<typeof preparePhpEntryInsightsReport>;
      readonly queries: ReadonlyMap<string, unknown>;
      readonly reportBytes: number;
    }
  >();
  const failedSnapshots = new Map<string, PhpInsightsExecutionError>();
  const run = Effect.fn("PhpInsightsExecution.run")(function* (input: PhpInsightsInput) {
    const areaRoot = paths.resolve(input.workspaceRoot, input.areaPath);
    if (
      input.threads !== undefined &&
      (!Number.isInteger(input.threads) || input.threads < 1 || input.threads > 2)
    )
      return yield* new PhpInsightsExecutionError({ stage: "input" });
    const snapshotPaths = input.snapshot ? new Set(input.snapshot.paths) : undefined;
    if (
      input.snapshot &&
      (input.indexPaths === undefined ||
        input.snapshot.paths.length > 50_000 ||
        input.snapshot.key.length === 0 ||
        input.snapshot.key.length > 1024 ||
        snapshotPaths!.size !== input.snapshot.paths.length ||
        input.indexPaths.some((file) => !snapshotPaths!.has(file)) ||
        input.snapshot.paths.some((file) => {
          const relative = paths.relative(areaRoot, paths.resolve(input.workspaceRoot, file));
          return (
            relative === ".." ||
            relative.startsWith(`..${paths.sep}`) ||
            paths.isAbsolute(relative) ||
            paths
              .relative(input.workspaceRoot, paths.resolve(input.workspaceRoot, file))
              .split(paths.sep)
              .join("/") !== file
          );
        }))
    )
      return yield* new PhpInsightsExecutionError({ stage: "input" });
    const within = (target: string, root = input.workspaceRoot) => {
      const relative = paths.relative(root, target);
      return (
        relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
      );
    };
    if (
      (!input.runtime && !paths.isAbsolute(input.command)) ||
      !paths.isAbsolute(input.cwd) ||
      !paths.isAbsolute(input.workspaceRoot) ||
      !within(areaRoot) ||
      !within(input.filePath, areaRoot) ||
      input.autoloadPaths.length === 0
    )
      return yield* new PhpInsightsExecutionError({ stage: "input" });
    const safe = Effect.fnUntraced(function* (target: string) {
      if (!paths.isAbsolute(target) || !within(target) || (yield* fs.realPath(target)) !== target)
        return yield* new PhpInsightsExecutionError({ stage: "input" });
    });
    yield* Effect.gen(function* () {
      for (const target of [
        ...(input.runtime ? [] : [input.command]),
        input.cwd,
        areaRoot,
        input.filePath,
        ...(input.runtime ? [] : input.autoloadPaths),
        ...(input.configPath ? [input.configPath] : []),
        ...(!input.runtime && input.referencePath ? [input.referencePath] : []),
      ])
        yield* safe(target);
    }).pipe(Effect.mapError((cause) => new PhpInsightsExecutionError({ stage: "input", cause })));
    const docker = input.runtime
      ? yield* Effect.gen(function* () {
          if (Option.isNone(dockerService))
            return yield* new PhpInsightsExecutionError({ stage: "input" });
          return yield* dockerService.value
            .prepare({
              workspaceRoot: input.workspaceRoot,
              areaPath: input.areaPath,
              runtime: input.runtime!,
              binaryPath: input.command,
            })
            .pipe(
              Effect.mapError(
                (cause) => new PhpInsightsExecutionError({ stage: "process", cause }),
              ),
            );
        })
      : undefined;
    const toolPath = (hostPath: string) => docker?.toContainer(hostPath) ?? hostPath;
    yield* Effect.try({
      try: () =>
        [
          areaRoot,
          input.filePath,
          ...input.autoloadPaths,
          ...(input.configPath ? [input.configPath] : []),
          ...(input.referencePath ? [input.referencePath] : []),
        ].forEach(toolPath),
      catch: (cause) => new PhpInsightsExecutionError({ stage: "input", cause }),
    });
    const referencePath =
      input.referencePath && (!docker || (yield* docker.exists(input.referencePath)))
        ? input.referencePath
        : undefined;
    const referenceOnHost = referencePath !== undefined && (yield* fs.exists(referencePath));
    if (referenceOnHost) yield* safe(referencePath!);
    const remoteReferenceStamp = Effect.fnUntraced(function* () {
      if (!docker || !referencePath || referenceOnHost) return null;
      const result = yield* docker.runPhp([
        "-r",
        "echo hash_file('sha256', $argv[1]);",
        toolPath(referencePath),
      ]);
      if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(result.stdout))
        return yield* new PhpInsightsExecutionError({
          stage: "process",
          detail: analyzerFailureDetails(result),
        });
      return result.stdout;
    });
    const initialRemoteReference = yield* remoteReferenceStamp();
    const process = Effect.fnUntraced(function* (args: readonly string[], env?: NodeJS.ProcessEnv) {
      const result = yield* docker
        ? docker.runMago(args, env)
        : runner.run({
            command: input.command,
            args,
            cwd: input.cwd,
            env: env ?? { ...globalThis.process.env, NO_COLOR: "1" },
            timeout: 60_000,
            maxOutputBytes: 4_000_000,
            outputMode: "error",
            timeoutBehavior: "error",
          });
      if (
        result.code === null ||
        result.code > 1 ||
        result.timedOut ||
        result.stdoutTruncated ||
        result.stderrTruncated ||
        result.stdoutInvalidUtf8 ||
        result.stderrInvalidUtf8
      )
        return yield* new PhpInsightsExecutionError({
          stage: "process",
          detail: analyzerFailureDetails(result),
        });
      return result;
    });
    const sourceStamp = Effect.fnUntraced(function* () {
      const pending = [areaRoot];
      const entries: string[] = [];
      let visited = 0;
      while (pending.length) {
        const directory = pending.pop()!;
        for (const name of yield* fs.readDirectory(directory)) {
          if (++visited > 100_000)
            return yield* new PhpInsightsExecutionError({
              stage: "input",
              cause: "PHP source snapshot exceeds the 100,000 entry inspection limit.",
            });
          if (["vendor", "node_modules", ".git"].includes(name)) continue;
          const target = paths.join(directory, name);
          if (
            sourceExcludes.some(
              (excluded) => target === excluded || target.startsWith(`${excluded}${paths.sep}`),
            )
          )
            continue;
          if ((yield* fs.realPath(target)) !== target) continue;
          const info = yield* fs.stat(target);
          if (info.type === "Directory") pending.push(target);
          else if (info.type === "File" && /\.(?:php|ya?ml)$/i.test(name))
            entries.push(
              `${target}:${info.size}:${Option.getOrNull(info.mtime)?.getTime() ?? "unknown"}`,
            );
        }
      }
      return entries.sort().join("\n");
    });
    const configurationBefore = input.configPath
      ? yield* fs
          .readFileString(input.configPath)
          .pipe(
            Effect.mapError((cause) => new PhpInsightsExecutionError({ stage: "config", cause })),
          )
      : null;
    const originalConfiguration = yield* Effect.try({
      try: () => {
        if (configurationBefore === null) return { hosts: {}, securityDisabled: false };
        if (Buffer.byteLength(configurationBefore, "utf8") > 1048576)
          throw new Error("Mago configuration exceeds inspection bounds.");
        const configured = input.configPath?.toLowerCase().endsWith(".json")
          ? decodeConfigJson(configurationBefore)
          : parseToml(configurationBefore);
        const hosts = object(configured)["extension-hosts"] ?? {};
        const parsed = object(hosts);
        if (Object.keys(parsed).length > 32) throw new Error("Too many extension hosts.");
        const config = object(configured);
        const rule = object(
          object(object(config.linter ?? {}).rules ?? {})[
            "byte-kitsune/symfony-wiring/no-hardcoded-secret"
          ] ?? {},
        );
        return { hosts: parsed, securityDisabled: rule.enabled === false };
      },
      catch: (cause) => new PhpInsightsExecutionError({ stage: "config", cause }),
    });
    const effective = yield* process([
      ...(input.configPath ? ["--config", toolPath(input.configPath)] : []),
      "config",
      "--no-extensions",
    ]).pipe(
      Effect.flatMap((result) => decodeJson(result.stdout)),
      Effect.flatMap((value) => Effect.try(() => object(value))),
      Effect.mapError(
        (cause) =>
          new PhpInsightsExecutionError({
            stage: "config",
            detail: isInsightError(cause)
              ? `Mago config --no-extensions failed. ${cause.detail ?? "Check the selected configuration in the configured runtime."}`
              : "Mago config --no-extensions did not return a usable JSON configuration.",
            cause,
          }),
      ),
    );
    const sourceConfig = yield* Effect.try(() => object(effective.source)).pipe(
      Effect.mapError((cause) => new PhpInsightsExecutionError({ stage: "config", cause })),
    );
    // SDK paths are relative to Mago's workspace. Never silently reinterpret a
    // configured workspace as area-relative source or navigate to the wrong file.
    const configuredWorkspace =
      typeof sourceConfig.workspace === "string"
        ? sourceConfig.workspace
        : (docker?.containerAreaRoot ?? input.cwd);
    const effectiveWorkspace = yield* Effect.try({
      try: () =>
        docker ? docker.toHost(configuredWorkspace) : paths.resolve(input.cwd, configuredWorkspace),
      catch: (cause) => new PhpInsightsExecutionError({ stage: "workspace", cause }),
    });
    if (effectiveWorkspace !== areaRoot)
      return yield* new PhpInsightsExecutionError({ stage: "workspace" });
    const sourceExcludes = Array.isArray(sourceConfig.excludes)
      ? sourceConfig.excludes
          .filter((value): value is string => typeof value === "string" && !/[?*{}[\]]/.test(value))
          .flatMap((value) => {
            if (docker && value.startsWith("/")) {
              try {
                return [docker.toHost(value)];
              } catch {
                return [];
              }
            }
            return [paths.resolve(areaRoot, value)];
          })
      : [];
    const initialSource = yield* sourceStamp().pipe(
      Effect.mapError((cause) => new PhpInsightsExecutionError({ stage: "input", cause })),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const dockerTemp = docker ? yield* docker.allocateTemp : undefined;
        const temp =
          dockerTemp?.path ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-php-insights-" }));
        const tempPath = (name: string) =>
          dockerTemp ? `${temp}/${name}` : paths.join(temp, name);
        const queryOutput = tempPath("queries.json");
        const graphOutput = tempPath("graph.json");
        const thresholdOutput = tempPath("thresholds.json");
        const securityOutput = tempPath("security.json");
        const configPath = tempPath("mago.json");
        const worker = tempPath("worker.php");
        const inputPath = tempPath("input.json");
        const policyPath = paths.join(areaRoot, ".mago", "architecture-policy.json");
        const hasPolicy = yield* fs.exists(policyPath);
        if (hasPolicy) yield* safe(policyPath);
        const thresholdCandidates = [paths.join(areaRoot, ".mago", "extension.php")];
        const originalHosts = originalConfiguration.hosts;
        const securityCandidates: string[] = [];
        if (
          originalHosts !== null &&
          typeof originalHosts === "object" &&
          !Array.isArray(originalHosts)
        ) {
          for (const host of Object.values(originalHosts)) {
            if (
              host === null ||
              typeof host !== "object" ||
              !("command" in host) ||
              !Array.isArray(host.command)
            )
              continue;
            for (const argument of host.command) {
              if (typeof argument !== "string" || !argument.endsWith(".php")) continue;
              let candidate: string;
              try {
                candidate =
                  docker && argument.startsWith("/")
                    ? docker.toHost(argument)
                    : paths.resolve(areaRoot, argument);
              } catch {
                break;
              }
              if (within(candidate, areaRoot)) {
                thresholdCandidates.push(candidate);
                securityCandidates.push(candidate);
                if (securityCandidates.length > 16)
                  return yield* new PhpInsightsExecutionError({ stage: "config" });
              }
              // Later PHP arguments are data passed to the worker, not executed entrypoints.
              break;
            }
          }
        }
        thresholdCandidates.push(paths.join(areaRoot, "tools", "mago-worker.php"));
        const thresholdSources = [...new Set(thresholdCandidates)].slice(0, 16);
        const thresholdHostSources: string[] = [];
        for (const candidate of new Set([...thresholdSources, ...securityCandidates]))
          if (yield* fs.exists(candidate)) {
            yield* safe(candidate);
            const info = yield* fs.stat(candidate);
            if (info.type === "File" && info.size <= 1048576) thresholdHostSources.push(candidate);
          }
        const trackedPaths = [
          ...(input.configPath ? [input.configPath] : []),
          ...(referenceOnHost ? [referencePath!] : []),
          ...(hasPolicy ? [policyPath] : []),
          ...thresholdHostSources,
        ];
        const tracked = yield* Effect.forEach(trackedPaths, (file) => fs.readFileString(file));
        // Keep the configuration from before Mago read it, so a concurrent edit
        // during the config command cannot validate an older effective config.
        if (configurationBefore !== null) tracked[0] = configurationBefore;
        const snapshotKey = input.snapshot
          ? yield* crypto
              .digest(
                "SHA-256",
                new TextEncoder().encode(
                  yield* encodeJson({
                    snapshot: input.snapshot,
                    command: input.command,
                    cwd: input.cwd,
                    workspaceRoot: input.workspaceRoot,
                    areaPath: input.areaPath,
                    runtime: input.runtime,
                    autoloadPaths: input.autoloadPaths,
                    referencePath,
                    initialRemoteReference,
                    initialSource,
                    trackedPaths,
                    tracked,
                    effective,
                    entrypointPaths: input.entrypointPaths,
                    commentMarkers: input.commentMarkers,
                  }),
                ),
              )
              .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")))
          : undefined;
        const previousFailure =
          snapshotKey === undefined ? undefined : failedSnapshots.get(snapshotKey);
        if (previousFailure !== undefined) {
          failedSnapshots.delete(snapshotKey!);
          failedSnapshots.set(snapshotKey!, previousFailure);
          return yield* previousFailure;
        }
        const cached = snapshotKey === undefined ? undefined : cachedSnapshots.get(snapshotKey);
        if (cached !== undefined) {
          cachedSnapshots.delete(snapshotKey!);
          cachedSnapshots.set(snapshotKey!, cached);
        }
        const analysisPaths = input.snapshot?.paths ?? input.indexPaths;
        const workerInput = {
          filePath: toolPath(input.filePath),
          relativePath: input.relativePath,
          areaRelativePath: paths.relative(areaRoot, input.filePath).split(paths.sep).join("/"),
          projectRoot: toolPath(areaRoot),
          cwd: toolPath(areaRoot),
          referencePath: referencePath ? toolPath(referencePath) : null,
          autoloadPaths: input.autoloadPaths.map(toolPath),
          queryOutput,
          graphOutput,
          thresholdOutput,
          securityOutput,
          securityDisabled: originalConfiguration.securityDisabled,
          securityCanonical: toolPath(paths.join(areaRoot, ".mago", "extension.php")),
          securityOnly:
            cached !== undefined ||
            !(analysisPaths ?? [input.relativePath]).some((file) => /\.php$/i.test(file)),
          securitySources: [...new Set(securityCandidates)].map((filePath) => ({
            filePath: toolPath(filePath),
          })),
          securityPaths: (input.indexPaths ?? [input.relativePath]).map((file) => ({
            areaRelativePath: paths
              .relative(areaRoot, paths.resolve(input.workspaceRoot, file))
              .split(paths.sep)
              .join("/"),
          })),
          thresholdSources: thresholdSources.map((filePath) => ({
            filePath: toolPath(filePath),
            relativePath: paths.relative(input.workspaceRoot, filePath).split(paths.sep).join("/"),
          })),
          architecturePolicyPath: hasPolicy ? toolPath(policyPath) : null,
          entrypointPaths: input.entrypointPaths ?? ["src/Controller", "src/Command"],
          commentMarkers: input.commentMarkers ?? null,
          indexPaths:
            (cached ? [] : analysisPaths)
              ?.filter((file) => /\.php$/i.test(file))
              .map((file) => ({
                relativePath: file,
                areaRelativePath: paths
                  .relative(areaRoot, paths.resolve(input.workspaceRoot, file))
                  .split(paths.sep)
                  .join("/"),
              })) ?? (/\.php$/i.test(input.filePath) ? null : []),
        };
        // Keep the effective project snapshot and replace workers only for this
        // read-only run. Existing commands may mutate state or hide entire graphs.
        const config = {
          ...effective,
          threads: Math.min(
            input.threads ?? 2,
            typeof effective.threads === "number" && effective.threads > 0 ? effective.threads : 2,
          ),
          "extension-hosts": {
            "t3-insights": { command: ["php", "-d", "memory_limit=1G", worker], workers: 1 },
          },
          analyzer: {
            ...object(effective.analyzer),
            "disable-default-plugins": false,
            plugins: [],
          },
        };
        if (dockerTemp) {
          yield* dockerTemp.write("worker.php", PHP_INSIGHTS_WORKER_SOURCE);
          yield* dockerTemp.write("input.json", yield* encodeJson(workerInput));
          yield* dockerTemp.write("mago.json", yield* encodeJson(config));
        } else {
          yield* fs.writeFileString(worker, PHP_INSIGHTS_WORKER_SOURCE);
          yield* fs.writeFileString(inputPath, yield* encodeJson(workerInput));
          yield* fs.writeFileString(configPath, yield* encodeJson(config));
        }
        if (workerInput.securityOnly) {
          const env = {
            ...globalThis.process.env,
            NO_COLOR: "1",
            T3_PHP_INSIGHTS_INPUT: inputPath,
          };
          const checked = yield* docker
            ? docker
                .runPhp(["-d", "memory_limit=1G", worker], env)
                .pipe(
                  Effect.mapError(
                    (cause) => new PhpInsightsExecutionError({ stage: "process", cause }),
                  ),
                )
            : runner
                .run({
                  command: "php",
                  args: ["-d", "memory_limit=1G", worker],
                  cwd: input.cwd,
                  env,
                  timeout: 60_000,
                  maxOutputBytes: 4_000_000,
                  outputMode: "error",
                  timeoutBehavior: "error",
                })
                .pipe(
                  Effect.mapError(
                    (cause) => new PhpInsightsExecutionError({ stage: "process", cause }),
                  ),
                );
          if (
            checked.code !== 0 ||
            checked.timedOut ||
            checked.stdoutTruncated ||
            checked.stderrTruncated
          )
            return yield* new PhpInsightsExecutionError({ stage: "process" });
        } else {
          yield* process(
            [
              "--config",
              configPath,
              "--workspace",
              toolPath(areaRoot),
              "analyze",
              "--reporting-format",
              "count",
              "--reporting-target",
              "stdout",
              "--minimum-report-level",
              "note",
            ],
            { ...globalThis.process.env, NO_COLOR: "1", T3_PHP_INSIGHTS_INPUT: inputPath },
          ).pipe(
            Effect.mapError((cause) => {
              const error = new PhpInsightsExecutionError({ stage: "process", cause });
              if (snapshotKey !== undefined) {
                failedSnapshots.delete(snapshotKey);
                failedSnapshots.set(snapshotKey, error);
                if (failedSnapshots.size > 2)
                  failedSnapshots.delete(failedSnapshots.keys().next().value!);
              }
              return error;
            }),
          );
        }
        const freshReports = new Map<string, string>();
        // Area reports cover every selector, while returned batches stay bounded.
        // Bound their combined wire size, including fresh per-batch security.
        let reportBytes = cached?.reportBytes ?? 0;
        let securityBytes = 0;
        const reportLimit = (input.snapshot ? 64 : 16) * 1024 * 1024;
        const sidecar = Effect.fnUntraced(function* (file: string) {
          const name = file.slice(temp.length + 1);
          const existing = cached?.reports.get(name) ?? freshReports.get(name);
          if (existing !== undefined) return existing;
          const remaining = input.snapshot ? reportLimit - reportBytes : reportLimit;
          let raw: string;
          if (dockerTemp) raw = yield* dockerTemp.read(name, remaining);
          else {
            const info = yield* fs.stat(file);
            if (info.type !== "File" || info.size > remaining)
              return yield* new PhpInsightsExecutionError({ stage: "report" });
            raw = yield* fs.readFileString(file);
          }
          if (typeof raw !== "string")
            return yield* new PhpInsightsExecutionError({ stage: "report" });
          const bytes = Buffer.byteLength(raw, "utf8");
          if (bytes > remaining) return yield* new PhpInsightsExecutionError({ stage: "report" });
          reportBytes += bytes;
          if (name === "security.json") securityBytes = bytes;
          else freshReports.set(name, raw);
          return raw;
        });
        const latest = yield* Effect.forEach(trackedPaths, (file) => fs.readFileString(file));
        if (
          tracked.some((content, index) => content !== latest[index]) ||
          initialSource !== (yield* sourceStamp()) ||
          initialRemoteReference !== (yield* remoteReferenceStamp())
        )
          return {
            queryBudget: {
              status: "failed" as const,
              message:
                "The PHP source, configuration or container reference changed during analysis. Save or reopen the file to refresh insights.",
              methods: [],
            },
            entryChains: {
              status: "failed" as const,
              message:
                "The PHP source, configuration or container reference changed during analysis. Save or reopen the file to refresh insights.",
              targets: [],
            },
          };
        let queryReports: ReadonlyMap<string, unknown> = cached?.queries ?? new Map();
        if (input.indexPaths !== undefined && cached === undefined) {
          const queryReport = yield* sidecar(queryOutput).pipe(
            Effect.flatMap(decodeJson),
            Effect.result,
          );
          if (queryReport._tag === "Success") {
            const parsed = yield* Effect.try(() => {
              const indexed = object(queryReport.success).files;
              if (!Array.isArray(indexed) || indexed.length > (input.snapshot ? 50_000 : 2000))
                throw new Error("Invalid indexed query report.");
              const reports = new Map<string, unknown>();
              for (const value of indexed) {
                const item = object(value);
                if (typeof item.path !== "string" || reports.has(item.path))
                  throw new Error("Invalid indexed query path.");
                reports.set(item.path, item.report);
              }
              return reports;
            }).pipe(Effect.result);
            if (parsed._tag === "Success") queryReports = parsed.success;
          }
        }
        const query = yield* (
          input.indexPaths !== undefined
            ? Effect.try(() =>
                normalizePhpQueryInsights(queryReports.get(input.relativePath), input.relativePath),
              )
            : sidecar(queryOutput).pipe(
                Effect.flatMap((raw) =>
                  Effect.try(() => decodePhpQueryInsights(raw, input.relativePath)),
                ),
              )
        ).pipe(Effect.result);
        const graphSelector = cached
          ? { _tag: "Success" as const, success: cached.graph }
          : yield* sidecar(graphOutput).pipe(
              Effect.flatMap((raw) => decodeJson(raw)),
              Effect.flatMap((value) =>
                Effect.try(() => preparePhpEntryInsightsReport(value, input.areaPath)),
              ),
              Effect.result,
            );
        const graph =
          graphSelector._tag === "Success"
            ? yield* Effect.try(() => graphSelector.success(workerInput.areaRelativePath)).pipe(
                Effect.result,
              )
            : graphSelector;
        const thresholds = yield* sidecar(thresholdOutput).pipe(
          Effect.flatMap(decodeJson),
          Effect.flatMap((value) => Effect.try(() => normalizePhpThresholdInsights(value))),
          Effect.result,
        );
        const securitySources = new Map<string, string>();
        for (const sourcePath of input.indexPaths ?? [input.relativePath])
          securitySources.set(
            sourcePath,
            yield* fs.readFileString(paths.resolve(input.workspaceRoot, sourcePath)),
          );
        const securityReport = yield* sidecar(securityOutput).pipe(
          Effect.flatMap(decodeJson),
          Effect.flatMap((value) =>
            Effect.try(() => normalizePhpSecurityInsights(value, input.areaPath, securitySources)),
          ),
          Effect.result,
        );
        const security =
          securityReport._tag === "Success"
            ? securityReport.success
            : normalizePhpSecurityInsights({ status: "failed" }, input.areaPath, securitySources);
        const thresholdFields =
          thresholds._tag === "Success"
            ? thresholds.success
            : {
                doctrineQueryThresholdsSource: {
                  kind: "unresolved" as const,
                  message:
                    "Configured query thresholds could not be read safely. Refresh the installed Doctrine extension.",
                },
              };
        let indexedFiles: PhpInsightsResult["indexedFiles"];
        if (input.indexPaths !== undefined) {
          if (snapshotKey !== undefined && cached === undefined) {
            freshReports.delete("queries.json");
            freshReports.delete("graph.json");
            const cachedBytes = reportBytes - securityBytes;
            const retainedBytes = () =>
              [...cachedSnapshots.values()].reduce((sum, entry) => sum + entry.reportBytes, 0);
            while (
              cachedSnapshots.size > 0 &&
              (cachedSnapshots.size >= 2 || retainedBytes() + cachedBytes > 64 * 1024 * 1024)
            )
              cachedSnapshots.delete(cachedSnapshots.keys().next().value!);
            cachedSnapshots.set(snapshotKey, {
              reports: freshReports,
              graph:
                graphSelector._tag === "Success"
                  ? graphSelector.success
                  : () => ({
                      status: "failed",
                      message: "The entry chain report is missing or invalid.",
                      targets: [],
                    }),
              queries: queryReports,
              reportBytes: cachedBytes,
            });
          }
          indexedFiles = input.indexPaths.map((file) => {
            const pathInArea = paths
              .relative(areaRoot, paths.resolve(input.workspaceRoot, file))
              .split(paths.sep)
              .join("/");
            let queryBudget: MonolithQueryBudget = {
              status: "failed",
              message: "The indexed query report is missing or invalid.",
              methods: [],
            };
            let entryChains: MonolithEntryChains = {
              status: "failed",
              message: "The indexed entry report is missing or invalid.",
              targets: [],
            };
            try {
              const report = queryReports.get(file);
              if (report !== undefined) queryBudget = normalizePhpQueryInsights(report, file);
            } catch {
              /* Keep a failed query result independently from the graph. */
            }
            try {
              if (graphSelector._tag === "Success") entryChains = graphSelector.success(pathInArea);
            } catch {
              /* Keep a failed graph result independently from queries. */
            }
            return { path: file, queryBudget, entryChains };
          });
        }
        return {
          ...thresholdFields,
          security,
          ...(indexedFiles === undefined ? {} : { indexedFiles }),
          queryBudget:
            query._tag === "Success"
              ? query.success
              : {
                  status: "failed" as const,
                  message: "The query insight report is missing or invalid.",
                  methods: [],
                },
          entryChains:
            graph._tag === "Success"
              ? graph.success
              : {
                  status: "failed" as const,
                  message: "The entry chain report is missing or invalid.",
                  targets: [],
                },
        };
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isInsightError(cause) ? cause : new PhpInsightsExecutionError({ stage: "write", cause }),
      ),
    );
  });
  return PhpInsightsExecution.of({
    run: (input) =>
      run(input).pipe(
        Effect.mapError((cause) =>
          isInsightError(cause)
            ? cause
            : new PhpInsightsExecutionError({ stage: "process", cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(PhpInsightsExecution, make);
