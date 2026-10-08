import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
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
  yield* fs.writeFileString(`${root}/app/mago.toml`, '[source]\npaths=["src"]');
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
function mockRunner(
  options: {
    malformedQuery?: boolean;
    missingGraph?: boolean;
    changeSource?: boolean;
    changeConfig?: boolean;
    changeConfigDuringRead?: boolean;
    differentWorkspace?: boolean;
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
            "extension-hosts": { original: { command: ["do-not-run"] } },
          }),
        );
      }
      temporaryInput = input.env?.T3_PHP_INSIGHTS_INPUT;
      const data = decode(yield* fs.readFileString(temporaryInput!)) as Record<string, string>;
      const config = decode(yield* fs.readFileString(input.args[1]!)) as {
        source: { paths: string[] };
        analyzer: { ignore: string[] };
        threads: number;
        "extension-hosts": Record<string, unknown>;
      };
      expect(config.source.paths).toEqual(["src", "shared"]);
      expect(config.analyzer.ignore).toEqual(["mixed-argument"]);
      expect(config.threads).toBe(2);
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
      if (!options.missingGraph)
        yield* fs.writeFileString(
          data.graphOutput!,
          encode({ status: "unavailable", message: "No graph extension installed." }),
        );
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
