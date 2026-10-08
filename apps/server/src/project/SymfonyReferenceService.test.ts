import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as MagoDockerExecution from "../analyzers/MagoDockerExecution.ts";
import * as AnalyzerDiscoveryService from "./AnalyzerDiscoveryService.ts";
import * as MonolithService from "./MonolithService.ts";
import * as SymfonyReferenceService from "./SymfonyReferenceService.ts";

const base = Layer.mergeAll(MonolithService.layer, AnalyzerDiscoveryService.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const write = Effect.fnUntraced(function* (root: string, relative: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const target = paths.join(root, relative);
  yield* fs.makeDirectory(paths.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, content);
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-symfony-reference-test-" });
  yield* write(root, "api/composer.json", "{}");
  yield* write(
    root,
    "api/tools/composer.json",
    JSON.stringify({
      require: { "carthage-software/mago": "*", "byte-kitsune/mago-symfony-wiring": "*" },
    }),
  );
  yield* write(
    root,
    "api/tools/vendor/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
    "<?php",
  );
  yield* write(root, "api/vendor/autoload.php", "<?php");
  yield* write(root, "api/bin/console", "<?php");
  yield* write(root, "api/.mago/container-reference.dev.json", '{"previous":true}');
  return root;
});
const runWith = (
  cwd: string,
  calls: Array<ProcessRunner.ProcessRunInput>,
  outputs: ReadonlyArray<{ stdout: string; code?: number }>,
  docker?: MagoDockerExecution.MagoDockerExecution["Service"],
) => {
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      const output = outputs[calls.length] ?? { stdout: "{}" };
      calls.push(input);
      return Effect.succeed({
        stdout: output.stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(output.code ?? 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    },
  });
  return Effect.gen(function* () {
    return yield* (yield* SymfonyReferenceService.SymfonyReferenceService).generate({
      cwd,
      areaId: "php:api",
    });
  }).pipe(
    Effect.provide(
      SymfonyReferenceService.layer.pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(
          Layer.succeed(
            MagoDockerExecution.MagoDockerExecution,
            docker ??
              MagoDockerExecution.MagoDockerExecution.of({
                prepare: () => Effect.die("Unexpected Docker process"),
              }),
          ),
        ),
      ),
    ),
  );
};

it.layer(base)("SymfonyReferenceService", (it) => {
  it.effect("exports through container PHP and stages JSON when host vendor is absent", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${root}/api/vendor`, { recursive: true });
      yield* fs.remove(`${root}/api/tools/vendor`, { recursive: true });
      yield* write(
        root,
        ".t3/monolith.json",
        JSON.stringify({
          version: 1,
          initialized: true,
          areas: [
            {
              id: "php:api",
              name: "API",
              path: "api",
              kind: "php",
              magoDocker: { service: "php" },
            },
          ],
        }),
      );
      const calls: Array<ProcessRunner.ProcessRunInput> = [];
      const remoteCalls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
      const staged = new Map<string, string>();
      let removed = false;
      const transport = MagoDockerExecution.MagoDockerExecution.of({
        prepare: (input) => {
          expect(input.runtime.service).toBe("php");
          expect(input.areaPath).toBe("api");
          return Effect.succeed({
            hostAreaRoot: `${root}/api`,
            containerAreaRoot: "/srv/api",
            toContainer: (path) => path.replace(root, "/srv"),
            toHost: (path) => path.replace("/srv", root),
            runMago: () => Effect.die("Unexpected Mago process"),
            exists: () => Effect.succeed(true),
            allocateTemp: Effect.acquireRelease(
              Effect.succeed({
                path: "/tmp/t3-reference",
                write: (name, content) =>
                  Effect.sync(() => {
                    staged.set(name, content);
                  }),
                read: () => Effect.die("Unexpected staged read"),
              }),
              () =>
                Effect.sync(() => {
                  removed = true;
                }),
            ),
            runPhp: (args, env) => {
              remoteCalls.push({ args, ...(env ? { env } : {}) });
              return Effect.succeed({
                stdout: remoteCalls.length === 3 ? '{"reference":"container"}' : "{}",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          });
        },
      });
      const result = yield* runWith(root, calls, [], transport);
      expect(calls).toEqual([]);
      expect(remoteCalls).toHaveLength(3);
      expect(remoteCalls[0]!.args[0]).toBe("/srv/api/bin/console");
      expect(remoteCalls[2]!.args).toEqual([
        "/srv/api/tools/vendor/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
        "--types=/tmp/t3-reference/types.json",
        "--services=/tmp/t3-reference/services.json",
        "--autoload=/srv/api/vendor/autoload.php",
      ]);
      expect(staged).toEqual(
        new Map([
          ["types.json", "{}"],
          ["services.json", "{}"],
        ]),
      );
      expect(removed).toBe(true);
      expect(yield* fs.readFileString(`${root}/${result.path}`)).toBe(
        '{"reference":"container"}\n',
      );
    }),
  );

  it.effect(
    "keeps the previous reference when the configured container service is unavailable",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        yield* write(
          root,
          ".t3/monolith.json",
          JSON.stringify({
            version: 1,
            initialized: true,
            areas: [
              {
                id: "php:api",
                name: "API",
                path: "api",
                kind: "php",
                magoDocker: { service: "php" },
              },
            ],
          }),
        );
        const calls: Array<ProcessRunner.ProcessRunInput> = [];
        const error = yield* runWith(
          root,
          calls,
          [],
          MagoDockerExecution.MagoDockerExecution.of({
            prepare: () =>
              Effect.fail(new MagoDockerExecution.MagoDockerError({ stage: "service" })),
          }),
        ).pipe(Effect.flip);
        expect(error.stage).toBe("prerequisites");
        expect(error.message).toContain("Start the configured Docker Compose service");
        expect(calls).toEqual([]);
        expect(
          yield* (yield* FileSystem.FileSystem).readFileString(
            `${root}/api/.mago/container-reference.dev.json`,
          ),
        ).toBe('{"previous":true}');
      }),
  );

  it.effect(
    "exports dev types and services through direct PHP commands and atomically replaces the reference",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const calls: Array<ProcessRunner.ProcessRunInput> = [];
        const result = yield* runWith(root, calls, [
          { stdout: '{"types":[]}' },
          { stdout: '{"services":[]}' },
          { stdout: '{"reference":"dev"}' },
        ]);
        expect(result).toEqual({
          areaId: "php:api",
          path: "api/.mago/container-reference.dev.json",
        });
        expect(calls).toHaveLength(3);
        expect(calls[0]!.args).toContain("--types");
        expect(calls[1]!.args).not.toContain("--types");
        for (const call of calls) {
          expect(call.command).toBe("php");
          expect(call.cwd).toBe(paths.join(root, "api"));
          expect(call.timeout).toBe(60_000);
          expect(call.maxOutputBytes).toBe(4_000_000);
          expect(call.args).not.toContain("--show-hidden");
        }
        expect(calls[0]!.args).toContain("--env=dev");
        expect(calls[2]!.args[0]).toBe(
          paths.join(
            root,
            "api/tools/vendor/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
          ),
        );
        expect(calls[2]!.args).toContain(
          `--autoload=${paths.join(root, "api/vendor/autoload.php")}`,
        );
        expect(yield* fs.readFileString(paths.join(root, result.path))).toBe(
          '{"reference":"dev"}\n',
        );
        const typesPath = calls[2]!.args.find((arg) => arg.startsWith("--types="))!.slice(8);
        // The reference API does not expose raw Symfony container arguments.
        expect(yield* fs.exists(typesPath)).toBe(false);
        expect(yield* fs.readDirectory(paths.join(root, "api/.mago"))).toEqual([
          "container-reference.dev.json",
        ]);
      }),
  );

  it.effect("leaves the old reference untouched when the container command fails", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const calls: Array<ProcessRunner.ProcessRunInput> = [];
      const error = yield* runWith(root, calls, [{ stdout: "{}" }, { stdout: "{}", code: 1 }]).pipe(
        Effect.flip,
      );
      expect(error.stage).toBe("services");
      expect(calls).toHaveLength(2);
      expect(
        yield* fs.readFileString(paths.join(root, "api/.mago/container-reference.dev.json")),
      ).toBe('{"previous":true}');
    }),
  );

  it.effect("rejects malformed exporter output before publication", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const calls: Array<ProcessRunner.ProcessRunInput> = [];
      const error = yield* runWith(root, calls, [
        { stdout: "{}" },
        { stdout: "{}" },
        { stdout: "PHP warning: unexpected output" },
      ]).pipe(Effect.flip);
      expect(error.stage).toBe("export");
      expect(
        yield* fs.readFileString(paths.join(root, "api/.mago/container-reference.dev.json")),
      ).toBe('{"previous":true}');
    }),
  );

  it.effect("rejects linked reference destinations before running application PHP", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-symfony-outside-" });
      yield* write(outside, "reference.json", '{"outside":true}');
      yield* fs.remove(paths.join(root, "api/.mago/container-reference.dev.json"));
      yield* fs.symlink(
        paths.join(outside, "reference.json"),
        paths.join(root, "api/.mago/container-reference.dev.json"),
      );
      const calls: Array<ProcessRunner.ProcessRunInput> = [];
      const error = yield* runWith(root, calls, []).pipe(Effect.flip);
      expect(error.stage).toBe("prerequisites");
      expect(calls).toHaveLength(0);
      expect(yield* fs.readFileString(paths.join(outside, "reference.json"))).toBe(
        '{"outside":true}',
      );
    }),
  );
  it.effect("serializes concurrent generation requests through the service", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const stages: Array<string> = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            stages.push(
              input.args[0]!.endsWith("create-container-reference.php")
                ? "export"
                : input.args.includes("--types")
                  ? "types"
                  : "services",
            );
            yield* Effect.yieldNow;
            return {
              stdout: "{}",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      const results = yield* Effect.gen(function* () {
        const service = yield* SymfonyReferenceService.SymfonyReferenceService;
        return yield* Effect.all(
          [
            service.generate({ cwd: root, areaId: "php:api" }),
            service.generate({ cwd: root, areaId: "php:api" }),
          ],
          { concurrency: "unbounded" },
        );
      }).pipe(
        Effect.provide(
          SymfonyReferenceService.layer.pipe(
            Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
          ),
        ),
      );
      expect(results).toHaveLength(2);
      expect(stages).toEqual(["types", "services", "export", "types", "services", "export"]);
    }),
  );
});
