import * as NodeServices from "@effect/platform-node/NodeServices";
import { type MonolithConfig } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as MonolithService from "./MonolithService.ts";

const layerTest = MonolithService.layer.pipe(Layer.provideMerge(NodeServices.layer));
const temporaryRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-monolith-test-" });
});
const write = Effect.fnUntraced(function* (root: string, relative: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(root, relative);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, contents);
});
const emptyConfig: MonolithConfig = { version: 1, initialized: true, areas: [] };

it.layer(layerTest)("MonolithService", (it) => {
  it.effect(
    "discovers root and arbitrary nested applications while excluding dependencies, builds, links and PHP tools",
    () =>
      Effect.gen(function* () {
        const service = yield* MonolithService.MonolithService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* temporaryRoot;
        yield* write(root, "composer.json", '{"name":"example/backend"}');
        yield* write(root, "package.json", '{"private":true,"workspaces":["apps/*"]}');
        yield* write(root, "artifact/composer.json", '{"name":"example/api"}');
        yield* write(root, "artifact-test/frontend/package.json", '{"dependencies":{"react":"*"}}');
        yield* write(
          root,
          "packages/deep/sample/package.json",
          '{"devDependencies":{"react":"*"}}',
        );
        yield* write(
          root,
          "artifact/tools/phpstan/composer.json",
          '{"require":{"phpstan/phpstan":"*"}}',
        );
        yield* write(root, "tools/checker/composer.json", '{"require":{"phpstan/phpstan":"*"}}');
        yield* write(root, "vendor/nested/composer.json", "{}");
        yield* write(root, "node_modules/react/package.json", '{"dependencies":{"react":"*"}}');
        yield* write(root, "build/generated/composer.json", "{}");
        yield* write(root, ".git/nested/composer.json", "{}");
        yield* write(root, "plain/package.json", '{"dependencies":{"typescript":"*"}}');
        yield* write(root, "broken/composer.json", "invalid");
        yield* fs.symlink(path.join(root, "artifact"), path.join(root, "linked"));

        const areas = yield* service.discover({ cwd: root });
        expect(areas.map(({ path, kind }) => ({ path, kind }))).toEqual([
          { path: ".", kind: "php" },
          { path: "artifact", kind: "php" },
          { path: "artifact-test/frontend", kind: "react" },
          { path: "packages/deep/sample", kind: "react" },
        ]);
        expect(yield* fs.exists(path.join(root, "t3.monolith.json"))).toBe(false);
      }),
  );

  it.effect("a React root and an umbrella workspace both retain nested applications", () =>
    Effect.gen(function* () {
      const service = yield* MonolithService.MonolithService;
      const root = yield* temporaryRoot;
      yield* write(root, "package.json", '{"dependencies":{"react":"*"},"workspaces":["apps/*"]}');
      yield* write(root, "apps/customer/package.json", '{"peerDependencies":{"react":"*"}}');
      yield* write(root, "apps/server/composer.json", "{}");
      expect((yield* service.discover({ cwd: root })).map((area) => area.path)).toEqual([
        ".",
        "apps/customer",
        "apps/server",
      ]);
    }),
  );

  it.effect(
    "initializes once, preserves edits and removals, and discovers new applications only on request",
    () =>
      Effect.gen(function* () {
        const service = yield* MonolithService.MonolithService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* temporaryRoot;
        yield* write(root, "artifact/composer.json", "{}");
        yield* write(root, "frontend/package.json", '{"dependencies":{"react":"*"}}');
        const first = yield* service.get({ cwd: root });
        expect(first.source).toBe("discovered");
        expect(first.config.areas).toHaveLength(2);
        const edited: MonolithConfig = {
          ...first.config,
          defaultBaseBranch: "develop",
          areas: [{ ...first.config.areas[0]!, name: "API", enabled: false }],
        };
        yield* service.save({ cwd: root, config: edited });
        const originalFile = yield* fs.readFileString(first.configPath);
        yield* write(root, "new/client/package.json", '{"dependencies":{"react":"*"}}');
        const loaded = yield* service.get({ cwd: root });
        expect(loaded.source).toBe("config");
        expect(loaded.config).toEqual(edited);
        expect(yield* fs.readFileString(first.configPath)).toBe(originalFile);
        expect(yield* service.discover({ cwd: root })).toHaveLength(3);
        expect(yield* fs.readFileString(first.configPath)).toBe(originalFile);
      }),
  );

  it.effect("readonly get returns suggestions without creating a configuration", () =>
    Effect.gen(function* () {
      const service = yield* MonolithService.MonolithService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* temporaryRoot;
      yield* write(root, "composer.json", "{}");
      const snapshot = yield* service.get({ cwd: root, initialize: false });
      expect(snapshot.config.areas).toHaveLength(1);
      expect(snapshot.source).toBe("discovered");
      expect(yield* fs.exists(snapshot.configPath)).toBe(false);
      yield* service.save({ cwd: root, config: emptyConfig });
      expect((yield* service.get({ cwd: root, initialize: false })).config.areas).toEqual([]);
    }),
  );

  it.effect("does not overwrite an invalid existing configuration", () =>
    Effect.gen(function* () {
      const service = yield* MonolithService.MonolithService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* temporaryRoot;
      yield* write(root, "t3.monolith.json", "{broken");
      expect((yield* service.get({ cwd: root }).pipe(Effect.flip)).reason).toBe("invalid_config");
      expect(yield* fs.readFileString(path.join(root, "t3.monolith.json"))).toBe("{broken");
    }),
  );

  it.effect(
    "rejects traversal, absolute paths, duplicate ids and duplicate paths without changing the file",
    () =>
      Effect.gen(function* () {
        const service = yield* MonolithService.MonolithService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* temporaryRoot;
        const original = yield* service.save({ cwd: root, config: emptyConfig });
        const originalFile = yield* fs.readFileString(original.configPath);
        for (const unsafe of [
          "../elsewhere",
          "/tmp",
          "dir/../../escape",
          "C:\\escape",
          "dir//child",
        ]) {
          const config: MonolithConfig = {
            ...emptyConfig,
            areas: [{ id: "test", name: "Test", path: unsafe, kind: "folder" }],
          };
          expect((yield* service.save({ cwd: root, config }).pipe(Effect.flip)).reason).toBe(
            "invalid_config",
          );
        }
        for (const areas of [
          [
            { id: "same", name: "A", path: "a", kind: "folder" as const },
            { id: "same", name: "B", path: "b", kind: "folder" as const },
          ],
          [
            { id: "a", name: "A", path: ".", kind: "php" as const },
            { id: "b", name: "B", path: ".", kind: "react" as const },
          ],
        ]) {
          expect(
            (yield* service
              .save({ cwd: root, config: { ...emptyConfig, areas } })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid_config");
        }
        expect(yield* fs.readFileString(original.configPath)).toBe(originalFile);
      }),
  );

  it.effect(
    "rejects symlinked area ancestors and a symlinked config without touching external files",
    () =>
      Effect.gen(function* () {
        const service = yield* MonolithService.MonolithService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* temporaryRoot;
        const outside = yield* temporaryRoot;
        yield* write(outside, "composer.json", "{}");
        yield* write(outside, "config.json", "external");
        yield* fs.symlink(outside, path.join(root, "escape"));
        const config: MonolithConfig = {
          ...emptyConfig,
          areas: [{ id: "test", name: "Test", path: "escape/missing", kind: "folder" }],
        };
        expect((yield* service.save({ cwd: root, config }).pipe(Effect.flip)).reason).toBe(
          "unsafe_path",
        );
        expect(yield* service.discover({ cwd: root })).toEqual([]);
        yield* fs.symlink(path.join(outside, "config.json"), path.join(root, "t3.monolith.json"));
        expect((yield* service.get({ cwd: root }).pipe(Effect.flip)).reason).toBe("unsafe_path");
        expect(
          (yield* service.save({ cwd: root, config: emptyConfig }).pipe(Effect.flip)).reason,
        ).toBe("unsafe_path");
        expect(yield* fs.readFileString(path.join(outside, "config.json"))).toBe("external");
      }),
  );

  it.effect(
    "concurrent initialization publishes a complete file and cleans up temporary files",
    () =>
      Effect.gen(function* () {
        const service = yield* MonolithService.MonolithService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* temporaryRoot;
        yield* write(root, "composer.json", "{}");
        const snapshots = yield* Effect.all(
          [service.get({ cwd: root }), service.get({ cwd: root }), service.get({ cwd: root })],
          { concurrency: "unbounded" },
        );
        expect(snapshots.filter((snapshot) => snapshot.source === "discovered")).toHaveLength(1);
        expect(snapshots.every((snapshot) => snapshot.config.areas.length === 1)).toBe(true);
        expect(JSON.parse(yield* fs.readFileString(snapshots[0]!.configPath))).toEqual(
          snapshots[0]!.config,
        );
        expect((yield* fs.readDirectory(root)).toSorted()).toEqual([
          "composer.json",
          "t3.monolith.json",
        ]);
      }),
  );
});
