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
  indexArea: (input: {
    cwd: string;
    areaId: string;
    paths: readonly string[];
  }) => Effect.Effect<
    readonly { path: string; result: MonolithCheckFileResult }[],
    MonolithAnalyzerService.MonolithAnalyzerError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
  checkFile: MonolithAnalyzerService.MonolithAnalyzerService["Service"]["checkFile"] = () =>
    Effect.die("Unexpected per-file analyzer execution"),
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
        yield* write(root, ".env", "APP_MODE=prod\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
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

it.effect("rejects cache outputs above 16 MiB before disk publication or memory reuse", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      const exit = yield* service
        .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      const status = (yield* service.status({ cwd: root })).areas[0];
      expect(status?.status).toBe("failed");
      expect(status?.message).toContain("limit");
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
                              message: "x".repeat(17 * 1024 * 1024),
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

it.effect("retries unavailable tools after the bounded TTL without source changes", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* indexUse;
      yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      expect(calls).toBe(1);
      yield* TestClock.adjust("31 seconds");
      expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
      yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
      expect(calls).toBe(2);
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
        yield* TestClock.adjust("31 seconds");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("ready");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
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
        yield* write(
          root,
          "infrastructure/docker/parts/php.yaml",
          "services: {php: {image: php}}\n",
        );
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* write(root, "infrastructure/docker/.env", "APP_MODE=production\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
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
        const first = yield* service
          .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
          .pipe(Effect.forkChild);
        const second = yield* service
          .checkFileCached({ cwd: root, path: "api/src/Caller.php" })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first)).revision).toBe(yield* hashFile(root, "api/src/Demo.php"));
        expect((yield* Fiber.join(second)).revision).toBe(
          yield* hashFile(root, "api/src/Caller.php"),
        );
        expect(calls).toBe(1);
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
      return yield* (yield* indexUse).checkFileCached({ cwd: root, path: "api/src/Demo.php" });
    }).pipe(Effect.provide(layer()));
    const cached = yield* Effect.gen(function* () {
      return yield* (yield* indexUse).checkFileCached({ cwd: root, path: "api/src/Demo.php" });
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
        const before = (yield* service.status({ cwd: root })).areas[0]?.revision;
        yield* write(root, "api/src/Caller.php", "<?php class CallEr {}\n");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        expect((yield* service.status({ cwd: root })).areas[0]?.revision).not.toBe(before);
        area = { ...php, commentMarkers: [] };
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
        yield* write(root, "api/.mago/container-reference.dev.json", "{}");
        expect((yield* service.status({ cwd: root })).areas[0]?.status).toBe("stale");
        yield* service.checkFileCached({ cwd: root, path: "api/src/Demo.php" });
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
      expect(exit._tag).toBe("Failure");
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
      const exit = yield* (yield* indexUse)
        .checkFileCached({ cwd: root, path: "api/src/Demo.php" })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
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
