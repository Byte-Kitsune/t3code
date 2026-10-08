import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as MagoDockerExecution from "./MagoDockerExecution.ts";
import * as PhpInsightsExecution from "./PhpInsightsExecution.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const output = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-php-runner-test-" });
  yield* fs.makeDirectory(`${root}/app/src`, { recursive: true });
  yield* fs.makeDirectory(`${root}/app/tools/vendor/bin`, { recursive: true });
  yield* fs.writeFileString(`${root}/app/tools/vendor/bin/mago`, "fixture");
  yield* fs.writeFileString(`${root}/app/tools/vendor/autoload.php`, "<?php");
  yield* fs.writeFileString(`${root}/app/src/Test.php`, "<?php class Test {}");
  yield* fs.writeFileString(
    `${root}/app/mago.toml`,
    '[source]\npaths=["src"]\n[extension-hosts.original]\ncommand=["php","tools/mago-worker.php"]',
  );
  return {
    command: `${root}/app/tools/vendor/bin/mago`,
    cwd: `${root}/app`,
    workspaceRoot: root,
    areaPath: "app",
    filePath: `${root}/app/src/Test.php`,
    relativePath: "app/src/Test.php",
    configPath: `${root}/app/mago.toml`,
    autoloadPaths: [`${root}/app/tools/vendor/autoload.php`],
  } satisfies PhpInsightsExecution.PhpInsightsInput;
});
function runLayer(run: ProcessRunner.ProcessRunner["Service"]["run"]) {
  return PhpInsightsExecution.layer.pipe(
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}
it.effect("identifies a failed Mago config command without exposing its output", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const failure = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run(input),
    ).pipe(
      Effect.provide(
        runLayer(() =>
          Effect.succeed({
            ...output(""),
            code: ChildProcessSpawner.ExitCode(2),
            stderr: "TOML parse error: password='do-not-display'",
          }),
        ),
      ),
      Effect.flip,
    );
    expect(failure.stage).toBe("config");
    expect(failure.message).toContain("Mago config --no-extensions failed");
    expect(failure.message).toContain("Exit code 2");
    expect(failure.message).toContain("could not load its configuration");
    expect(failure.message).not.toContain("do-not-display");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it("preserves a process output limit wrapped by Docker", () => {
  const failure = new PhpInsightsExecution.PhpInsightsExecutionError({
    stage: "process",
    cause: new MagoDockerExecution.MagoDockerError({
      stage: "process",
      cause: new ProcessRunner.ProcessOutputLimitError({
        command: "docker",
        argumentCount: 3,
        stream: "stdout",
        maxBytes: 4_000_000,
        observedBytes: 4_030_464,
      }),
    }),
  });
  expect(failure.message).toContain("stdout produced 4030464 bytes");
  expect(failure.message).toContain("4000000 byte limit");
});

function mockRunner(
  options: {
    malformedQuery?: boolean;
    expectedThreads?: number;
    queryPaddingBytes?: number;
    graphPaddingBytes?: number;
    securityReport?: unknown;
    expectedSecurityDisabled?: boolean;
    expectedSecurityPaths?: readonly { areaRelativePath: string }[];
    missingGraph?: boolean;
    graphReport?: unknown;
    changeSource?: boolean;
    changeConfig?: boolean;
    changeConfigDuringRead?: boolean;
    differentWorkspace?: boolean;
    thresholdReport?: unknown;
    expectedThresholdSource?: string;
    expectedCommentMarkers?: readonly { marker: string; severity: string }[];
  } = {},
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  let temporaryInput: string | undefined;
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = Effect.fnUntraced(
    function* (input: ProcessRunner.ProcessRunInput) {
      calls.push(input);
      const fs = yield* FileSystem.FileSystem;
      if (input.args.includes("config")) {
        if (options.changeConfigDuringRead)
          yield* fs.writeFileString(`${input.cwd}/mago.toml`, '[source]\npaths=["changed"]');
        return output(
          encode({
            threads: 24,
            source: {
              paths: ["src", "shared"],
              excludes: ["var"],
              ...(options.differentWorkspace ? { workspace: `${input.cwd}/nested` } : {}),
            },
            analyzer: { ignore: ["mixed-argument"] },
            "extension-hosts": {},
          }),
        );
      }
      temporaryInput = input.env?.T3_PHP_INSIGHTS_INPUT;
      const data = decode(yield* fs.readFileString(temporaryInput!)) as Record<string, string>;
      if (options.expectedThresholdSource !== undefined) {
        const sources = data.thresholdSources as unknown as readonly {
          filePath: string;
          relativePath: string;
        }[];
        expect(sources[0]?.relativePath).toBe(options.expectedThresholdSource);
        expect(sources.some((source) => source.relativePath === "app/tools/mago-worker.php")).toBe(
          true,
        );
      }
      if (options.expectedSecurityDisabled !== undefined)
        expect(data.securityDisabled).toBe(options.expectedSecurityDisabled);
      if (data.securityOutput)
        yield* fs.writeFileString(
          data.securityOutput,
          encode(options.securityReport ?? { status: "inactive" }),
        );
      if (options.expectedSecurityPaths)
        expect(data.securityPaths).toEqual(options.expectedSecurityPaths);
      expect(data.securitySources).toEqual([{ filePath: `${input.cwd}/tools/mago-worker.php` }]);
      if (data.thresholdOutput)
        yield* fs.writeFileString(
          data.thresholdOutput,
          encode(
            options.thresholdReport ?? {
              thresholds: { warning: 10, error: 50 },
              source: { kind: "default" },
            },
          ),
        );
      if (options.expectedCommentMarkers !== undefined)
        expect(data.commentMarkers).toEqual(options.expectedCommentMarkers);
      if (input.command === "php") {
        expect(data.indexPaths).toEqual([]);
        expect(data.securityOnly).toBe(true);
        expect(input.args.slice(0, 2)).toEqual(["-d", "memory_limit=1G"]);
        return output("");
      }
      const config = decode(yield* fs.readFileString(input.args[1]!)) as {
        source: { paths: string[] };
        analyzer: { ignore: string[] };
        threads: number;
        "extension-hosts": Record<string, unknown>;
      };
      expect(config.source.paths).toEqual(["src", "shared"]);
      expect(config.analyzer.ignore).toEqual(["mixed-argument"]);
      expect(config.threads).toBe(options.expectedThreads ?? 2);
      expect(config["extension-hosts"]["t3-insights"]).toEqual({
        command: [
          "php",
          "-d",
          "display_errors=stderr",
          "-d",
          "memory_limit=1G",
          expect.stringContaining("worker.php"),
        ],
        workers: 1,
      });
      expect(Object.keys(config["extension-hosts"])).toEqual(["t3-insights"]);
      yield* fs.writeFileString(
        data.queryOutput!,
        options.malformedQuery
          ? "broken JSON"
          : encode({
              status: "complete",
              methods: [
                {
                  symbol: "Test::load",
                  path: "app/src/Test.php",
                  line: 1,
                  lowerBound: 1,
                  upperBound: 1,
                  unknown: [],
                  cycles: [],
                },
              ],
            }),
      );
      const indexed = data.indexPaths as unknown as readonly { relativePath: string }[] | null;
      if (Array.isArray(indexed))
        yield* fs.writeFileString(
          data.queryOutput!,
          encode({
            files: indexed.map((file) => ({
              path: file.relativePath,
              report: {
                status: "complete",
                methods: [
                  {
                    symbol: "Test::load",
                    path: file.relativePath,
                    line: 1,
                    lowerBound: 1,
                    upperBound: 2,
                    unknown: [],
                    cycles: [],
                  },
                ],
              },
            })),
          }),
        );
      if (!options.missingGraph)
        yield* fs.writeFileString(
          data.graphOutput!,
          encode(
            options.graphReport ?? {
              status: "unavailable",
              message: "No graph extension installed.",
            },
          ),
        );
      for (const [file, padding] of [
        [data.queryOutput, options.queryPaddingBytes],
        [data.graphOutput, options.graphPaddingBytes],
      ] as const) {
        if (file && padding)
          yield* fs.writeFileString(
            file,
            `${yield* fs.readFileString(file)}${" ".repeat(padding)}`,
          );
      }
      if (options.changeSource)
        yield* fs.writeFileString(
          data.filePath!,
          "<?php class ChangedSourceWithDifferentLength {}",
        );
      if (options.changeConfig)
        yield* fs.writeFileString(`${input.cwd}/mago.toml`, '[source]\npaths=["changed"]');
      return output('{"issues":[]}');
    },
    Effect.orDie,
    Effect.provide(NodeServices.layer),
  );
  return { run, calls, inputPath: () => temporaryInput };
}
it.effect(
  "preserves full configured sources, isolates workers and removes all temporary reports",
  () =>
    Effect.gen(function* () {
      const input = yield* setup;
      const mock = mockRunner();
      const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
        service.run(input),
      ).pipe(Effect.provide(runLayer(mock.run)));
      expect(result.queryBudget.methods[0]?.lowerBound).toBe(1);
      expect(result.entryChains.status).toBe("unavailable");
      expect(mock.calls).toHaveLength(2);
      const analyze = mock.calls[1]!;
      expect(analyze.args).toContain("analyze");
      expect(analyze.args[analyze.args.indexOf("--reporting-format") + 1]).toBe("count");
      expect(analyze.args).not.toContain(input.filePath);
      expect(analyze.args).not.toContain("--fix");
      expect(analyze.args).toContain(`${input.workspaceRoot}/app`);
      expect(analyze.timeout).toBe(60_000);
      expect(analyze.maxOutputBytes).toBe(4_000_000);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(mock.inputPath()!)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("malformed query output fails without hiding the independent graph status", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run(input),
    ).pipe(Effect.provide(runLayer(mockRunner({ malformedQuery: true }).run)));
    expect(result.queryBudget.status).toBe("failed");
    expect(result.queryBudget.methods).toEqual([]);
    expect(result.entryChains.status).toBe("unavailable");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("missing graph output is failed rather than a complete empty caller list", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run(input),
    ).pipe(Effect.provide(runLayer(mockRunner({ missingGraph: true }).run)));
    expect(result.queryBudget.status).toBe("complete");
    expect(result.entryChains.status).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each(["changeSource", "changeConfig", "changeConfigDuringRead"] as const)(
  "hides both reports when %s occurs during analysis",
  (change) =>
    Effect.gen(function* () {
      const input = yield* setup;
      const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
        service.run(input),
      ).pipe(Effect.provide(runLayer(mockRunner({ [change]: true }).run)));
      expect(result.queryBudget.status).toBe("failed");
      expect(result.queryBudget.methods).toEqual([]);
      expect(result.entryChains.targets).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("rejects symlinked autoloaders before starting any project tool", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.symlink(input.autoloadPaths[0]!, `${input.workspaceRoot}/app/linked.php`);
    const mock = mockRunner();
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({ ...input, autoloadPaths: [`${input.workspaceRoot}/app/linked.php`] }),
    ).pipe(Effect.result, Effect.provide(runLayer(mock.run)));
    expect(result._tag).toBe("Failure");
    expect(mock.calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "rejects a different configured workspace instead of analyzing the wrong source tree",
  () =>
    Effect.gen(function* () {
      const input = yield* setup;
      const mock = mockRunner({ differentWorkspace: true });
      const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
        service.run(input),
      ).pipe(Effect.result, Effect.provide(runLayer(mock.run)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.stage).toBe("workspace");
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]?.args).not.toContain("--workspace");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["missing", "stable", "changed"] as const)(
  "stages Docker workers without host vendor and handles %s container references",
  (referenceState) =>
    Effect.gen(function* () {
      const input = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${input.workspaceRoot}/app/tools`, { recursive: true });
      const files = new Map<string, string>();
      const captured: string[][] = [];
      let cleanup = false;
      let hashCalls = 0;
      const areaRoot = `${input.workspaceRoot}/app`;
      const docker = MagoDockerExecution.MagoDockerExecution.of({
        prepare: () =>
          Effect.succeed({
            composeArgs: ["compose"],
            hostAreaRoot: areaRoot,
            containerAreaRoot: "/srv/api",
            toContainer: (path) => path.replace(areaRoot, "/srv/api"),
            toHost: (path) => path.replace("/srv/api", areaRoot),
            exists: () => Effect.succeed(referenceState !== "missing"),
            runPhp: () =>
              Effect.sync(() => {
                if (referenceState === "missing")
                  throw new Error("Absent optional reference must not be hashed");
                hashCalls++;
                return output(
                  (referenceState === "changed" && hashCalls > 1 ? "b" : "a").repeat(64),
                );
              }),
            allocateTemp: Effect.acquireRelease(
              Effect.succeed({
                path: "/tmp/t3-insights-fixture",
                write: (name: string, contents: string) =>
                  Effect.sync(() => {
                    files.set(name, contents);
                  }),
                read: (name: string, max?: number) => {
                  expect(max).toBe(16 * 1024 * 1024);
                  return files.has(name)
                    ? Effect.succeed(files.get(name)!)
                    : Effect.fail(new MagoDockerExecution.MagoDockerError({ stage: "temporary" }));
                },
              }),
              () =>
                Effect.sync(() => {
                  cleanup = true;
                }),
            ),
            runMago: (args, env) =>
              Effect.sync(() => {
                captured.push([...args]);
                if (args.includes("config"))
                  return output(
                    encode({
                      source: { workspace: "/srv/api", paths: ["src"] },
                      analyzer: {},
                      threads: 8,
                    }),
                  );
                expect(env?.T3_PHP_INSIGHTS_INPUT).toBe("/tmp/t3-insights-fixture/input.json");
                const workerInput = decode(files.get("input.json")!) as Record<string, unknown>;
                expect(workerInput.filePath).toBe("/srv/api/src/Test.php");
                expect(workerInput.projectRoot).toBe("/srv/api");
                expect(workerInput.autoloadPaths).toEqual(["/srv/api/tools/vendor/autoload.php"]);
                expect(workerInput.referencePath).toBe(
                  referenceState === "missing"
                    ? null
                    : "/srv/api/.mago/container-reference.dev.json",
                );
                expect(workerInput.queryOutput).toBe("/tmp/t3-insights-fixture/queries.json");
                const config = decode(files.get("mago.json")!) as Record<string, unknown>;
                expect(config.source).toMatchObject({ workspace: "/srv/api", paths: ["src"] });
                expect(config["extension-hosts"]).toEqual({
                  "t3-insights": {
                    command: [
                      "php",
                      "-d",
                      "display_errors=stderr",
                      "-d",
                      "memory_limit=1G",
                      "/tmp/t3-insights-fixture/worker.php",
                    ],
                    workers: 1,
                  },
                });
                files.set(
                  "queries.json",
                  encode({
                    status: "complete",
                    methods: [
                      {
                        symbol: "Test::load",
                        path: "app/src/Test.php",
                        line: 1,
                        lowerBound: 0,
                        upperBound: 0,
                        unknown: [],
                        cycles: [],
                      },
                    ],
                  }),
                );
                files.set(
                  "graph.json",
                  encode({ status: "unavailable", message: "No graph installed" }),
                );
                return output('{"issues":[]}');
              }),
          }),
      });
      const forbiddenRunner = ProcessRunner.ProcessRunner.of({
        run: () => Effect.die("Host Mago must not execute"),
      });
      const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
        service.run({
          ...input,
          runtime: { service: "php" },
          referencePath: `${areaRoot}/.mago/container-reference.dev.json`,
        }),
      ).pipe(
        Effect.provide(
          PhpInsightsExecution.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(ProcessRunner.ProcessRunner, forbiddenRunner),
                Layer.succeed(MagoDockerExecution.MagoDockerExecution, docker),
              ),
            ),
          ),
        ),
      );
      expect(result.queryBudget.status).toBe(referenceState === "changed" ? "failed" : "complete");
      if (referenceState === "changed") expect(result.queryBudget.methods).toEqual([]);
      else expect(result.queryBudget.methods[0]?.upperBound).toBe(0);
      expect(result.entryChains.status).toBe(
        referenceState === "changed" ? "failed" : "unavailable",
      );
      expect(captured[0]).toContain("/srv/api/mago.toml");
      expect(captured[1]).toContain("/tmp/t3-insights-fixture/mago.json");
      expect(captured[1]).toContain("/srv/api");
      expect(cleanup).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "forwards explicitly configured marker rules including disabled defaults to the worker",
  () =>
    Effect.gen(function* () {
      const input = yield* setup;
      for (const commentMarkers of [[], [{ marker: "[TEAM]", severity: "error" as const }]]) {
        const mock = mockRunner({ expectedCommentMarkers: commentMarkers });
        yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
          service.run({ ...input, commentMarkers }),
        ).pipe(Effect.provide(runLayer(mock.run)));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("builds indexed per-file reports from one shared PHP source analysis", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${input.workspaceRoot}/app/src/Other.php`, "<?php class Other {}");
    const mock = mockRunner();
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({ ...input, indexPaths: ["app/src/Test.php", "app/src/Other.php"] }),
    ).pipe(Effect.provide(runLayer(mock.run)));
    expect(mock.calls).toHaveLength(2);
    expect(
      result.indexedFiles?.map((file) => [
        file.path,
        file.queryBudget.methods[0]?.upperBound,
        file.entryChains.status,
      ]),
    ).toEqual([
      ["app/src/Test.php", 2, "unavailable"],
      ["app/src/Other.php", 2, "unavailable"],
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads canonical threshold provenance and preserves unresolved configuration without guesses",
  () =>
    Effect.gen(function* () {
      const input = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${input.workspaceRoot}/app/.mago`);
      yield* fs.writeFileString(
        `${input.workspaceRoot}/app/.mago/extension.php`,
        "<?php return Budget::create(warningThreshold:12,errorThreshold:40);",
      );
      const thresholdReport = {
        thresholds: { warning: 12, error: 40 },
        source: { kind: "extension", path: "app/.mago/extension.php" },
      };
      const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
        service.run(input),
      ).pipe(
        Effect.provide(
          runLayer(
            mockRunner({ thresholdReport, expectedThresholdSource: "app/.mago/extension.php" }).run,
          ),
        ),
      );
      expect(result.doctrineQueryThresholds).toEqual({ warning: 12, error: 40 });
      expect(result.doctrineQueryThresholdsSource).toEqual(thresholdReport.source);
      const unresolved = yield* Effect.flatMap(
        PhpInsightsExecution.PhpInsightsExecution,
        (service) => service.run(input),
      ).pipe(
        Effect.provide(
          runLayer(
            mockRunner({
              thresholdReport: {
                source: {
                  kind: "unresolved",
                  path: "app/.mago/extension.php",
                  message: "Dynamic thresholds",
                },
              },
            }).run,
          ),
        ),
      );
      expect(unresolved.doctrineQueryThresholds).toBeUndefined();
      expect(unresolved.doctrineQueryThresholdsSource?.kind).toBe("unresolved");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inspects YAML paths independently without sending them to Doctrine", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${input.workspaceRoot}/app/config`);
    yield* fs.writeFileString(
      `${input.workspaceRoot}/app/config/services.yaml`,
      "password: secret\n",
    );
    const runner = mockRunner({
      expectedSecurityPaths: [
        { areaRelativePath: "src/Test.php" },
        { areaRelativePath: "config/services.yaml" },
      ],
      securityReport: {
        schema_version: 1,
        column_encoding: "utf8_bytes",
        issues: [
          {
            code: "byte-kitsune/symfony-wiring/no-hardcoded-secret",
            severity: "error",
            path: "config/services.yaml",
            line: 1,
            column: 11,
            end_line: 1,
            end_column: 17,
          },
        ],
        incomplete: [],
      },
    });
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({ ...input, indexPaths: [input.relativePath, "app/config/services.yaml"] }),
    ).pipe(Effect.provide(runLayer(runner.run)));
    expect(result.security?.diagnostics[0]?.path).toBe("app/config/services.yaml");
    expect(result.security?.run?.status).toBe("findings");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs standalone YAML inspection without a PHP analysis snapshot", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${input.workspaceRoot}/app/config`);
    yield* fs.writeFileString(
      `${input.workspaceRoot}/app/config/services.yaml`,
      "password: secret\n",
    );
    const runner = mockRunner({
      securityReport: {
        schema_version: 1,
        column_encoding: "utf8_bytes",
        issues: [],
        incomplete: [],
      },
    });
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({
        ...input,
        filePath: `${input.workspaceRoot}/app/config/services.yaml`,
        relativePath: "app/config/services.yaml",
      }),
    ).pipe(Effect.provide(runLayer(runner.run)));
    expect(result.security?.run?.status).toBe("passed");
    expect(runner.calls.map((call) => call.command)).toEqual([input.command, "php"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("recovers configured worker hosts from JSON when Mago strips extension hosts", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    const configPath = `${input.workspaceRoot}/app/mago.json`;
    yield* fs.writeFileString(
      configPath,
      encode({
        source: { paths: ["src"] },
        "extension-hosts": { security: { command: ["php", "tools/mago-worker.php"] } },
      }),
    );
    const runner = mockRunner();
    yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({ ...input, configPath }),
    ).pipe(Effect.provide(runLayer(runner.run)));
    expect(runner.calls[0]?.args).toContain("--no-extensions");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("honors an explicitly disabled native Symfony security rule", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      input.configPath,
      '[source]\npaths=["src"]\n[extension-hosts.original]\ncommand=["php","tools/mago-worker.php"]\n[linter.rules."byte-kitsune/symfony-wiring/no-hardcoded-secret"]\nenabled=false',
    );
    const runner = mockRunner({ expectedSecurityDisabled: true });
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run(input),
    ).pipe(Effect.provide(runLayer(runner.run)));
    expect(result.security?.run).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("selects distinct opened and indexed file chains from one full graph snapshot", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${input.workspaceRoot}/app/src/Other.php`, "<?php class Other {}");
    const mock = mockRunner({
      graphReport: {
        status: "snapshot",
        snapshot: {
          schema_version: "1",
          capability: "full_source_call_graph",
          complete: true,
          max_depth: 8,
          unknown: [],
          nodes: [
            {
              id: "entry",
              symbol: "Test::run",
              path: "src/Test.php",
              line: 1,
              column: 1,
              entry_scope: "http",
            },
            {
              id: "target",
              symbol: "Other::run",
              path: "src/Other.php",
              line: 1,
              column: 1,
              entry_scope: null,
            },
          ],
          edges: [{ from: "entry", to: "target", path: "src/Test.php", line: 1, column: 1 }],
        },
      },
    });
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({ ...input, indexPaths: ["app/src/Test.php", "app/src/Other.php"] }),
    ).pipe(Effect.provide(runLayer(mock.run)));
    expect(result.entryChains.targets[0]?.symbol).toBe("Test::run");
    expect(
      result.indexedFiles?.map((file) => [
        file.path,
        file.entryChains.targets[0]?.symbol,
        file.entryChains.targets[0]?.entries[0]?.chain.length,
      ]),
    ).toEqual([
      ["app/src/Test.php", "Test::run", 1],
      ["app/src/Other.php", "Other::run", 2],
    ]);
    expect(mock.calls).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reuses one complete area analysis across bounded batches and keeps security per batch",
  () =>
    Effect.gen(function* () {
      const input = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${input.cwd}/src/Other.php`, "<?php class Other {}");
      const other = "app/src/Other.php";
      const mock = mockRunner();
      const snapshot = { key: "immutable-cycle-1", paths: [input.relativePath, other] };
      const results = yield* Effect.gen(function* () {
        const service = yield* PhpInsightsExecution.PhpInsightsExecution;
        const first = yield* service.run({ ...input, snapshot, indexPaths: [input.relativePath] });
        const second = yield* service.run({
          ...input,
          filePath: `${input.cwd}/src/Other.php`,
          relativePath: other,
          snapshot,
          indexPaths: [other],
        });
        return [first, second];
      }).pipe(Effect.provide(runLayer(mock.run)));
      expect(results[0]?.indexedFiles?.map((file) => file.path)).toEqual([input.relativePath]);
      expect(results[1]?.indexedFiles?.map((file) => file.path)).toEqual([other]);
      expect(results[1]?.indexedFiles?.[0]?.queryBudget.methods[0]?.path).toBe(other);
      expect(mock.calls.filter((call) => call.args.includes("analyze"))).toHaveLength(1);
      expect(mock.calls.filter((call) => call.command === "php")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["source", "config", "cycle", "selectors", "foreground"] as const)(
  "does not reuse a cached area analysis after %s changes",
  (change) =>
    Effect.gen(function* () {
      const input = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const other = "app/src/Other.php";
      yield* fs.writeFileString(`${input.cwd}/src/Other.php`, "<?php class Other {}");
      const mock = mockRunner();
      const snapshot = { key: "immutable-cycle-1", paths: [input.relativePath] };
      yield* Effect.gen(function* () {
        const service = yield* PhpInsightsExecution.PhpInsightsExecution;
        yield* service.run({ ...input, snapshot, indexPaths: [input.relativePath] });
        if (change === "source")
          yield* fs.writeFileString(`${input.cwd}/src/Other.php`, "<?php class ChangedOther {}");
        if (change === "config")
          yield* fs.writeFileString(
            input.configPath,
            `${yield* fs.readFileString(input.configPath)}\n# Changed configuration`,
          );
        yield* service.run({
          ...input,
          ...(change === "foreground"
            ? {}
            : {
                indexPaths: [input.relativePath],
                snapshot: {
                  key: change === "cycle" ? "immutable-cycle-2" : snapshot.key,
                  paths: change === "selectors" ? [...snapshot.paths, other] : snapshot.paths,
                },
              }),
        });
      }).pipe(Effect.provide(runLayer(mock.run)));
      expect(mock.calls.filter((call) => call.args.includes("analyze"))).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails closed when sources change during a cached batch security check", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    const mock = mockRunner();
    const snapshot = { key: "immutable-cycle-1", paths: [input.relativePath] };
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (request) =>
      mock
        .run(request)
        .pipe(
          Effect.tap(() =>
            request.command === "php"
              ? fs
                  .writeFileString(input.filePath, "<?php class ChangedDuringSecurity {}")
                  .pipe(Effect.orDie)
              : Effect.void,
          ),
        );
    const result = yield* Effect.gen(function* () {
      const service = yield* PhpInsightsExecution.PhpInsightsExecution;
      yield* service.run({ ...input, snapshot, indexPaths: snapshot.paths });
      return yield* service.run({ ...input, snapshot, indexPaths: snapshot.paths });
    }).pipe(Effect.provide(runLayer(run)));
    expect(result.queryBudget.status).toBe("failed");
    expect(result.entryChains.status).toBe("failed");
    expect(result.indexedFiles).toBeUndefined();
    expect(mock.calls.filter((call) => call.args.includes("analyze"))).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("caps background PHP analysis at one thread", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const mock = mockRunner({ expectedThreads: 1 });
    const result = yield* Effect.flatMap(PhpInsightsExecution.PhpInsightsExecution, (service) =>
      service.run({ ...input, threads: 1 }),
    ).pipe(Effect.provide(runLayer(mock.run)));
    expect(result.queryBudget.status).toBe("complete");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "allows area reports above the per-file limit but enforces the combined snapshot budget",
  () =>
    Effect.gen(function* () {
      const input = yield* setup;
      const mock = mockRunner({
        queryPaddingBytes: 17 * 1024 * 1024,
        graphPaddingBytes: 48 * 1024 * 1024,
      });
      const result = yield* Effect.gen(function* () {
        const service = yield* PhpInsightsExecution.PhpInsightsExecution;
        const request = {
          ...input,
          indexPaths: [input.relativePath],
          snapshot: { key: "bounded-large-report", paths: [input.relativePath] },
        };
        yield* service.run(request);
        return yield* service.run(request);
      }).pipe(Effect.provide(runLayer(mock.run)));
      expect(mock.calls.filter((call) => call.args.includes("analyze"))).toHaveLength(1);
      expect(result.indexedFiles?.[0]?.queryBudget.status).toBe("complete");
      expect(result.indexedFiles?.[0]?.entryChains.status).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reuses a failed native snapshot attempt until the indexing cycle changes", () =>
  Effect.gen(function* () {
    const input = yield* setup;
    const mock = mockRunner();
    let attempts = 0;
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (request) =>
      request.args.includes("analyze")
        ? Effect.sync(() => {
            attempts++;
            return { ...output(""), code: ChildProcessSpawner.ExitCode(2), timedOut: true };
          })
        : mock.run(request);
    yield* Effect.gen(function* () {
      const service = yield* PhpInsightsExecution.PhpInsightsExecution;
      for (const key of ["cycle-1", "cycle-1", "cycle-2"]) {
        const result = yield* service
          .run({
            ...input,
            indexPaths: [input.relativePath],
            snapshot: { key, paths: [input.relativePath] },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.stage).toBe("process");
          expect(result.failure.message).toContain("Exit code 2");
          expect(result.failure.message).toContain("exceeded its time limit");
        }
      }
    }).pipe(Effect.provide(runLayer(run)));
    expect(attempts).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([0, 33 * 1024 * 1024])(
  "retains interleaved area reports within the shared byte budget (%s padding)",
  (padding) =>
    Effect.gen(function* () {
      const first = yield* setup;
      const second = yield* setup;
      const mock = mockRunner({ queryPaddingBytes: padding });
      yield* Effect.gen(function* () {
        const service = yield* PhpInsightsExecution.PhpInsightsExecution;
        for (const input of [first, second, first]) {
          const result = yield* service.run({
            ...input,
            indexPaths: [input.relativePath],
            snapshot: { key: "cycle-1", paths: [input.relativePath] },
          });
          expect(result.indexedFiles?.[0]?.queryBudget.status).toBe("complete");
        }
      }).pipe(Effect.provide(runLayer(mock.run)));
      // Two 33MiB area reports cannot coexist under the shared 64MiB cache cap.
      expect(mock.calls.filter((call) => call.args.includes("analyze"))).toHaveLength(
        padding === 0 ? 2 : 3,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retains failed native attempts across interleaved areas", () =>
  Effect.gen(function* () {
    const first = yield* setup;
    const second = yield* setup;
    const mock = mockRunner();
    let attempts = 0;
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (request) =>
      request.args.includes("analyze")
        ? Effect.sync(() => {
            attempts++;
            return { ...output(""), code: ChildProcessSpawner.ExitCode(2) };
          })
        : mock.run(request);
    yield* Effect.gen(function* () {
      const service = yield* PhpInsightsExecution.PhpInsightsExecution;
      for (const input of [first, second, first]) {
        const result = yield* service
          .run({
            ...input,
            indexPaths: [input.relativePath],
            snapshot: { key: "cycle-1", paths: [input.relativePath] },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(runLayer(run)));
    expect(attempts).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
