import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as AnalyzerExecution from "../analyzers/AnalyzerExecution.ts";
import * as PhpInsightsExecution from "../analyzers/PhpInsightsExecution.ts";
import * as AnalyzerDiscoveryService from "./AnalyzerDiscoveryService.ts";
import * as MonolithService from "./MonolithService.ts";
import * as MonolithAnalyzerService from "./MonolithAnalyzerService.ts";

const write = Effect.fnUntraced(function* (root: string, relative: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, relative);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, contents);
});
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-analyzer-" });
  yield* write(root, "app/composer.json", '{"require-dev":{"carthage-software/mago":"*"}}');
  yield* write(root, "app/vendor/bin/mago", "fixture");
  yield* write(root, "app/src/Test.php", "<?php\nfunction test(): void {}\n");
  return root;
});
function serviceLayer(
  run: AnalyzerExecution.AnalyzerExecution["Service"]["run"],
  insights: PhpInsightsExecution.PhpInsightsExecution["Service"]["run"] = () =>
    Effect.die("Unexpected insight process"),
) {
  return Layer.fresh(MonolithAnalyzerService.layer).pipe(
    Layer.provide(
      Layer.succeed(
        PhpInsightsExecution.PhpInsightsExecution,
        PhpInsightsExecution.PhpInsightsExecution.of({
          run: insights,
        }),
      ),
    ),
    Layer.provide(MonolithService.layer),
    Layer.provide(AnalyzerDiscoveryService.layer),
    Layer.provide(
      Layer.succeed(
        AnalyzerExecution.AnalyzerExecution,
        AnalyzerExecution.AnalyzerExecution.of({ run }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}
const passed = () => Effect.succeed({ diagnostics: [], exitCode: 0, status: "passed" as const });

it.effect(
  "indexes all installed React analyzers from a shared snapshot and keeps per-file run counts",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* write(
        root,
        ".t3/monolith.json",
        JSON.stringify({
          version: 1,
          initialized: true,
          areas: [{ id: "ui", name: "UI", path: "ui", kind: "react" }],
        }),
      );
      yield* write(
        root,
        "ui/package.json",
        JSON.stringify({
          devDependencies: {
            "@biomejs/biome": "*",
            eslint: "*",
            "dependency-cruiser": "*",
          },
          scripts: {
            check: "biome check",
            "lint:architecture": 'pnpm exec eslint "app/**/*.js"',
            "architecture:check": "depcruise app --config .dependency-cruiser.cjs",
          },
        }),
      );
      for (const tool of ["biome", "eslint", "depcruise"])
        yield* write(root, `ui/node_modules/.bin/${tool}`, "fixture");
      yield* write(root, "ui/.dependency-cruiser.cjs", "module.exports = {};\n");
      yield* write(root, "ui/app/A.js", "export const a = 1;\n");
      yield* write(root, "ui/app/B.js", "export const b = 2;\n");
      const calls: AnalyzerExecution.AnalyzerExecutionInput[] = [];
      const files = yield* Effect.flatMap(
        MonolithAnalyzerService.MonolithAnalyzerService,
        (service) =>
          service.indexArea({
            cwd: root,
            areaId: "ui",
            paths: ["ui/package.json", "ui/app/A.js", "ui/app/B.js"],
            snapshot: {
              key: "react-index",
              paths: ["ui/package.json", "ui/app/A.js", "ui/app/B.js"],
            },
          }),
      ).pipe(
        Effect.provide(
          serviceLayer((input) => {
            calls.push(input);
            const diagnostics: AnalyzerExecution.AnalyzerDiagnostic[] =
              input.tool === "eslint"
                ? [
                    {
                      path: "ui/app/A.js",
                      line: 1,
                      column: 1,
                      severity: "error",
                      message: "Unused",
                      ruleId: "no-unused-vars",
                      tool: "eslint",
                      operation: "check",
                    },
                  ]
                : input.tool === "depcruise"
                  ? [
                      {
                        path: "ui/app/B.js",
                        severity: "error",
                        message: "Cross layer",
                        ruleId: "architecture",
                        tool: "depcruise",
                        operation: "check",
                      },
                    ]
                  : [];
            return Effect.succeed({
              diagnostics,
              exitCode: diagnostics.length ? 1 : 0,
              status: diagnostics.length ? ("findings" as const) : ("passed" as const),
            });
          }),
        ),
      );
      expect(calls.map((call) => call.tool)).toEqual(["biome", "eslint", "depcruise"]);
      expect(calls.find((call) => call.tool === "depcruise")?.sourcePaths).toEqual([
        `${root}/ui/app`,
      ]);
      expect(
        files.find((file) => file.path === "ui/package.json")?.result.runs.map((run) => run.tool),
      ).toEqual(["biome"]);
      const a = files.find((file) => file.path === "ui/app/A.js")!.result;
      const b = files.find((file) => file.path === "ui/app/B.js")!.result;
      expect(a.runs.find((run) => run.tool === "eslint")?.diagnosticCount).toBe(1);
      expect(a.runs.find((run) => run.tool === "depcruise")?.status).toBe("passed");
      expect(b.runs.find((run) => run.tool === "eslint")?.status).toBe("passed");
      expect(b.runs.find((run) => run.tool === "depcruise")?.diagnosticCount).toBe(1);
      expect(b.diagnostics[0]?.line).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "runs all PHP checks against the application root and returns the persisted revision",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const calls: AnalyzerExecution.AnalyzerExecutionInput[] = [];
      const result = yield* Effect.flatMap(
        MonolithAnalyzerService.MonolithAnalyzerService,
        (checkService) => checkService.checkFile({ cwd: root, path: "app/src/Test.php" }),
      ).pipe(
        Effect.provide(
          serviceLayer((input) => {
            calls.push(input);
            return passed();
          }),
        ),
      );
      expect(calls.map((call) => call.operation)).toEqual(["format", "analyze", "guard"]);
      expect(calls.every((call) => call.cwd === `${root}/app`)).toBe(true);
      expect(result.revision).toBe(
        "34efc8b160959e9de033227b80636ce16ab5e89e59aae8534bc2739221c44342",
      );
      expect(result.runs.every((run) => run.status === "passed")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(passed))),
);

it.effect("missing binaries are unavailable and never execute", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(`${root}/app/vendor/bin/mago`);
    const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
    const result = yield* service.checkFile({ cwd: root, path: "app/src/Test.php" });
    expect(result.runs.map((run) => run.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(yield* fs.exists(`${root}/.t3/monolith.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(serviceLayer(() => Effect.die("unexpected execution")))),
);

it.effect("disabled and arbitrary folder groups do not execute language analyzers", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(
      root,
      ".t3/monolith.json",
      JSON.stringify({
        version: 1,
        initialized: true,
        areas: [{ id: "app", name: "App", path: "app", kind: "folder" }],
      }),
    );
    const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
    const result = yield* service.checkFile({ cwd: root, path: "app/src/Test.php" });
    expect(result.areaId).toBe("app");
    expect(result.runs).toEqual([]);
    yield* write(
      root,
      ".t3/monolith.json",
      JSON.stringify({
        version: 1,
        initialized: true,
        areas: [{ id: "app", name: "App", path: "app", kind: "php", enabled: false }],
      }),
    );
    expect((yield* service.checkFile({ cwd: root, path: "app/src/Test.php" })).areaId).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(serviceLayer(() => Effect.die("unexpected execution")))),
);

it.effect("rejects traversal and symlink files before analyzer execution", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.symlink(`${root}/app/src/Test.php`, `${root}/app/src/Link.php`);
    const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
    for (const path of ["../outside.php", "app/src/Link.php"]) {
      const result = yield* service.checkFile({ cwd: root, path }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("unsafe_path");
    }
  }).pipe(Effect.scoped, Effect.provide(serviceLayer(() => Effect.die("unexpected execution")))),
);

it.effect("a failed operation does not suppress later operations", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
    const result = yield* service.checkFile({ cwd: root, path: "app/src/Test.php" });
    expect(result.runs.map((run) => run.status)).toEqual(["failed", "passed", "passed"]);
    expect(result.runs[0]?.message).toContain("spawn");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      serviceLayer((input) =>
        input.operation === "format"
          ? Effect.fail(
              new AnalyzerExecution.AnalyzerExecutionError({
                tool: "mago",
                operation: "format",
                category: "spawn",
                cause: new Error("fixture"),
              }),
            )
          : passed(),
      ),
    ),
  ),
);

it.effect("drops results when the persisted file changes while checks run", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* setup;
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (checkService) => checkService.checkFile({ cwd: root, path: "app/src/Test.php" }),
    ).pipe(
      Effect.provide(
        serviceLayer((input) =>
          Effect.gen(function* () {
            if (input.operation === "analyze")
              yield* fs
                .writeFileString(`${root}/app/src/Test.php`, "<?php // changed\n")
                .pipe(Effect.orDie);
            return {
              diagnostics: [
                {
                  path: "app/src/Test.php",
                  line: 1,
                  column: 1,
                  severity: "error" as const,
                  message: "Fixture",
                  ruleId: "fixture",
                  tool: input.tool,
                  operation: input.operation,
                },
              ],
              exitCode: 1,
              status: "findings" as const,
            };
          }),
        ),
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.runs.every((run) => run.status === "failed")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(serviceLayer(passed))),
);

const insightSetup = Effect.gen(function* () {
  const root = yield* setup;
  yield* write(root, "app/vendor/autoload.php", "<?php");
  yield* write(
    root,
    "app/vendor/byte-kitsune/mago-doctrine-query-budget/src/QueryBudgetExtension.php",
    "<?php",
  );
  yield* write(
    root,
    "app/composer.json",
    '{"require-dev":{"carthage-software/mago":"*","byte-kitsune/mago-doctrine-query-budget":"*"}}',
  );
  yield* write(
    root,
    ".t3/monolith.json",
    JSON.stringify({
      version: 1,
      initialized: true,
      areas: [
        { id: "backend", name: "Backend", path: "app", kind: "php", entrypointPaths: ["src/Jobs"] },
      ],
    }),
  );
  return root;
});
it.effect("returns independent PHP insights with configured entry folders and local tooling", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    const calls: PhpInsightsExecution.PhpInsightsInput[] = [];
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) => service.checkFile({ cwd: root, path: "app/src/Test.php" }),
    ).pipe(
      Effect.provide(
        serviceLayer(passed, (input) => {
          calls.push(input);
          return Effect.succeed({
            queryBudget: {
              status: "complete",
              methods: [
                {
                  symbol: "Test::load",
                  path: input.relativePath,
                  line: 2,
                  lowerBound: 2,
                  upperBound: 5,
                  unknown: [],
                  cycles: [],
                },
              ],
            },
            entryChains: { status: "unavailable", targets: [] },
          });
        }),
      ),
    );
    expect(calls[0]?.entrypointPaths).toEqual(["src/Jobs"]);
    expect(calls[0]?.autoloadPaths).toEqual([`${root}/app/vendor/autoload.php`]);
    expect(result.queryBudget?.methods[0]?.upperBound).toBe(5);
    expect(result.runs).toHaveLength(3);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "an insight failure still returns ordinary checks and explicitly failed insight status",
  () =>
    Effect.gen(function* () {
      const root = yield* insightSetup;
      const result = yield* Effect.flatMap(
        MonolithAnalyzerService.MonolithAnalyzerService,
        (service) => service.checkFile({ cwd: root, path: "app/src/Test.php" }),
      ).pipe(
        Effect.provide(
          serviceLayer(passed, () =>
            Effect.fail(new PhpInsightsExecution.PhpInsightsExecutionError({ stage: "process" })),
          ),
        ),
      );
      expect(result.queryBudget?.status).toBe("failed");
      expect(result.entryChains?.status).toBe("failed");
      expect(result.runs.every((run) => run.status === "passed")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("discards insights when the opened source changes during a successful insight run", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) => service.checkFile({ cwd: root, path: "app/src/Test.php" }),
    ).pipe(
      Effect.provide(
        serviceLayer(passed, () =>
          write(root, "app/src/Test.php", "<?php changed();").pipe(
            Effect.orDie,
            Effect.as({
              queryBudget: { status: "complete" as const, methods: [] },
              entryChains: { status: "complete" as const, targets: [] },
            }),
            Effect.provide(NodeServices.layer),
          ),
        ),
      ),
    );
    expect(result.queryBudget).toBeUndefined();
    expect(result.entryChains).toBeUndefined();
    expect(result.runs.every((run) => run.status === "failed")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses the configured Docker runtime despite missing host vendor and extensions", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(`${root}/app/vendor`, { recursive: true });
    yield* write(
      root,
      "app/tools/composer.json",
      JSON.stringify({
        require: {
          "carthage-software/mago": "*",
          "byte-kitsune/mago-doctrine-query-budget": "*",
          "byte-kitsune/mago-architecture-graph": "*",
          "byte-kitsune/mago-symfony-wiring": "*",
        },
      }),
    );
    const runtime = { service: "php", composeDirectory: ".", containerPath: "/workspace/app" };
    yield* write(
      root,
      ".t3/monolith.json",
      JSON.stringify({
        version: 1,
        initialized: true,
        areas: [{ id: "php:app", name: "API", kind: "php", path: "app", magoDocker: runtime }],
      }),
    );
    const calls: AnalyzerExecution.AnalyzerExecutionInput[] = [];
    const insightCalls: PhpInsightsExecution.PhpInsightsInput[] = [];
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) => service.checkFile({ cwd: root, path: "app/src/Test.php" }),
    ).pipe(
      Effect.provide(
        serviceLayer(
          (input) => {
            calls.push(input);
            return passed();
          },
          (input) => {
            insightCalls.push(input);
            return Effect.succeed({
              queryBudget: { status: "complete", methods: [] },
              entryChains: { status: "complete", targets: [] },
            });
          },
        ),
      ),
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.runtime?.service === "php" && call.areaPath === "app")).toBe(
      true,
    );
    expect(insightCalls).toHaveLength(1);
    expect(insightCalls[0]).toMatchObject({ runtime, areaPath: "app" });
    expect(insightCalls[0]!.autoloadPaths).toContain(`${root}/app/tools/vendor/autoload.php`);
    expect(insightCalls[0]!.referencePath).toBe(`${root}/app/.mago/container-reference.dev.json`);
    expect(result.runs.every((run) => run.status === "passed")).toBe(true);
    expect(result.queryBudget?.status).toBe("complete");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("bounds formatter batches while retaining all files for analyze and guard", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(
      root,
      ".t3/monolith.json",
      JSON.stringify({
        version: 1,
        initialized: true,
        areas: [{ id: "backend", name: "Backend", path: "app", kind: "php" }],
      }),
    );
    const paths = Array.from({ length: 129 }, (_, index) => `app/src/File${index}.php`);
    for (const source of paths) yield* write(root, source, "<?php class Test {}\n");
    const checks: AnalyzerExecution.AnalyzerExecutionInput[] = [];
    yield* Effect.flatMap(MonolithAnalyzerService.MonolithAnalyzerService, (service) =>
      service.indexArea({ cwd: root, areaId: "backend", paths }),
    ).pipe(
      Effect.provide(
        serviceLayer((input) => {
          checks.push(input);
          return passed();
        }),
      ),
    );
    const format = checks.filter((check) => check.operation === "format");
    expect(format.map((check) => check.filePaths?.length)).toEqual([128, 1]);
    expect(
      format.flatMap((check) => check.filePaths ?? []).map((file) => file.slice(root.length + 1)),
    ).toEqual(paths);
    expect(
      checks
        .filter((check) => check.operation !== "format")
        .every((check) => check.filePaths?.length === 129),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("indexes PHP files with one analyze/guard and one shared companion run", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    yield* write(root, "app/src/Other.php", "<?php class Other {}");
    const checks: AnalyzerExecution.AnalyzerExecutionInput[] = [];
    const companions: PhpInsightsExecution.PhpInsightsInput[] = [];
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) =>
        service.indexArea({
          cwd: root,
          areaId: "backend",
          paths: ["app/src/Test.php", "app/src/Other.php"],
          snapshot: { key: "shared-snapshot", paths: ["app/src/Test.php", "app/src/Other.php"] },
        }),
    ).pipe(
      Effect.provide(
        serviceLayer(
          (input) => {
            checks.push(input);
            return passed();
          },
          (input) => {
            companions.push(input);
            const queryBudget = { status: "complete" as const, methods: [] };
            const entryChains = { status: "complete" as const, targets: [] };
            return Effect.succeed({
              queryBudget,
              entryChains,
              indexedFiles: input.indexPaths!.map((path) => ({ path, queryBudget, entryChains })),
            });
          },
        ),
      ),
    );
    expect(checks.map((input) => input.operation)).toEqual(["format", "analyze", "guard"]);
    expect(checks.every((input) => input.filePaths?.length === 2)).toBe(true);
    expect(companions).toHaveLength(1);
    expect(companions[0]?.snapshot).toEqual({
      key: "shared-snapshot",
      paths: ["app/src/Test.php", "app/src/Other.php"],
    });
    expect(companions[0]?.threads).toBe(1);
    expect(result.map((item) => item.path)).toEqual(["app/src/Test.php", "app/src/Other.php"]);
    expect(
      result.every(
        (item) =>
          item.result.revision.length === 64 && item.result.entryChains?.status === "complete",
      ),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inherits extension thresholds unless an explicit area override is present", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    for (const override of [false, true]) {
      yield* write(
        root,
        ".t3/monolith.json",
        JSON.stringify({
          version: 1,
          initialized: true,
          areas: [
            {
              id: "backend",
              name: "Backend",
              path: "app",
              kind: "php",
              ...(override ? { doctrineQueryThresholds: { warning: 8, error: 50 } } : {}),
            },
          ],
        }),
      );
      const result = yield* Effect.flatMap(
        MonolithAnalyzerService.MonolithAnalyzerService,
        (service) => service.checkFile({ cwd: root, path: "app/src/Test.php" }),
      ).pipe(
        Effect.provide(
          serviceLayer(passed, () =>
            Effect.succeed({
              queryBudget: { status: "complete", methods: [] },
              entryChains: { status: "complete", targets: [] },
              doctrineQueryThresholds: { warning: 12, error: 30 },
              doctrineQueryThresholdsSource: { kind: "extension", path: "app/.mago/extension.php" },
            }),
          ),
        ),
      );
      expect(result.doctrineQueryThresholds).toEqual(
        override ? { warning: 8, error: 50 } : { warning: 12, error: 30 },
      );
      expect(result.doctrineQueryThresholdsSource?.kind).toBe(override ? "override" : "extension");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("checks opened YAML through source inspection without native PHP operations", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    yield* write(root, "app/config/services.yaml", "password: secret\n");
    const calls: AnalyzerExecution.AnalyzerExecutionInput[] = [];
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) => service.checkFile({ cwd: root, path: "app/config/services.yaml" }),
    ).pipe(
      Effect.provide(
        serviceLayer(
          (input) => {
            calls.push(input);
            return passed();
          },
          () =>
            Effect.succeed({
              queryBudget: { status: "complete", methods: [] },
              entryChains: { status: "complete", targets: [] },
              security: {
                diagnostics: [
                  {
                    path: "app/config/services.yaml",
                    line: 1,
                    column: 11,
                    endLine: 1,
                    endColumn: 17,
                    severity: "error",
                    message: "Hardcoded secret",
                    ruleId: "byte-kitsune/symfony-wiring/no-hardcoded-secret",
                    tool: "mago",
                    operation: "check",
                  },
                ],
                run: { tool: "mago", operation: "check", status: "findings", diagnosticCount: 1 },
              },
            }),
        ),
      ),
    );
    expect(calls).toEqual([]);
    expect(result.diagnostics[0]?.operation).toBe("check");
    expect(result.runs.map((run) => run.operation)).toEqual(["check"]);
    expect(result.queryBudget).toBeUndefined();
    expect(result.entryChains).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("indexes mixed PHP and YAML while keeping native checks PHP-only", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    yield* write(root, "app/config/services.yaml", "password: secret\n");
    const calls: AnalyzerExecution.AnalyzerExecutionInput[] = [];
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) =>
        service.indexArea({
          cwd: root,
          areaId: "backend",
          paths: ["app/config/services.yaml", "app/src/Test.php"],
        }),
    ).pipe(
      Effect.provide(
        serviceLayer(
          (input) => {
            calls.push(input);
            return passed();
          },
          () =>
            Effect.succeed({
              queryBudget: { status: "complete", methods: [] },
              entryChains: { status: "complete", targets: [] },
              security: {
                diagnostics: [],
                run: { tool: "mago", operation: "check", status: "passed", diagnosticCount: 0 },
              },
            }),
        ),
      ),
    );
    expect(calls).toHaveLength(3);
    expect(
      calls.every(
        (call) =>
          call.filePath.endsWith(".php") &&
          (call.filePaths ?? []).every((file) => file.endsWith(".php")),
      ),
    ).toBe(true);
    expect(result[0]?.result.runs.map((run) => run.operation)).toEqual(["check"]);
    expect(result[0]?.result.queryBudget).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("loads the tools SDK autoloader for a Symfony-only configuration check", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(
      root,
      "app/tools/composer.json",
      JSON.stringify({
        require: { "carthage-software/mago": "*", "byte-kitsune/mago-symfony-wiring": "*" },
      }),
    );
    yield* write(root, "app/tools/vendor/autoload.php", "<?php");
    yield* write(root, "app/tools/vendor/bin/mago", "fixture");
    yield* write(
      root,
      "app/tools/vendor/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
      "<?php",
    );
    yield* write(root, "app/config/services.yaml", "password: secret\n");
    const calls: PhpInsightsExecution.PhpInsightsInput[] = [];
    yield* Effect.flatMap(MonolithAnalyzerService.MonolithAnalyzerService, (service) =>
      service.checkFile({ cwd: root, path: "app/config/services.yaml" }),
    ).pipe(
      Effect.provide(
        serviceLayer(passed, (input) => {
          calls.push(input);
          return Effect.succeed({
            queryBudget: { status: "unavailable", methods: [] },
            entryChains: { status: "unavailable", targets: [] },
            security: { diagnostics: [] },
          });
        }),
      ),
    );
    expect(calls[0]?.autoloadPaths).toContain(`${root}/app/tools/vendor/autoload.php`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reserves opened-file capacity while background batches are blocked and queued", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, "app/src/Foreground.php", "<?php class Foreground {}\n");
    const started = yield* Deferred.make<void>();
    const queued = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let backgroundStarts = 0;
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      const background = () =>
        service.indexArea({ cwd: root, areaId: "php:app", paths: ["app/src/Test.php"] });
      const first = yield* background().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* Effect.gen(function* () {
        yield* Deferred.succeed(queued, undefined);
        return yield* background();
      }).pipe(Effect.forkChild);
      yield* Deferred.await(queued);
      const opened = yield* service.checkFile({ cwd: root, path: "app/src/Foreground.php" });
      expect(opened.runs.map((run) => run.status)).toEqual(["passed", "passed", "passed"]);
      expect(backgroundStarts).toBe(1);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(first))[0]?.path).toBe("app/src/Test.php");
      expect((yield* Fiber.join(second))[0]?.path).toBe("app/src/Test.php");
      expect(backgroundStarts).toBe(2);
    }).pipe(
      Effect.provide(
        serviceLayer(
          Effect.fnUntraced(function* (input) {
            if (input.filePath.endsWith("/Test.php") && input.operation === "format") {
              backgroundStarts++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return { diagnostics: [], exitCode: 0, status: "passed" as const };
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("pauses subsequent background phases until an opened file has completed", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, "app/src/Foreground.php", "<?php class Foreground {}\n");
    const backgroundStarted = yield* Deferred.make<void>();
    const foregroundStarted = yield* Deferred.make<void>();
    const releaseBackground = yield* Deferred.make<void>();
    const releaseForeground = yield* Deferred.make<void>();
    const backgroundReleased = yield* Deferred.make<void>();
    const order: string[] = [];
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      const background = yield* service
        .indexArea({
          cwd: root,
          areaId: "php:app",
          paths: ["app/src/Test.php"],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(backgroundStarted);
      const opened = yield* service
        .checkFile({ cwd: root, path: "app/src/Foreground.php" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(foregroundStarted);
      yield* Deferred.succeed(releaseBackground, undefined);
      yield* Deferred.await(backgroundReleased);
      yield* Deferred.succeed(releaseForeground, undefined);
      expect((yield* Fiber.join(opened)).runs).toHaveLength(3);
      expect((yield* Fiber.join(background))[0]?.result.runs).toHaveLength(3);
      expect(order).toEqual([
        "background:format",
        "foreground:format",
        "foreground:analyze",
        "foreground:guard",
        "background:analyze",
        "background:guard",
      ]);
    }).pipe(
      Effect.provide(
        serviceLayer(
          Effect.fnUntraced(function* (input) {
            const foreground = input.filePath.endsWith("/Foreground.php");
            order.push(`${foreground ? "foreground" : "background"}:${input.operation}`);
            if (input.operation === "format") {
              if (foreground) {
                yield* Deferred.succeed(foregroundStarted, undefined);
                yield* Deferred.await(releaseForeground);
              } else {
                yield* Deferred.succeed(backgroundStarted, undefined);
                yield* Deferred.await(releaseBackground);
                yield* Deferred.succeed(backgroundReleased, undefined);
              }
            }
            return { diagnostics: [], exitCode: 0, status: "passed" as const };
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an opened file in another workspace does not queue behind a long file check", () =>
  Effect.gen(function* () {
    const firstRoot = yield* setup;
    const secondRoot = yield* setup;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      const first = yield* service
        .checkFile({ cwd: firstRoot, path: "app/src/Test.php" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* service.checkFile({ cwd: secondRoot, path: "app/src/Test.php" });
      expect(second.runs.map((run) => run.status)).toEqual(["passed", "passed", "passed"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        serviceLayer(
          Effect.fnUntraced(function* (input) {
            if (input.workspaceRoot === firstRoot && input.operation === "format") {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return { diagnostics: [], exitCode: 0, status: "passed" as const };
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("releases background priority when an opened-file request is canceled", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, "app/src/Foreground.php", "<?php class Foreground {}\n");
    const backgroundStarted = yield* Deferred.make<void>();
    const foregroundStarted = yield* Deferred.make<void>();
    const releaseBackground = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      const background = yield* service
        .indexArea({
          cwd: root,
          areaId: "php:app",
          paths: ["app/src/Test.php"],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(backgroundStarted);
      const opened = yield* service
        .checkFile({ cwd: root, path: "app/src/Foreground.php" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(foregroundStarted);
      yield* Fiber.interrupt(opened);
      yield* Deferred.succeed(releaseBackground, undefined);
      expect((yield* Fiber.join(background))[0]?.result.runs.map((run) => run.status)).toEqual([
        "passed",
        "passed",
        "passed",
      ]);
    }).pipe(
      Effect.provide(
        serviceLayer(
          Effect.fnUntraced(function* (input) {
            if (input.operation === "format") {
              if (input.filePath.endsWith("/Foreground.php")) {
                yield* Deferred.succeed(foregroundStarted, undefined);
                return yield* Effect.never;
              } else {
                yield* Deferred.succeed(backgroundStarted, undefined);
                yield* Deferred.await(releaseBackground);
              }
            }
            return { diagnostics: [], exitCode: 0, status: "passed" as const };
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reuses full-snapshot Mago analyze and guard reports across indexing batches", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, "app/src/Other.php", "<?php class Other {}\n");
    const paths = ["app/src/Test.php", "app/src/Other.php"];
    const calls: AnalyzerExecution.AnalyzerExecutionInput[] = [];
    const diagnostic = {
      path: "app/src/Other.php",
      line: 1,
      severity: "error" as const,
      message: "Invalid return type",
      ruleId: "invalid-return",
      tool: "mago" as const,
      operation: "analyze" as const,
    };
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      const batch = (source: string, key: string) =>
        service.indexArea({
          cwd: root,
          areaId: "php:app",
          paths: [source],
          snapshot: { key, paths },
        });
      const first = yield* batch(paths[0]!, "snapshot-1");
      const second = yield* batch(paths[1]!, "snapshot-1");
      expect(first[0]?.result.diagnostics).toEqual([]);
      expect(second[0]?.result.diagnostics).toEqual([diagnostic]);
      expect(second[0]?.result.runs.find((run) => run.operation === "analyze")?.status).toBe(
        "findings",
      );
      expect(calls.map((call) => call.operation)).toEqual(["format", "analyze", "guard", "format"]);
      expect(
        calls
          .filter((call) => call.operation !== "format")
          .every((call) => call.filePaths?.length === 2 && call.threads === 1),
      ).toBe(true);
      yield* batch(paths[0]!, "snapshot-2");
      expect(calls.map((call) => call.operation)).toEqual([
        "format",
        "analyze",
        "guard",
        "format",
        "format",
        "analyze",
        "guard",
      ]);
      yield* service.checkFile({ cwd: root, path: paths[0]! });
      expect(calls.slice(-3).every((call) => call.threads === 2)).toBe(true);
      expect(calls.slice(-3).map((call) => call.operation)).toEqual(["format", "analyze", "guard"]);
    }).pipe(
      Effect.provide(
        serviceLayer((input) => {
          calls.push(input);
          return Effect.succeed({
            diagnostics: input.operation === "analyze" ? [diagnostic] : [],
            exitCode: 0,
            status: input.operation === "analyze" ? ("findings" as const) : ("passed" as const),
          });
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a React snapshot containing a file from another area before running tools", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(
      root,
      ".t3/monolith.json",
      JSON.stringify({
        version: 1,
        initialized: true,
        areas: [
          { id: "ui", name: "UI", path: "ui", kind: "react" },
          { id: "backend", name: "Backend", path: "app", kind: "php" },
        ],
      }),
    );
    yield* write(root, "ui/app/A.js", "export const a = 1;\n");
    const output = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) =>
        service
          .indexArea({
            cwd: root,
            areaId: "ui",
            paths: ["ui/app/A.js"],
            snapshot: { key: "unsafe-react", paths: ["ui/app/A.js", "app/src/Test.php"] },
          })
          .pipe(Effect.result),
    ).pipe(Effect.provide(serviceLayer(() => Effect.die("Must not execute cross-area snapshots"))));
    expect(output._tag).toBe("Failure");
    if (output._tag === "Failure") expect(output.failure.reason).toBe("unsafe_path");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a full snapshot that includes files outside its PHP area", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const result = yield* Effect.flatMap(
      MonolithAnalyzerService.MonolithAnalyzerService,
      (service) =>
        service
          .indexArea({
            cwd: root,
            areaId: "php:app",
            paths: ["app/src/Test.php"],
            snapshot: { key: "unsafe", paths: ["app/src/Test.php", "../outside.php"] },
          })
          .pipe(Effect.result),
    ).pipe(Effect.provide(serviceLayer(() => Effect.die("Must not execute unsafe snapshots"))));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("unsafe_path");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not repeat failed PHP native processes for each unchanged snapshot batch", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    yield* write(root, "app/src/Other.php", "<?php class Other {}\n");
    const paths = ["app/src/Test.php", "app/src/Other.php"];
    let insightCalls = 0;
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      const batch = (source: string, key: string) =>
        service.indexArea({
          cwd: root,
          areaId: "backend",
          paths: [source],
          snapshot: { key, paths },
        });
      const first = yield* batch(paths[0]!, "failed-cycle-1");
      const second = yield* batch(paths[1]!, "failed-cycle-1");
      expect(first[0]?.result.queryBudget?.status).toBe("failed");
      expect(second[0]?.result.queryBudget?.status).toBe("failed");
      expect(insightCalls).toBe(1);
      yield* batch(paths[0]!, "failed-cycle-2");
      expect(insightCalls).toBe(2);
      yield* batch(paths[1]!, "failed-cycle-2");
      expect(insightCalls).toBe(2);
      yield* service.checkFile({ cwd: root, path: paths[0]! });
      expect(insightCalls).toBe(3);
    }).pipe(
      Effect.provide(
        serviceLayer(passed, () => {
          insightCalls++;
          return Effect.fail(
            new PhpInsightsExecution.PhpInsightsExecutionError({
              stage: insightCalls === 1 ? "process" : "config",
            }),
          );
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries file-specific PHP report failures in subsequent snapshot batches", () =>
  Effect.gen(function* () {
    const root = yield* insightSetup;
    yield* write(root, "app/src/Other.php", "<?php class Other {}\n");
    const paths = ["app/src/Test.php", "app/src/Other.php"];
    let insightCalls = 0;
    yield* Effect.gen(function* () {
      const service = yield* MonolithAnalyzerService.MonolithAnalyzerService;
      for (const source of paths)
        yield* service.indexArea({
          cwd: root,
          areaId: "backend",
          paths: [source],
          snapshot: { key: "report-cycle", paths },
        });
      expect(insightCalls).toBe(2);
    }).pipe(
      Effect.provide(
        serviceLayer(passed, () => {
          insightCalls++;
          return Effect.fail(
            new PhpInsightsExecution.PhpInsightsExecutionError({ stage: "report" }),
          );
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
