import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { MonolithCheckFileResult, MonolithConfig } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MonolithAnalyzerService from "./MonolithAnalyzerService.ts";
import * as MonolithReviewService from "./MonolithReviewService.ts";
import * as MonolithService from "./MonolithService.ts";

const config: MonolithConfig = {
  version: 1,
  initialized: true,
  defaultBaseBranch: "main",
  reviewPrompt: "Review global prompt",
  areas: [
    { id: "php", name: "PHP", path: "api", kind: "php", reviewPrompt: "Review API prompt" },
    { id: "docs", name: "Docs", path: "docs", kind: "folder" },
  ],
};
const testGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-config-" })),
  Layer.provideMerge(NodeServices.layer),
);
const gitCommand = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  return yield* git.execute({ cwd, args, operation: "test", maxOutputBytes: 1024 * 1024 });
});
const write = Effect.fnUntraced(function* (cwd: string, file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${cwd}/${file.substring(0, file.lastIndexOf("/"))}`, {
    recursive: true,
  });
  yield* fs.writeFileString(`${cwd}/${file}`, contents);
});
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-review-" });
  yield* gitCommand(root, ["init", "-b", "main"]);
  yield* gitCommand(root, ["config", "user.email", "test@example.test"]);
  yield* gitCommand(root, ["config", "user.name", "Test"]);
  yield* write(root, "api/Demo.php", "<?php class Demo {}\n");
  yield* write(root, "api/Gone.php", "<?php class Gone {}\n");
  yield* write(root, "api/Context.php", "<?php class SharedContext {}\n");
  yield* write(root, "docs/old.md", "old docs\n");
  yield* gitCommand(root, ["add", "."]);
  yield* gitCommand(root, ["commit", "-m", "base"]);
  yield* gitCommand(root, ["checkout", "-b", "feature"]);
  yield* write(
    root,
    "api/Demo.php",
    "<?php class Demo { public function run(): int { return 1; } }\n",
  );
  yield* fs.remove(`${root}/api/Gone.php`);
  yield* gitCommand(root, ["mv", "docs/old.md", "docs/new.md"]);
  yield* write(root, "root.txt", "other\n");
  yield* gitCommand(root, ["add", "."]);
  yield* gitCommand(root, ["commit", "-m", "changes"]);
  return root;
});
const realBatch = Effect.fnUntraced(function* (
  input: Parameters<MonolithAnalyzerService.MonolithAnalyzerService["Service"]["indexArea"]>[0],
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  return yield* Effect.forEach(input.paths, (path) =>
    Effect.gen(function* () {
      const contents = yield* fs.readFileString(`${input.cwd}/${path}`);
      const revision = Hex.encode(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(contents)),
      );
      return {
        path,
        result: {
          areaId: input.areaId,
          revision,
          diagnostics: [],
          runs: [{ tool: "mago", operation: "analyze", status: "passed", diagnosticCount: 0 }],
        } satisfies MonolithCheckFileResult,
      };
    }),
  );
});
function reviewLayer(
  indexArea: MonolithAnalyzerService.MonolithAnalyzerService["Service"]["indexArea"],
) {
  return Layer.fresh(MonolithReviewService.layer).pipe(
    Layer.provide(
      Layer.succeed(
        MonolithService.MonolithService,
        MonolithService.MonolithService.of({
          get: ({ cwd }) =>
            Effect.succeed({ config, configPath: `${cwd}/.t3/monolith.json`, source: "config" }),
          discover: () => Effect.succeed(config.areas),
          save: () => Effect.die("Unexpected config mutation"),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        MonolithAnalyzerService.MonolithAnalyzerService,
        MonolithAnalyzerService.MonolithAnalyzerService.of({
          indexArea,
          discover: () => Effect.succeed([]),
          checkFile: () => Effect.die("Unexpected foreground per-file checks"),
        }),
      ),
    ),
  );
}
const batchWithNode: MonolithAnalyzerService.MonolithAnalyzerService["Service"]["indexArea"] = (
  input,
) => realBatch(input).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

it.effect(
  "reviews the immutable merge-base range, retains deletes and renames, groups Other last and packages exact checks",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const statusBefore = yield* gitCommand(root, ["status", "--porcelain"]);
      const service = yield* MonolithReviewService.MonolithReviewService;
      const started = yield* service.start({ cwd: root });
      yield* service.awaitIdle({ cwd: root, runId: started.runId });
      const run = yield* service.get({ cwd: root, runId: started.runId });
      expect(run.status).toBe("completed");
      expect(run.baseRef).toBe("main");
      expect(run.baseCommit).toBe(run.mergeBase);
      expect(run.groups.map((group) => group.name)).toEqual(["PHP", "Docs", "Other"]);
      expect(run.groups[0]?.files.find((file) => file.path === "api/Gone.php")?.checkStatus).toBe(
        "skipped",
      );
      expect(run.groups[1]?.files[0]).toMatchObject({
        path: "docs/new.md",
        oldPath: "docs/old.md",
        status: "renamed",
      });
      const demo = run.groups[0]?.files.find((file) => file.path === "api/Demo.php");
      expect(demo?.checks?.revision).toBe(demo?.fileHash);
      expect(run.coverage.checkedFiles).toBe(1);
      expect(run.groups[0]?.aiPackage?.prompt).toBe("Review API prompt");
      expect(run.groups[0]?.aiPackage?.text).toContain("Docs: renamed docs/new.md");
      expect(run.groups[0]?.aiPackage?.text).toContain(run.headCommit);
      expect((yield* gitCommand(root, ["status", "--porcelain"])).stdout).toBe(statusBefore.stdout);
    }).pipe(Effect.provide(reviewLayer(batchWithNode).pipe(Layer.provideMerge(testGit)))),
);

it.effect(
  "skips live analyzers for a dirty commit-only review and includes dirty/untracked changes only when requested",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* write(
        root,
        "api/Demo.php",
        "<?php class Demo { public function run(): int { return 22; } }\n",
      );
      yield* write(root, "api/New.php", "<?php class NewThing {}\n");
      const service = yield* MonolithReviewService.MonolithReviewService;
      const first = yield* service.start({ cwd: root });
      yield* service.awaitIdle({ cwd: root, runId: first.runId });
      const cleanTarget = yield* service.get({ cwd: root, runId: first.runId });
      expect(
        cleanTarget.groups[0]?.files.find((file) => file.path === "api/Demo.php")?.message,
      ).toContain("working tree differs");
      expect(
        cleanTarget.groups[0]?.files.find((file) => file.path === "api/Demo.php")?.patch,
      ).not.toContain("return 22");
      expect(cleanTarget.coverage.checkedFiles).toBe(0);
      const second = yield* service.start({ cwd: root, includeWorkingTree: true });
      yield* service.awaitIdle({ cwd: root, runId: second.runId });
      const dirtyTarget = yield* service.get({ cwd: root, runId: second.runId });
      expect(dirtyTarget.groups[0]?.files.find((file) => file.path === "api/New.php")?.status).toBe(
        "untracked",
      );
      expect(
        dirtyTarget.groups[0]?.files.find((file) => file.path === "api/Demo.php")?.patch,
      ).toContain("return 22");
      expect(dirtyTarget.coverage.checkedFiles).toBe(2);
    }).pipe(Effect.provide(reviewLayer(batchWithNode).pipe(Layer.provideMerge(testGit)))),
);

it.effect("discards findings when a dependency changes during background analysis", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const service = yield* MonolithReviewService.MonolithReviewService;
    const started = yield* service.start({ cwd: root });
    yield* service.awaitIdle({ cwd: root, runId: started.runId });
    const run = yield* service.get({ cwd: root, runId: started.runId });
    expect(run.status).toBe("stale");
    expect(run.coverage.checkedFiles).toBe(0);
    expect(
      run.groups.flatMap((group) => group.files).every((file) => file.checks === undefined),
    ).toBe(true);
    expect(run.groups[0]?.aiPackage?.complete).toBe(false);
  }).pipe(
    Effect.provide(
      reviewLayer((input) =>
        Effect.gen(function* () {
          const files = yield* realBatch(input);
          yield* write(input.cwd, "api/composer.json", '{"require":{"something":"changed"}}');
          return files;
        }).pipe(Effect.orDie, Effect.provide(NodeServices.layer)),
      ).pipe(Layer.provideMerge(testGit)),
    ),
  ),
);

it.effect(
  "starts non-blocking, rejects concurrent jobs and cancels an analyzer without publishing late results",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const service = yield* MonolithReviewService.MonolithReviewService;
        const started = yield* service.start({ cwd: root });
        expect(started.status).toBe("queued");
        yield* Deferred.await(entered);
        const concurrent = yield* service.start({ cwd: root }).pipe(Effect.result);
        expect(concurrent._tag).toBe("Failure");
        const cancelled = yield* service.cancel({ cwd: root, runId: started.runId });
        expect(cancelled.status).toBe("cancelled");
        yield* service.awaitIdle({ cwd: root, runId: started.runId });
        yield* Deferred.succeed(release, undefined);
        expect((yield* service.get({ cwd: root, runId: started.runId })).status).toBe("cancelled");
      }).pipe(
        Effect.provide(
          reviewLayer((input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* batchWithNode(input);
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(testGit)),
);

it.effect("detects ignored extension configuration changes without relying on Git status", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    yield* write(root, ".gitignore", "api/.mago/\n");
    yield* gitCommand(root, ["add", ".gitignore"]);
    yield* gitCommand(root, ["commit", "-m", "ignore generated extension configuration"]);
    yield* write(root, "api/.mago/extension.php", "<?php return ['warning' => 10];\n");
    expect((yield* gitCommand(root, ["status", "--porcelain"])).stdout).toBe("");
    const service = yield* MonolithReviewService.MonolithReviewService;
    const started = yield* service.start({ cwd: root });
    yield* service.awaitIdle({ cwd: root, runId: started.runId });
    const run = yield* service.get({ cwd: root, runId: started.runId });
    expect(run.status).toBe("stale");
    expect(
      run.groups.flatMap((group) => group.files).every((file) => file.checks === undefined),
    ).toBe(true);
  }).pipe(
    Effect.provide(
      reviewLayer((input) =>
        Effect.gen(function* () {
          const files = yield* realBatch(input);
          yield* write(input.cwd, "api/.mago/extension.php", "<?php return ['warning' => 50];\n");
          return files;
        }).pipe(Effect.orDie, Effect.provide(NodeServices.layer)),
      ).pipe(Layer.provideMerge(testGit)),
    ),
  ),
);

it.effect("bounds analyzer result retention and omits all heavy detail from compact polling", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const service = yield* MonolithReviewService.MonolithReviewService;
    const started = yield* service.start({ cwd: root });
    yield* service.awaitIdle({ cwd: root, runId: started.runId });
    const full = yield* service.get({ cwd: root, runId: started.runId });
    const file = full.groups[0]?.files.find((file) => file.path === "api/Demo.php");
    expect(file?.checks).toBeUndefined();
    expect(file?.checksTruncated).toBe(true);
    expect(file?.checkStatus).toBe("failed");
    expect(full.coverage.checkedFiles).toBe(0);
    expect(full.groups[0]?.aiPackage?.complete).toBe(false);
    const compact = yield* service.get({ cwd: root, runId: started.runId, includeDetails: false });
    expect(
      compact.groups.every(
        (group) =>
          group.aiPackage === undefined &&
          group.files.every((file) => file.patch === "" && file.checks === undefined),
      ),
    ).toBe(true);
    expect(full.groups[0]?.files[0]?.patch).not.toBe("");
  }).pipe(
    Effect.provide(
      reviewLayer((input) =>
        batchWithNode(input).pipe(
          Effect.map((files) =>
            files.map((file) => ({
              ...file,
              result: {
                ...file.result,
                diagnostics: [
                  {
                    path: file.path,
                    message: "x".repeat(300000),
                    tool: "mago",
                    operation: "analyze",
                    ruleId: "example",
                    severity: "warning",
                  },
                ],
              },
            })),
          ),
        ),
      ).pipe(Layer.provideMerge(testGit)),
    ),
  ),
);

it.effect(
  "reviews more than 100 source files in bounded batches with one shared full-area context",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      for (let i = 0; i < 140; i++) yield* write(root, `api/F${i}.php`, `<?php class F${i} {}\n`);
      yield* gitCommand(root, ["add", "."]);
      yield* gitCommand(root, ["commit", "-m", "large PR"]);
      const calls: Parameters<
        MonolithAnalyzerService.MonolithAnalyzerService["Service"]["indexArea"]
      >[0][] = [];
      yield* Effect.gen(function* () {
        const service = yield* MonolithReviewService.MonolithReviewService;
        const started = yield* service.start({ cwd: root });
        yield* service.awaitIdle({ cwd: root, runId: started.runId });
        const run = yield* service.get({ cwd: root, runId: started.runId });
        expect(run.status).toBe("completed");
        expect(run.coverage.checkedFiles).toBe(141);
        expect(calls.length).toBe(2);
        expect(calls.every((call) => call.paths.length <= 128)).toBe(true);
        expect(calls[0]?.snapshot?.key).toBe(calls[1]?.snapshot?.key);
        expect(calls[0]?.snapshot?.paths).toContain("api/Context.php");
        expect(calls[0]?.snapshot?.paths).not.toContain("api/Gone.php");
      }).pipe(
        Effect.provide(
          reviewLayer((input) => {
            calls.push(input);
            return batchWithNode(input);
          }),
        ),
      );
    }).pipe(Effect.provide(testGit)),
);

it.effect(
  "retains an oversized untracked file as an explicit omission while checking the other sources",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFile(`${root}/large.bin`, new Uint8Array(33 * 1024 * 1024));
      const service = yield* MonolithReviewService.MonolithReviewService;
      const started = yield* service.start({ cwd: root, includeWorkingTree: true });
      yield* service.awaitIdle({ cwd: root, runId: started.runId });
      const run = yield* service.get({ cwd: root, runId: started.runId });
      expect(run.status).toBe("completed");
      expect(run.coverage.checkedFiles).toBe(1);
      const large = run.groups
        .flatMap((group) => group.files)
        .find((file) => file.path === "large.bin");
      expect(large?.fileHash).toBeUndefined();
      expect(large?.patchTruncated).toBe(true);
      expect(large?.checkStatus).toBe("skipped");
      expect(large?.message).toContain("32 MiB");
    }).pipe(Effect.provide(reviewLayer(batchWithNode).pipe(Layer.provideMerge(testGit)))),
);

it.effect(
  "fingerprints untracked binary bytes even when both invalid UTF8 sequences decode to the same text",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFile(`${root}/binary.bin`, new Uint8Array([255]));
      const service = yield* MonolithReviewService.MonolithReviewService;
      const started = yield* service.start({ cwd: root, includeWorkingTree: true });
      yield* service.awaitIdle({ cwd: root, runId: started.runId });
      expect((yield* service.get({ cwd: root, runId: started.runId })).status).toBe("stale");
    }).pipe(
      Effect.provide(
        reviewLayer((input) =>
          Effect.gen(function* () {
            const files = yield* realBatch(input);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFile(`${input.cwd}/binary.bin`, new Uint8Array([254]));
            return files;
          }).pipe(Effect.orDie, Effect.provide(NodeServices.layer)),
        ).pipe(Layer.provideMerge(testGit)),
      ),
    ),
);

it.effect("discards partial findings when the final snapshot cannot be verified", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const service = yield* MonolithReviewService.MonolithReviewService;
    const started = yield* service.start({ cwd: root });
    yield* service.awaitIdle({ cwd: root, runId: started.runId });
    const run = yield* service.get({ cwd: root, runId: started.runId });
    expect(run.status).toBe("failed");
    expect(run.coverage.checkedFiles).toBe(0);
    expect(
      run.groups.flatMap((group) => group.files).every((file) => file.checks === undefined),
    ).toBe(true);
  }).pipe(
    Effect.provide(
      reviewLayer((input) =>
        Effect.gen(function* () {
          const files = yield* realBatch(input);
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${input.cwd}/api/.mago/extension.php`, { recursive: true });
          return files;
        }).pipe(Effect.orDie, Effect.provide(NodeServices.layer)),
      ).pipe(Layer.provideMerge(testGit)),
    ),
  ),
);

it.effect(
  "fingerprints untracked symlinks without following targets and omits their source checks",
  () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.symlink("Context.php", `${root}/api/Alias.php`);
      const service = yield* MonolithReviewService.MonolithReviewService;
      const started = yield* service.start({ cwd: root, includeWorkingTree: true });
      yield* service.awaitIdle({ cwd: root, runId: started.runId });
      const run = yield* service.get({ cwd: root, runId: started.runId });
      expect(run.status).toBe("completed");
      expect(run.coverage.checkedFiles).toBe(1);
      const alias = run.groups[0]?.files.find((file) => file.path === "api/Alias.php");
      expect(alias?.checks).toBeUndefined();
      expect(alias?.checkStatus).toBe("skipped");
    }).pipe(Effect.provide(reviewLayer(batchWithNode).pipe(Layer.provideMerge(testGit)))),
);

it.effect("atomically admits only one of two concurrent starts for the same workspace", () =>
  Effect.gen(function* () {
    const root = yield* setup;
    const entered = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* MonolithReviewService.MonolithReviewService;
      const results = yield* Effect.all(
        [
          service.start({ cwd: root }).pipe(Effect.result),
          service.start({ cwd: root }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(results.filter((result) => result._tag === "Success").length).toBe(1);
      expect(results.filter((result) => result._tag === "Failure").length).toBe(1);
      const accepted = results.find((result) => result._tag === "Success");
      if (accepted?._tag !== "Success") return yield* Effect.die("No job was admitted");
      yield* Deferred.await(entered);
      yield* service.cancel({ cwd: root, runId: accepted.success.runId });
    }).pipe(
      Effect.provide(
        reviewLayer((input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(blocked);
            return yield* batchWithNode(input);
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(testGit)),
);
