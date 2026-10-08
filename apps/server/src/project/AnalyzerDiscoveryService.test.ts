import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { MonolithArea } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AnalyzerDiscoveryService from "./AnalyzerDiscoveryService.ts";

const layerTest = AnalyzerDiscoveryService.layer.pipe(Layer.provideMerge(NodeServices.layer));
const temporaryRoot = Effect.gen(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "t3-analyzer-test-",
  });
});
const write = Effect.fnUntraced(function* (root: string, relative: string, content: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(root, relative);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(
    target,
    typeof content === "string" ? content : JSON.stringify(content),
  );
});
const area = (kind: "php" | "react" | "folder", path: string): MonolithArea => ({
  id: `${kind}:${path}`,
  name: path,
  kind,
  path,
});

it.layer(layerTest)("AnalyzerDiscoveryService", (it) => {
  it.effect("discovers query-budget and graph packages from separate nested tools manifests", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
      yield* write(root, "artifact/api/composer.json", { require: { php: "^8.2" } });
      yield* write(root, "artifact/api/tools/mago/composer.json", {
        require: { "carthage-software/mago": "1.50.0" },
      });
      yield* write(root, "artifact/api/tools/insights/composer.json", {
        require: {
          "byte-kitsune/mago-doctrine-query-budget": "*",
          "byte-kitsune/mago-architecture-graph": "*",
        },
        config: { "vendor-dir": "dependencies" },
      });
      yield* write(root, "artifact/api/tools/mago/vendor/bin/mago", "binary");
      yield* write(root, "artifact/api/tools/insights/dependencies/autoload.php", "<?php");
      yield* write(
        root,
        "artifact/api/tools/insights/dependencies/byte-kitsune/mago-doctrine-query-budget/src/QueryBudgetExtension.php",
        "<?php",
      );
      const tools = (yield* service.discover({
        cwd: root,
        areas: [area("php", "artifact/api")],
      }))[0]!.tools;
      expect(tools[0]!.doctrineQueryBudget).toEqual({
        autoloadPath: "artifact/api/tools/insights/dependencies/autoload.php",
        available: true,
      });
      expect(tools[0]!.architectureGraph).toEqual({
        autoloadPath: "artifact/api/tools/insights/dependencies/autoload.php",
        available: false,
      });
    }),
  );

  it.effect(
    "finds tools Composer installations, referenced config, aliases and Symfony exporter recipes without running them",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
        yield* write(root, "artifact/api/composer.json", { require: { php: "^8.2" } });
        yield* write(root, "artifact/api/mago.toml", "version='1.50.0'");
        yield* write(root, "artifact/api/tools/composer.json", {
          "require-dev": {
            "carthage-software/mago": "1.50.0",
            "byte-kitsune/mago-symfony-wiring": "1.0.0",
          },
          config: { "vendor-dir": "dependencies" },
          scripts: {
            format: 'dependencies/bin/mago --config "../mago.toml" format',
            analyze: "dependencies/bin/mago --config=../mago.toml analyze",
            guard: "dependencies/bin/mago --config ../mago.toml guard",
            quality: ["@analyze", "@guard"],
            refs: "@php dependencies/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php --types=/tmp/types.json > ../.mago/container-reference.dev.json",
          },
        });
        yield* write(root, "artifact/api/tools/dependencies/bin/mago", "fake binary");
        const result = (yield* service.discover({
          cwd: root,
          areas: [area("php", "artifact/api")],
        }))[0]!;
        expect(result.warnings).toEqual([]);
        expect(result.tools[0]).toMatchObject({
          tool: "mago",
          manifestPath: "artifact/api/tools/composer.json",
          workingDirectory: "artifact/api",
          binaryPath: "artifact/api/tools/dependencies/bin/mago",
          configPath: "artifact/api/mago.toml",
          available: true,
          symfonyWiring: true,
        });
        expect(result.tools[0]!.symfonyWiringReference).toEqual({
          generatorPath:
            "artifact/api/tools/dependencies/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
          generatorAvailable: false,
          referencePath: "artifact/api/.mago/container-reference.dev.json",
          referenceAvailable: false,
          autoloadPath: "artifact/api/vendor/autoload.php",
          autoloadAvailable: false,
        });
        expect(
          result.tools[0]!.scripts.map(({ name, operation, configPath }) => ({
            name,
            operation,
            configPath,
          })),
        ).toEqual([
          { name: "format", operation: "format", configPath: "artifact/api/mago.toml" },
          { name: "analyze", operation: "analyze", configPath: "artifact/api/mago.toml" },
          { name: "guard", operation: "guard", configPath: "artifact/api/mago.toml" },
          { name: "quality", operation: "analyze", configPath: "artifact/api/mago.toml" },
          { name: "quality", operation: "guard", configPath: "artifact/api/mago.toml" },
          { name: "refs", operation: "references", configPath: undefined },
        ]);
      }),
  );

  it.effect("finds normal Mago config and reports a declared but uninstalled binary", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
      yield* write(root, "api/composer.json", {
        require: { "carthage-software/mago": "*" },
        config: { "bin-dir": "executables" },
      });
      yield* write(root, "api/mago.dist.toml", "");
      const result = (yield* service.discover({ cwd: root, areas: [area("php", "api")] }))[0]!;
      expect(result.tools[0]).toMatchObject({
        binaryPath: "api/executables/mago",
        available: false,
        configPath: "api/mago.dist.toml",
      });
    }),
  );

  it.effect("finds local and workspace-hoisted Biome and keeps each application's own config", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
      yield* write(root, "package.json", {
        devDependencies: { "@biomejs/biome": "*" },
        scripts: { lint: "biome check ." },
      });
      yield* write(root, "node_modules/@biomejs/biome/bin/biome", "fake binary");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(root, "node_modules/.bin"), { recursive: true });
      yield* fs.symlink("../@biomejs/biome/bin/biome", path.join(root, "node_modules/.bin/biome"));
      yield* write(root, "artifact-test/ui/package.json", { dependencies: { react: "*" } });
      yield* write(root, "artifact-test/ui/biome.jsonc", "{ /* local */ }");
      yield* write(root, "artifact/customer/package.json", {
        devDependencies: { "@biomejs/biome": "*" },
        scripts: { lint: "biome --config-path=quality check ." },
      });
      yield* write(root, "artifact/customer/quality/biome.json", "{}");
      const results = yield* service.discover({
        cwd: root,
        areas: [area("react", "artifact-test/ui"), area("react", "artifact/customer")],
      });
      expect(results[0]!.tools[0]).toMatchObject({
        manifestPath: "package.json",
        workingDirectory: "artifact-test/ui",
        configPath: "artifact-test/ui/biome.jsonc",
        binaryPath: "node_modules/.bin/biome",
        available: true,
      });
      expect(results[1]!.tools[0]).toMatchObject({
        manifestPath: "artifact/customer/package.json",
        configPath: "artifact/customer/quality/biome.json",
        available: true,
      });
    }),
  );

  it.effect(
    "ignores stray configs, disabled areas and plain groups; reports malformed manifests",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
        yield* write(root, "api/composer.json", "broken");
        yield* write(root, "api/mago.toml", "");
        yield* write(root, "plain/composer.json", { require: { "carthage-software/mago": "*" } });
        const results = yield* service.discover({
          cwd: root,
          areas: [
            area("php", "api"),
            area("folder", "plain"),
            { ...area("php", "plain"), enabled: false },
          ],
        });
        expect(results.map((result) => result.tools)).toEqual([[], [], []]);
        expect(results[0]!.warnings).toEqual([
          { path: "api/composer.json", reason: "invalid_manifest" },
        ]);
      }),
  );

  it.effect(
    "rejects external binaries, linked configs and shell recipes as automatic command metadata",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const outside = yield* temporaryRoot;
        const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* write(root, "api/composer.json", {
          require: { "carthage-software/mago": "*" },
          scripts: {
            bad: "mago --config ../../escape.toml analyze && touch /tmp/unwanted",
            unsafe: "mago --config ../../escape.toml guard",
          },
        });
        yield* write(outside, "mago", "fake binary");
        yield* write(outside, "mago.toml", "");
        yield* fs.makeDirectory(path.join(root, "api/vendor/bin"), { recursive: true });
        yield* fs.symlink(path.join(outside, "mago"), path.join(root, "api/vendor/bin/mago"));
        yield* fs.symlink(path.join(outside, "mago.toml"), path.join(root, "api/mago.toml"));
        const result = (yield* service.discover({ cwd: root, areas: [area("php", "api")] }))[0]!;
        expect(result.tools[0]).toMatchObject({ available: false });
        expect(result.tools[0]!.configPath).toBeUndefined();
        expect(result.tools[0]!.scripts).toHaveLength(1);
        expect(result.warnings.map((warning) => warning.reason)).toEqual([
          "unsupported_script",
          "unsafe_path",
          "unsafe_path",
          "unsafe_path",
        ]);
      }),
  );
  it.effect("finds nested tools projects while skipping dependency manifests", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
      yield* write(root, "api/composer.json", {});
      yield* write(root, "api/tools/mago/composer.json", {
        require: { "carthage-software/mago": "*" },
      });
      yield* write(root, "api/tools/mago/mago.yaml", "php-version: '8.2'");
      yield* write(root, "api/tools/mago/vendor/fake/composer.json", {
        require: { "carthage-software/mago": "*" },
      });
      const result = (yield* service.discover({ cwd: root, areas: [area("php", "api")] }))[0]!;
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({
        manifestPath: "api/tools/mago/composer.json",
        configPath: "api/tools/mago/mago.yaml",
      });
    }),
  );
  it.effect("uses application Composer shortcuts for a tools-only installation", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
      yield* write(root, "api/composer.json", {
        scripts: {
          analyze: "tools/vendor/bin/mago --config .quality/php.toml analyze",
          refs: "php tools/vendor/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php > .quality/references.json",
        },
      });
      yield* write(root, "api/tools/composer.json", {
        require: { "carthage-software/mago": "*", "byte-kitsune/mago-symfony-wiring": "*" },
      });
      yield* write(root, "api/.quality/php.toml", "");
      yield* write(root, "api/.quality/references.json", "{}");
      const result = (yield* service.discover({ cwd: root, areas: [area("php", "api")] }))[0]!;
      expect(result.tools[0]).toMatchObject({
        configPath: "api/.quality/php.toml",
        symfonyWiringReference: {
          referencePath: "api/.quality/references.json",
          referenceAvailable: true,
        },
      });
    }),
  );
  it.effect("discovers Symfony Wiring separately from the Mago installation", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const service = yield* AnalyzerDiscoveryService.AnalyzerDiscoveryService;
      yield* write(root, "api/composer.json", { require: { "carthage-software/mago": "*" } });
      yield* write(root, "api/vendor/bin/mago", "fake binary");
      yield* write(root, "api/vendor/autoload.php", "<?php");
      yield* write(root, "api/tools/composer.json", {
        require: { "byte-kitsune/mago-symfony-wiring": "*" },
        config: { "vendor-dir": "dependencies" },
        scripts: {
          refs: "php dependencies/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php > ../.mago/custom.json",
        },
      });
      yield* write(
        root,
        "api/tools/dependencies/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
        "<?php",
      );
      const result = (yield* service.discover({ cwd: root, areas: [area("php", "api")] }))[0]!;
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({
        manifestPath: "api/composer.json",
        symfonyWiring: true,
        symfonyWiringReference: {
          generatorPath:
            "api/tools/dependencies/byte-kitsune/mago-symfony-wiring/bin/create-container-reference.php",
          generatorAvailable: true,
          referencePath: "api/.mago/custom.json",
          autoloadAvailable: true,
        },
      });
      expect(result.tools[0]!.scripts).toHaveLength(1);
      expect(result.tools[0]!.scripts[0]!.operation).toBe("references");
    }),
  );
});
