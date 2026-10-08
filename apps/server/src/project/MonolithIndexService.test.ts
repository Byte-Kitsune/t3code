import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { MonolithArea, MonolithCheckFileResult, MonolithConfig } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as MonolithAnalyzerService from "./MonolithAnalyzerService.ts";
import * as MonolithIndexService from "./MonolithIndexService.ts";
import * as MonolithService from "./MonolithService.ts";

const php: MonolithArea = { id: "api", name: "API", path: "api", kind: "php" };
const result = (areaId: string, revision: string): MonolithCheckFileResult => ({
  areaId,
  revision,
  diagnostics: [],
  runs: [{ tool: "mago", operation: "analyze", status: "passed", diagnosticCount: 0 }],
});
const write = Effect.fnUntraced(function* (root: string, relative: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, relative);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, contents);
});
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-" });
  yield* write(root, "api/src/Demo.php", "<?php class Demo {}\n");
  yield* write(root, "api/src/Caller.php", "<?php class Caller {}\n");
  yield* write(root, "api/composer.json", "{}");
  return root;
});
const hashFile = Effect.fnUntraced(function* (root: string, relative: string) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(
    yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(yield* fs.readFileString(`${root}/${relative}`)),
    ),
  );
});
const batch = Effect.fnUntraced(function* (input: {
  cwd: string;
  areaId: string;
  paths: readonly string[];
}) {
  return yield* Effect.forEach(input.paths, (path) =>
    hashFile(input.cwd, path).pipe(
      Effect.map((hash) => ({ path, result: result(input.areaId, hash) })),
    ),
  );
});
function serviceLayer(
  getAreas: () => readonly MonolithArea[],
  indexArea: (
    input: Parameters<MonolithAnalyzerService.MonolithAnalyzerService["Service"]["indexArea"]>[0],
  ) => Effect.Effect<
    readonly { path: string; result: MonolithCheckFileResult }[],
    MonolithAnalyzerService.MonolithAnalyzerError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
  checkFile: MonolithAnalyzerService.MonolithAnalyzerService["Service"]["checkFile"] = (input) =>
    hashFile(input.cwd, input.path).pipe(
      Effect.map((hash) =>
        result(
          getAreas().find((area) => input.path.startsWith(`${area.path}/`))?.id ?? "api",
          hash,
        ),
      ),
      Effect.orDie,
      Effect.provide(NodeServices.layer),
    ),
) {
  return Layer.fresh(MonolithIndexService.layer).pipe(
    Layer.provide(
      Layer.succeed(
        MonolithAnalyzerService.MonolithAnalyzerService,
        MonolithAnalyzerService.MonolithAnalyzerService.of({
          indexArea: (input) => indexArea(input).pipe(Effect.provide(NodeServices.layer)),
          discover: () => Effect.succeed([]),
          checkFile,
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        MonolithService.MonolithService,
        MonolithService.MonolithService.of({
          get: ({ cwd }) =>
            Effect.succeed({
              configPath: `${cwd}/.t3/monolith.json`,
              source: "config" as const,
              config: { version: 1, initialized: true, areas: getAreas() } satisfies MonolithConfig,
            }),
          save: () => Effect.die("Unexpected config write"),
          discover: () => Effect.succeed(getAreas()),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}
const indexUse = Effect.gen(function* () {
  return yield* MonolithIndexService.MonolithIndexService;
});

it.effect.each([
  {
    message: "Symfony configuration security inspection was incomplete for one or more files.",
    expectedStatus: "ready",
    expectedCalls: 1,
  },
  {
    message: "Symfony configuration security could not inspect this source snapshot.",
    expectedStatus: "ready",
    expectedCalls: 1,
  },
] as const)(
  "distinguishes stable incomplete security sources from retryable helper failures: $expectedStatus",
  ({ message, expectedStatus, expectedCalls }) =>
    Effect.gen(function* () {
      const root = yield* setup;
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        yield* TestClock.adjust("31 seconds");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe(expectedStatus);
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        const checked = yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        expect(checked.runs[0]?.status).toBe("failed");
        expect(checked.runs[0]?.message).toBe(message);
        expect(calls).toBe(expectedCalls);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) => {
              calls++;
              return batch(input).pipe(
                Effect.map((files) =>
                  files.map((entry) => ({
                    ...entry,
                    result: {
                      ...entry.result,
                      runs: [
                        {
                          tool: "mago" as const,
                          operation: "guard" as const,
                          status: "failed" as const,
                          diagnosticCount: 0,
                          message,
                        },
                      ],
                    },
                  })),
                ),
                Effect.orDie,
              );
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "indexes YAML alongside PHP with per-file hashes and invalidates cached configuration findings",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* write(root, "api/config/services.yaml", "parameters: {token: first}\n");
      yield* write(root, "api/config/packages/security.yml", "security: {}\n");
      let calls = 0;
      let paths: readonly string[] = [];
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        const first = yield* service.checkFileCached({
          cwd: root,
          path: "api/config/services.yaml",
        });
        yield* service.awaitIdle({ cwd: root });
        expect(first.revision).toBe(yield* hashFile(root, "api/config/services.yaml"));
        expect(paths).toContain("api/config/services.yaml");
        expect(paths).toContain("api/config/packages/security.yml");
        expect(paths).toContain("api/src/Demo.php");
        expect(paths).not.toContain("api/composer.json");
        expect((yield* service.status({ cwd: root })).areas[0]?.fileCount).toBe(4);
        yield* write(root, "api/config/services.yaml", "parameters: {token: other}\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        const changed = yield* service.checkFileCached({
          cwd: root,
          path: "api/config/services.yaml",
        });
        yield* service.awaitIdle({ cwd: root });
        expect(changed.revision).not.toBe(first.revision);
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) => {
              paths = input.paths;
              calls++;
              return batch(input).pipe(Effect.orDie);
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "rebuilds older cache versions instead of treating missing YAML metadata as a ready index",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      let calls = 0;
      const layer = () =>
        serviceLayer(
          () => [php],
          (input) => {
            calls++;
            return batch(input).pipe(Effect.orDie);
          },
        );
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
      }).pipe(Effect.provide(layer()));
      const fs = yield* FileSystem.FileSystem;
      const directory = `${root}/.t3/monolith-index`;
      const cachePath = `${directory}/${(yield* fs.readDirectory(directory))[0]}`;
      const contents = yield* fs.readFileString(cachePath);
      expect(contents).toContain('"version":3,');
      yield* fs.writeFileString(cachePath, contents.replace('"version":3,', '"version":2,'));
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("idle");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
      }).pipe(Effect.provide(layer()));
      expect(calls).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "invalidates same-size .env changes beside an automatically detected ancestor Compose file",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* write(root, "compose.yaml", "services: {php: {image: php}}\n");
      yield* write(root, ".env", "APP_MODE=test\n");
      const area = { ...php, magoDocker: { service: "php" } };
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        yield* write(root, ".env", "APP_MODE=prod\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [area],
            (input) => {
              calls++;
              return batch(input).pipe(Effect.orDie);
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses normal file checks for non-PHP files inside a PHP area without starting an area batch",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      let calls = 0;
      const expected = result("api", yield* hashFile(root, "api/composer.json"));
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        expect(yield* service.checkFileCached({ cwd: root, path: "api/composer.json" })).toEqual(
          expected,
        );
        expect(calls).toBe(0);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) => {
              calls++;
              return batch(input).pipe(Effect.orDie);
            },
            () => Effect.succeed(expected),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports the analyzer failure reason in background indexing status", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      const status = (yield* service.status({ cwd: root })).areas[0];
      expect(status?.status).toBe("failed");
      expect(status?.message).toContain("inside the workspace");
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          () =>
            Effect.fail(
              new MonolithAnalyzerService.MonolithAnalyzerError({
                operation: "check",
                reason: "unsafe_path",
              }),
            ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects cache outputs above 64 MiB before disk publication or memory reuse", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const exit = yield* service
        .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Success");
      yield* service.awaitIdle({ cwd: root });
      const status = (yield* service.status({ cwd: root })).areas[0];
      expect(status?.status).toBe("failed");
      expect(status?.message).toContain("64 MiB");
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${root}/.t3/monolith-index`)).toBe(false);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          (input) =>
            batch(input).pipe(
              Effect.map((files) =>
                files.map((entry, index) =>
                  index
                    ? entry
                    : {
                        ...entry,
                        result: {
                          ...entry.result,
                          diagnostics: [
                            {
                              path: entry.path,
                              line: 1,
                              column: 1,
                              severity: "warning" as const,
                              message: "x".repeat(65 * 1024 * 1024),
                              ruleId: "large",
                              tool: "mago" as const,
                              operation: "analyze" as const,
                            },
                          ],
                        },
                      },
                ),
              ),
              Effect.orDie,
            ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("coalesces simultaneous cold file opens without a preceding project-index request", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const results = yield* Effect.all(
        [
          service.checkFileCached({ cwd: root, path: "api/src/Demo.php" }),
          service.checkFileCached({ cwd: root, path: "api/src/Caller.php" }),
        ],
        { concurrency: "unbounded" },
      );
      yield* service.awaitIdle({ cwd: root });
      expect(results).toHaveLength(2);
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          (input) => {
            calls++;
            return batch(input).pipe(Effect.orDie);
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retains unavailable tools until source changes or an explicit retry", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      yield* service.awaitIdle({ cwd: root });
      yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      yield* service.awaitIdle({ cwd: root });
      expect(calls).toBe(1);
      yield* TestClock.adjust("31 seconds");
      expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("ready");
      yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      yield* service.awaitIdle({ cwd: root });
      expect(calls).toBe(1);
      const validating = yield* service.index({ cwd: root });
      expect(validating.areas[0]?.status).toBe("ready");
      yield* service.awaitIdle({ cwd: root });
      expect(calls).toBe(1);
      yield* service.index({ cwd: root, force: true });
      yield* service.awaitIdle({ cwd: root });
      expect(calls).toBe(2);
      yield* write(root, "api/src/Caller.php", "<?php class Changed {}\n");
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      expect(calls).toBe(3);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          (input) => {
            calls++;
            return batch(input).pipe(
              Effect.map((files) =>
                files.map((entry) => ({
                  ...entry,
                  result: {
                    ...entry.result,
                    queryBudget: {
                      status: "unavailable" as const,
                      methods: [],
                      message: "Container not running.",
                    },
                  },
                })),
              ),
              Effect.orDie,
            );
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps excluded sources and files without modeled methods cached beyond the tool retry TTL",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        yield* TestClock.adjust("31 seconds");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("ready");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(1);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) => {
              calls++;
              return batch(input).pipe(
                Effect.map((files) =>
                  files.map((entry) => ({
                    ...entry,
                    result: {
                      ...entry.result,
                      queryBudget: {
                        status: "unsupported" as const,
                        methods: [],
                        message: "The file is absent from the configured Mago source snapshot.",
                      },
                      entryChains: {
                        status: "unavailable" as const,
                        targets: [],
                        message:
                          "The opened file has no uniquely modeled method in the source graph.",
                      },
                    },
                  })),
                ),
                Effect.orDie,
              );
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "invalidates explicit Compose files and included YAML/environment files outside the area",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* write(root, "infrastructure/docker/base.yaml", "services: {}\n");
      yield* write(root, "infrastructure/docker/parts/php.yaml", "services: {}\n");
      yield* write(root, "infrastructure/docker/.env", "APP_MODE=test\n");
      const area = {
        ...php,
        magoDocker: {
          service: "php",
          composeDirectory: "infrastructure/docker",
          composeFiles: ["infrastructure/docker/base.yaml"],
        },
      };
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        yield* write(
          root,
          "infrastructure/docker/parts/php.yaml",
          "services: {php: {image: php}}\n",
        );
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        yield* write(root, "infrastructure/docker/.env", "APP_MODE=production\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(3);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [area],
            (input) => {
              calls++;
              return batch(input).pipe(Effect.orDie);
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "starts indexing without waiting and shares one area batch across simultaneous cache misses",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const program = Effect.gen(function* () {
        const service = yield* indexUse;
        const initial = yield* service.index({ cwd: root });
        expect(initial.areas[0]?.status).toBe("indexing");
        yield* Deferred.await(started);
        expect((yield* service.status({ cwd: root })).areas[0]?.message).toBe(
          "Checking batch 1 of 1: mago analyze",
        );
        const first = yield* service
          .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
          .pipe(Effect.forkChild);
        const second = yield* service
          .checkFileCached({ cwd: root, path: "api/src/Caller.php" })
          .pipe(Effect.forkChild);
        expect((yield* Fiber.join(first)).revision).toBe(yield* hashFile(root, "api/src/Demo.php"));
        expect((yield* Fiber.join(second)).revision).toBe(
          yield* hashFile(root, "api/src/Caller.php"),
        );
        expect(calls).toBe(1);
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("indexing");
        yield* Deferred.succeed(release, undefined);
        yield* service.awaitIdle({ cwd: root });
        const status = yield* service.status({ cwd: root });
        expect(status.areas[0]?.status).toBe("ready");
        expect(status.areas[0]?.fileCount).toBe(2);
        expect(status.areas[0]?.revision).toMatch(/^[a-f0-9]{64}$/);
      });
      yield* program.pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) =>
              Effect.gen(function* () {
                calls++;
                yield* input.onProgress?.("mago analyze") ?? Effect.void;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return yield* batch(input);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new MonolithAnalyzerService.MonolithAnalyzerError({
                      operation: "check",
                      reason: "file",
                      cause,
                    }),
                ),
              ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reloads a persisted valid cache in a new service without invoking analyzers", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    let calls = 0;
    const layer = () =>
      serviceLayer(
        () => [php],
        (input) => {
          calls++;
          return batch(input).pipe(Effect.orDie);
        },
      );
    const first = yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const checked = yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      yield* service.awaitIdle({ cwd: root });
      return checked;
    }).pipe(Effect.provide(layer()));
    const cached = yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const checked = yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      yield* service.awaitIdle({ cwd: root });
      return checked;
    }).pipe(Effect.provide(layer()));
    expect(cached).toEqual(first);
    expect(calls).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "invalidates the whole graph after same-size caller edits, configuration and reference changes",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      let area = php;
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        const before = (yield* service.status({ cwd: root })).areas[0]?.revision;
        yield* write(root, "api/src/Caller.php", "<?php class CallEr {}\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        expect((yield* service.status({ cwd: root })).areas[0]?.revision).not.toBe(before);
        area = { ...php, commentMarkers: [] };
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        yield* write(root, "api/.mago/container-reference.dev.json", "{}");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(4);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [area],
            (input) => {
              calls++;
              return batch(input).pipe(Effect.orDie);
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects stale batch output when source changes during the shared analysis", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const exit = yield* service
        .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Success");
      yield* service.awaitIdle({ cwd: root });
      expect((yield* service.status({ cwd: root })).areas[0]?.status).not.toBe("ready");
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${root}/.t3/monolith-index`)).toBe(false);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          (input) =>
            Effect.gen(function* () {
              const values = yield* batch(input);
              yield* write(root, "api/src/Caller.php", "<?php class Changed {}\n");
              return values;
            }).pipe(Effect.orDie),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("indexes React source too while generic and excluded groups do not execute tools", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, "portal/src/App.tsx", "export const App = () => null;\n");
    yield* write(root, "portal/package.json", "{}");
    yield* write(root, "portal/node_modules/ignored/index.js", "throw 1;");
    const react: MonolithArea = { id: "portal", name: "Portal", path: "portal", kind: "react" };
    let paths: readonly string[] = [];
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.checkFileCached({ cwd: root, path: "portal/src/App.tsx" });
      yield* service.awaitIdle({ cwd: root });
      expect(paths).toEqual(["portal/package.json", "portal/src/App.tsx"]);
      expect((yield* service.status({ cwd: root })).areas.map((area) => area.areaId)).toEqual([
        "portal",
      ]);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [
            react,
            { ...php, enabled: false },
            { id: "docs", name: "Docs", path: "docs", kind: "folder" },
          ],
          (input) => {
            paths = input.paths;
            return batch(input).pipe(Effect.orDie);
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not write index caches through a linked .t3 directory", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-outside-" });
    yield* fs.symlink(outside, `${root}/.t3`);
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const exit = yield* service
        .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Success");
      yield* service.awaitIdle({ cwd: root });
      expect(yield* fs.readDirectory(outside)).toEqual([]);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          (input) => batch(input).pipe(Effect.orDie),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("gives explicit Reindex a fresh native snapshot even when content is unchanged", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const keys: string[] = [];
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      expect(keys).toHaveLength(1);
      yield* service.index({ cwd: root, force: true });
      yield* service.awaitIdle({ cwd: root });
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php],
          (input) => {
            keys.push(input.snapshot!.key);
            return batch(input).pipe(Effect.orDie);
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "indexes 20,001 PHP files in sequential bounded batches",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* Effect.forEach(
        Array.from({ length: 19999 }, (_, index) => index),
        (index) => write(root, `api/src/Generated${index}.php`, "<?php class Generated {}\n"),
        { concurrency: 64, discard: true },
      );
      const sizes: number[] = [];
      const snapshotKeys = new Set<string>();
      let active = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        expect((yield* service.index({ cwd: root })).areas[0]?.status).toBe("indexing");
        yield* service.awaitIdle({ cwd: root });
        expect(sizes).toHaveLength(11);
        expect(sizes.reduce((sum, count) => sum + count, 0)).toBe(20001);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(2000);
        expect(snapshotKeys.size).toBe(1);
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("ready");
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) =>
              Effect.gen(function* () {
                expect(active).toBe(0);
                active++;
                sizes.push(input.paths.length);
                expect(input.snapshot?.paths).toHaveLength(20001);
                snapshotKeys.add(input.snapshot!.key);
                const files = yield* batch(input);
                active--;
                return files;
              }).pipe(Effect.orDie),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

it.effect(
  "splits batches by UTF-8 bytes before the analyzer's 32 MiB budget",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const contents = "<?php\n//" + "é".repeat(700000);
      yield* Effect.forEach(
        Array.from({ length: 25 }, (_, index) => index),
        (index) => write(root, `api/src/Large${index}.php`, contents),
        { concurrency: 8, discard: true },
      );
      const sizes: number[] = [];
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.index({ cwd: root });
        yield* service.awaitIdle({ cwd: root });
        expect(sizes).toHaveLength(2);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(32 * 1024 * 1024);
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(32 * 1024 * 1024);
        expect((yield* service.status({ cwd: root })).areas[0]?.fileCount).toBe(27);
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("ready");
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) =>
              Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const bytes = yield* Effect.forEach(input.paths, (path) =>
                  fs.stat(`${root}/${path}`).pipe(Effect.map((stat) => Number(stat.size))),
                );
                sizes.push(bytes.reduce((sum, size) => sum + size, 0));
                return yield* batch(input);
              }).pipe(Effect.orDie),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);

it.effect("excludes React build outputs without hiding nested source or PHP build folders", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const react: MonolithArea = {
      id: "frontend",
      name: "Frontend",
      path: "frontend",
      kind: "react",
    };
    yield* write(root, "frontend/package.json", "{}");
    yield* write(root, "frontend/src/App.tsx", "export const App = () => null;\n");
    yield* write(root, "frontend/src/build/helper.ts", "export const helper = 1;\n");
    for (const folder of ["build", "dist", "coverage", "out", ".output", ".nuxt", ".svelte-kit"])
      yield* write(
        root,
        `frontend/${folder}/server/assets/server-build.js`,
        "x".repeat(2 * 1024 * 1024 + 1),
      );
    yield* write(root, "api/build/RealSource.php", "<?php class RealSource {}\n");
    const indexed = new Map<string, readonly string[]>();
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      expect(indexed.get("frontend")).toEqual([
        "frontend/package.json",
        "frontend/src/App.tsx",
        "frontend/src/build/helper.ts",
      ]);
      expect(indexed.get("api")).toContain("api/build/RealSource.php");
      const initial = (yield* service.status({ cwd: root })).areas;
      expect(initial.every((area) => area.status === "ready")).toBe(true);
      const revision = initial.find((area) => area.areaId === "frontend")?.revision;
      yield* write(
        root,
        "frontend/build/server/assets/server-build.js",
        "another generated bundle",
      );
      expect(
        (yield* service.status({ cwd: root })).areas.find((area) => area.areaId === "frontend")
          ?.revision,
      ).toBe(revision);
      expect(
        (yield* service.status({ cwd: root })).areas.find((area) => area.areaId === "frontend")
          ?.status,
      ).toBe("ready");
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => [php, react],
          (input) => {
            indexed.set(input.areaId, input.paths);
            return batch(input).pipe(Effect.orDie);
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "skips oversized sources, keeps other cached files usable and indexes files that shrink",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* write(root, "api/src/Oversized.php", "x".repeat(2 * 1024 * 1024 + 1));
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        const opened = yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        expect(opened.revision).toBe(yield* hashFile(root, "api/src/Demo.php"));
        yield* service.awaitIdle({ cwd: root });
        const status = (yield* service.status({ cwd: root })).areas[0];
        expect(status?.status).toBe("ready");
        expect(status?.fileCount).toBe(2);
        expect(status?.message).toContain("Skipped 1 source file");
        expect(status?.message).toContain("api/src/Oversized.php");
        expect(status?.message).toContain("2 MiB");
        expect(calls).toBe(1);
        expect(
          (yield* service.checkFileCached({ cwd: root, path: "api/src/Caller.php" })).revision,
        ).toBe(yield* hashFile(root, "api/src/Caller.php"));
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(1);
        yield* write(root, "api/src/Oversized.php", "<?php class SmallEnough {}\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.index({ cwd: root });
        yield* service.awaitIdle({ cwd: root });
        const updated = (yield* service.status({ cwd: root })).areas[0];
        expect(updated?.status).toBe("ready");
        expect(updated?.fileCount).toBe(3);
        expect(updated?.message).toBeUndefined();
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) => {
              calls++;
              return batch(input).pipe(Effect.orDie);
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "bounds cumulative graph entries before serializing a multi-gigabyte area cache",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* Effect.forEach(
        Array.from({ length: 2001 }, (_, index) => index),
        (index) => write(root, `api/src/Graph${index}.php`, "<?php class Graph {}\n"),
        { concurrency: 64, discard: true },
      );
      const sharedMessage = "é".repeat(512 * 1024);
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.index({ cwd: root });
        yield* service.awaitIdle({ cwd: root });
        expect((yield* service.status({ cwd: root })).areas[0]?.message).toContain("64 MiB");
        expect(calls).toBe(1);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${root}/.t3/monolith-index`)).toBe(false);
        const opened = yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        expect(opened.diagnostics).toEqual([]);
        expect(calls).toBe(1);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [php],
            (input) => {
              calls++;
              return batch(input).pipe(
                Effect.map((files) =>
                  files.map((entry) => ({
                    ...entry,
                    result: {
                      ...entry.result,
                      diagnostics: [
                        {
                          path: entry.path,
                          line: 1,
                          column: 1,
                          severity: "info" as const,
                          message: sharedMessage,
                          ruleId: "graph",
                          tool: "mago" as const,
                          operation: "analyze" as const,
                        },
                      ],
                    },
                  })),
                ),
                Effect.orDie,
              );
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);

it.effect("invalidates source membership when a nested folder group is added or removed", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, "api/nested/Owned.php", "<?php class Owned {}\n");
    let areas: readonly MonolithArea[] = [php];
    const batches: (readonly string[])[] = [];
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      const first = (yield* service.status({ cwd: root })).areas[0];
      expect(first?.fileCount).toBe(3);
      areas = [php, { id: "nested", name: "Nested", path: "api/nested", kind: "folder" }];
      const excluded = (yield* service.status({ cwd: root })).areas[0];
      expect(excluded?.status).toBe("stale");
      expect(excluded?.revision).not.toBe(first?.revision);
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      const second = (yield* service.status({ cwd: root })).areas[0];
      expect(second?.fileCount).toBe(2);
      areas = [php];
      const included = (yield* service.status({ cwd: root })).areas[0];
      expect(included?.status).toBe("stale");
      expect(included?.revision).not.toBe(second?.revision);
      yield* service.index({ cwd: root });
      yield* service.awaitIdle({ cwd: root });
      const final = (yield* service.status({ cwd: root })).areas[0];
      expect(final?.status).toBe("ready");
      expect(final?.fileCount).toBe(3);
      expect(final?.revision).toBe(first?.revision);
      expect(batches).toHaveLength(3);
      expect(batches[1]).not.toContain("api/nested/Owned.php");
      expect(batches[2]).toContain("api/nested/Owned.php");
      const restored = yield* service.checkFileCached({ cwd: root, path: "api/nested/Owned.php" });
      expect(restored.revision).toBe(yield* hashFile(root, "api/nested/Owned.php"));
    }).pipe(
      Effect.provide(
        serviceLayer(
          () => areas,
          (input) => {
            batches.push(input.paths);
            return batch(input).pipe(Effect.orDie);
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "does not repeat a fatal job for unchanged hashes and retries force or changed inputs",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      let area = php;
      let calls = 0;
      yield* Effect.gen(function* () {
        const service = yield* indexUse;
        yield* service.index({ cwd: root });
        yield* service.awaitIdle({ cwd: root });
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("failed");
        yield* TestClock.adjust("60 seconds");
        expect((yield* service.index({ cwd: root })).areas[0]?.status).toBe("failed");
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(1);
        yield* service.index({ cwd: root, force: true });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(2);
        area = { ...php, commentMarkers: [] };
        yield* service.index({ cwd: root });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(3);
        yield* write(root, "api/src/Caller.php", "<?php class Changed {}\n");
        yield* service.index({ cwd: root });
        yield* service.awaitIdle({ cwd: root });
        expect(calls).toBe(4);
      }).pipe(
        Effect.provide(
          serviceLayer(
            () => [area],
            () => {
              calls++;
              return Effect.fail(
                new MonolithAnalyzerService.MonolithAnalyzerError({
                  operation: "check",
                  reason: "file",
                }),
              );
            },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
