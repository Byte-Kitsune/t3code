import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as MagoDockerExecution from "./MagoDockerExecution.ts";
import * as AnalyzerExecution from "./AnalyzerExecution.ts";

const base = {
  tool: "mago",
  operation: "analyze",
  command: "/repo/app/vendor/bin/mago",
  cwd: "/repo/app",
  workspaceRoot: "/repo",
  filePath: "/repo/app/src/Test.php",
} as const;

function runWith(
  stdout: string,
  code = 0,
  input: AnalyzerExecution.AnalyzerExecutionInput = base,
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
  docker?: MagoDockerExecution.MagoDockerExecution["Service"],
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (request) => {
      calls.push(request);
      return Effect.succeed({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(code),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
        ...overrides,
      });
    },
  });
  const effect = Effect.gen(function* () {
    const execution = yield* AnalyzerExecution.AnalyzerExecution;
    return yield* execution.run(input);
  }).pipe(
    Effect.provide(
      AnalyzerExecution.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Path.layer,
            Layer.succeed(ProcessRunner.ProcessRunner, runner),
            ...(docker ? [Layer.succeed(MagoDockerExecution.MagoDockerExecution, docker)] : []),
          ),
        ),
      ),
    ),
  );
  return { effect, calls };
}

function issue(file: string, level = "Error", line = 3) {
  return {
    message: "Wrong type",
    code: "invalid-argument",
    level,
    annotations: [
      {
        kind: "Primary",
        span: { file_id: { path: file }, start: { line, column: 4 }, end: { line, column: 8 } },
      },
    ],
  };
}

describe("AnalyzerExecution", () => {
  it.effect(
    "preserves full PHP context while selecting the opened file and zero-based positions",
    () =>
      Effect.gen(function* () {
        const { effect, calls } = runWith(
          JSON.stringify({
            issues: [issue("src/Test.php"), issue("src/Other.php"), issue("../../outside.php")],
          }),
          1,
        );
        const result = yield* effect;
        expect(result.diagnostics).toEqual([
          {
            path: "app/src/Test.php",
            line: 4,
            column: 5,
            endLine: 4,
            endColumn: 9,
            severity: "error",
            message: "Wrong type",
            ruleId: "invalid-argument",
            tool: "mago",
            operation: "analyze",
          },
        ]);
        expect(calls[0]?.args).not.toContain(base.filePath);
        expect(calls[0]?.outputMode).toBe("error");
        expect(calls[0]?.timeout).toBe(60_000);
      }),
  );

  it.effect("places Mago config before guard and never enables fixes", () =>
    Effect.gen(function* () {
      const { effect, calls } = runWith('{"issues":[]}', 0, {
        ...base,
        operation: "guard",
        configPath: "/repo/app/mago.toml",
      });
      const result = yield* effect;
      expect(result.status).toBe("passed");
      expect(calls[0]?.args.slice(0, 3)).toEqual(["--config", "/repo/app/mago.toml", "guard"]);
      expect(calls[0]?.args).not.toContain("--fix");
    }),
  );

  it.effect("reports format changes at original source lines using a read-only dry run", () =>
    Effect.gen(function* () {
      const { effect, calls } = runWith(
        "--- a/src/Test.php\n+++ b/src/Test.php\n@@ -3,2 +3,2 @@\n same\n- old\n+ new\n",
        0,
        { ...base, operation: "format" },
      );
      const result = yield* effect;
      expect(result.status).toBe("findings");
      expect(result.diagnostics.map((item) => item.line)).toEqual([4]);
      expect(calls[0]?.args).toEqual(["format", "--dry-run", base.filePath]);
      expect(calls[0]?.args).not.toContain("--check");
    }),
  );

  it.effect("normalizes Biome JSON diagnostics and keeps file scope", () =>
    Effect.gen(function* () {
      const { effect, calls } = runWith(
        JSON.stringify({
          diagnostics: [
            {
              message: "Unused variable",
              severity: "WARNING",
              category: "lint/correctness/noUnusedVariables",
              location: {
                path: "src/Test.tsx",
                start: { line: 2, column: 8 },
                end: { line: 2, column: 9 },
              },
            },
          ],
        }),
        1,
        {
          ...base,
          tool: "biome",
          operation: "check",
          command: "/repo/app/node_modules/.bin/biome",
          filePath: "/repo/app/src/Test.tsx",
        },
      );
      const result = yield* effect;
      expect(result.diagnostics[0]).toMatchObject({
        path: "app/src/Test.tsx",
        line: 2,
        column: 8,
        severity: "warning",
        ruleId: "lint/correctness/noUnusedVariables",
      });
      expect(calls[0]?.args).toContain("--reporter=json");
      expect(calls[0]?.args).not.toContain("--write");
    }),
  );

  it.effect("does not turn malformed output or CLI errors into clean checks", () =>
    Effect.gen(function* () {
      const malformed = yield* runWith("not JSON").effect.pipe(Effect.flip);
      expect(malformed.category).toBe("report");
      const failed = yield* runWith('{"issues":[]}', 2).effect.pipe(Effect.flip);
      expect(failed.category).toBe("exit");
    }),
  );

  it.effect("maps legacy Biome byte offsets with Unicode source text", () =>
    Effect.gen(function* () {
      const { effect } = runWith(
        JSON.stringify({
          diagnostics: [
            {
              severity: "warning",
              message: "Unused value",
              category: "lint/test",
              location: { path: { file: "src/Test.tsx" }, span: [5, 6] },
            },
          ],
        }),
        1,
        {
          ...base,
          tool: "biome",
          operation: "check",
          filePath: "/repo/app/src/Test.tsx",
          sourceText: "é\nabc",
        },
      );
      const result = yield* effect;
      expect(result.diagnostics[0]).toMatchObject({ line: 2, column: 3, endLine: 2, endColumn: 4 });
    }),
  );

  it.effect("keeps native formatter diagnostics on a real first line and preserves severity", () =>
    Effect.gen(function* () {
      const { effect } = runWith(
        JSON.stringify({
          diagnostics: [
            {
              severity: "error",
              message: "Would format",
              category: "format",
              location: {
                path: "src/Test.tsx",
                start: { line: 0, column: 0 },
                end: { line: 0, column: 0 },
              },
            },
          ],
        }),
        1,
        { ...base, tool: "biome", operation: "check", filePath: "/repo/app/src/Test.tsx" },
      );
      expect((yield* effect).diagnostics[0]).toMatchObject({
        line: 1,
        column: 1,
        severity: "error",
      });
    }),
  );

  it.effect("fails unlocated project errors and refuses partial machine reports", () =>
    Effect.gen(function* () {
      const missing = yield* runWith(
        JSON.stringify({
          issues: [
            { level: "Error", message: "Missing Symfony container reference", annotations: [] },
          ],
        }),
        1,
      ).effect.pipe(Effect.flip);
      expect(missing.category).toBe("report");
      const partial = yield* runWith('{"issues":[]}', 0, base, {
        stdoutTruncated: true,
      }).effect.pipe(Effect.flip);
      expect(partial.category).toBe("output");
    }),
  );

  it.effect("does not render successful Symfony attestation as a source defect", () =>
    Effect.gen(function* () {
      const attestation = {
        ...issue("src/Test.php", "Note"),
        code: "byte-kitsune/symfony-wiring/analysis-attestation",
      };
      expect(
        (yield* runWith(JSON.stringify({ issues: [attestation] })).effect).diagnostics,
      ).toEqual([]);
    }),
  );

  it.effect("rejects unsupported operation pairs and workspace escape before spawning", () =>
    Effect.gen(function* () {
      const pair = runWith('{"issues":[]}', 0, { ...base, tool: "biome" });
      expect((yield* pair.effect.pipe(Effect.flip)).category).toBe("input");
      expect(pair.calls).toEqual([]);
      const escaped = runWith('{"issues":[]}', 0, { ...base, filePath: "/other/Test.php" });
      expect((yield* escaped.effect.pipe(Effect.flip)).category).toBe("input");
      expect(escaped.calls).toEqual([]);
    }),
  );
});

it.effect(
  "runs Docker Mago without a host binary and maps container diagnostics to the opened checkout file",
  () =>
    Effect.gen(function* () {
      const captured: string[][] = [];
      const resultOutput = {
        stdout: JSON.stringify({
          issues: [
            issue("/srv/api/src/Test.php"),
            issue("src/Other.php"),
            issue("/opt/vendor/Library.php"),
          ],
        }),
        stderr: "",
        code: ChildProcessSpawner.ExitCode(1),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
      const docker = MagoDockerExecution.MagoDockerExecution.of({
        prepare: (request) => {
          expect(request.areaPath).toBe("app");
          return Effect.succeed({
            hostAreaRoot: "/repo/app",
            containerAreaRoot: "/srv/api",
            toContainer: (path) => path.replace("/repo/app", "/srv/api"),
            toHost: (path) => {
              if (!path.startsWith("/srv/api/")) throw new Error("Outside mount");
              return path.replace("/srv/api", "/repo/app");
            },
            runMago: (args) => {
              captured.push([...args]);
              return Effect.succeed(resultOutput);
            },
            runPhp: () => Effect.die("Unused"),
            exists: () => Effect.succeed(true),
            allocateTemp: Effect.die("Unused"),
          });
        },
      });
      const { effect, calls: hostCalls } = runWith(
        "",
        0,
        {
          ...base,
          command: "mago",
          configPath: "/repo/app/mago.toml",
          areaPath: "app",
          runtime: { service: "php" },
        },
        {},
        docker,
      );
      const result = yield* effect;
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]!.path).toBe("app/src/Test.php");
      expect(captured[0]).toContain("/srv/api/mago.toml");
      expect(captured[0]).not.toContain("/srv/api/src/Test.php");
      expect(hostCalls).toEqual([]);
    }),
);
