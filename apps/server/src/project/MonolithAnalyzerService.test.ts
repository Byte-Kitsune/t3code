import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as AnalyzerExecution from "../analyzers/AnalyzerExecution.ts";
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
function serviceLayer(run: AnalyzerExecution.AnalyzerExecution["Service"]["run"]) {
  return Layer.fresh(MonolithAnalyzerService.layer).pipe(
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
    expect(yield* fs.exists(`${root}/t3.monolith.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(serviceLayer(() => Effect.die("unexpected execution")))),
);

it.effect("disabled and arbitrary folder groups do not execute language analyzers", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(
      root,
      "t3.monolith.json",
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
      "t3.monolith.json",
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
