import {
  type MonolithReviewStartInput,
  type MonolithReviewGetInput,
  type MonolithReviewRun,
  type MonolithReviewFile,
  type MonolithReviewGroup,
} from "@t3tools/contracts";
import { groupFilesByMonolithArea, matchMonolithArea } from "@t3tools/shared/monolithAreas";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as MonolithAnalyzerService from "./MonolithAnalyzerService.ts";
import * as MonolithService from "./MonolithService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { buildMonolithReviewPackages } from "./monolithReviewPackages.ts";

const MAX_FILES = 5000;
const PATCH_BYTES = 64 * 1024;
const TOTAL_PATCH_BYTES = 4 * 1024 * 1024;
type MutableGroup = { -readonly [K in keyof MonolithReviewGroup]: MonolithReviewGroup[K] };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class MonolithReviewError extends Schema.TaggedError<MonolithReviewError>()(
  "MonolithReviewError",
  {
    operation: Schema.Literals(["start", "get", "cancel"]),
    reason: Schema.Literals(["configuration", "git", "filesystem", "limit", "not_found", "busy"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `PR review could not complete (${this.reason}).`;
  }
}
const isReviewError = Schema.is(MonolithReviewError);

export class MonolithReviewService extends Context.Service<
  MonolithReviewService,
  {
    readonly start: (
      input: MonolithReviewStartInput,
    ) => Effect.Effect<MonolithReviewRun, MonolithReviewError>;
    readonly get: (
      input: MonolithReviewGetInput,
    ) => Effect.Effect<MonolithReviewRun, MonolithReviewError>;
    readonly cancel: (
      input: MonolithReviewGetInput,
    ) => Effect.Effect<MonolithReviewRun, MonolithReviewError>;
    /** Waits for a registered job, including failures and cancellation. */
    readonly awaitIdle: (input: MonolithReviewGetInput) => Effect.Effect<void, MonolithReviewError>;
  }
>()("t3/project/MonolithReviewService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const monolith = yield* MonolithService.MonolithService;
  const analyzer = yield* MonolithAnalyzerService.MonolithAnalyzerService;
  const scope = yield* Scope.Scope;
  const jobs = new Map<
    string,
    { run: MonolithReviewRun; fiber?: Fiber.Fiber<void> | undefined; done: Deferred.Deferred<void> }
  >();
  const active = new Map<string, string>();
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const hashBytes = (value: Uint8Array) =>
    crypto.digest("SHA-256", value).pipe(Effect.map(Hex.encode), Effect.orDie);
  const hash = (value: string) => hashBytes(new TextEncoder().encode(value));
  const readGit = (
    cwd: string,
    args: readonly string[],
    maxOutputBytes = 16 * 1024 * 1024,
    allowNonZeroExit = false,
  ) =>
    git
      .execute({
        cwd,
        args,
        operation: "MonolithReviewService.read",
        maxOutputBytes,
        allowNonZeroExit,
      })
      .pipe(
        Effect.mapError(
          (cause) => new MonolithReviewError({ operation: "start", reason: "git", cause }),
        ),
      );
  const rootOf = (cwd: string) =>
    fs
      .realPath(path.resolve(cwd))
      .pipe(
        Effect.mapError(
          (cause) => new MonolithReviewError({ operation: "start", reason: "filesystem", cause }),
        ),
      );
  const safeBytes = Effect.fnUntraced(function* (cwd: string, relative: string, limit: number) {
    const absolute = path.resolve(cwd, relative);
    if (
      path.relative(cwd, absolute).split(path.sep).join("/") !== relative ||
      (yield* fs.realPath(absolute)) !== absolute
    )
      return yield* new MonolithReviewError({ operation: "start", reason: "filesystem" });
    const stat = yield* fs.stat(absolute);
    if (stat.type !== "File")
      return yield* new MonolithReviewError({ operation: "start", reason: "filesystem" });
    if (stat.size > limit)
      return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
    return yield* fs.readFile(absolute);
  });
  const safeContents = (cwd: string, relative: string, limit: number) =>
    safeBytes(cwd, relative, limit).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("utf8")),
    );
  // The Git patch includes tracked content, not timestamps. Untracked files need their own hashes.
  // This detects dirty dependency/configuration changes as well as changed review files.
  const identity = Effect.fnUntraced(function* (cwd: string) {
    const [head, status, patch, untracked] = yield* Effect.all(
      [
        readGit(cwd, ["rev-parse", "--verify", "HEAD"], 1024),
        readGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        readGit(
          cwd,
          ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"],
          256 * 1024 * 1024,
        ),
        readGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ],
      { concurrency: 4 },
    );
    if ([head, status, patch, untracked].some((item) => item.stdoutTruncated))
      return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
    const currentConfig = yield* monolith
      .get({ cwd })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MonolithReviewError({ operation: "start", reason: "configuration", cause }),
        ),
      );
    const installations = yield* analyzer
      .discover({ cwd })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MonolithReviewError({ operation: "start", reason: "configuration", cause }),
        ),
      );
    const configurationPaths = new Set<string>();
    for (const area of currentConfig.config.areas.filter((area) => area.enabled !== false)) {
      for (const directory of [area.path, path.join(area.path, "tools")])
        for (const name of [
          "composer.json",
          "composer.lock",
          "package.json",
          "pnpm-lock.yaml",
          "package-lock.json",
          "yarn.lock",
          "mago.toml",
          "biome.json",
          "biome.jsonc",
          ".mago/extension.php",
          ".mago/container-reference.dev.json",
          "vendor/composer/installed.json",
        ])
          configurationPaths.add(
            path
              .relative(cwd, path.resolve(cwd, directory, name))
              .split(path.sep)
              .join("/"),
          );
    }
    for (const installation of installations.flatMap((area) => area.tools)) {
      for (const candidate of [
        installation.manifestPath,
        installation.configPath,
        ...installation.scripts.map((script) => script.configPath),
        installation.symfonyWiringReference?.referencePath,
      ])
        if (candidate) configurationPaths.add(candidate);
    }
    const configurationHashes: string[] = [];
    for (const candidate of [...configurationPaths].sort()) {
      const absolute = path.resolve(cwd, candidate);
      if (!(yield* fs.exists(absolute))) {
        configurationHashes.push(`${candidate}\0missing`);
        continue;
      }
      const contents = yield* safeBytes(cwd, candidate, 64 * 1024 * 1024);
      configurationHashes.push(`${candidate}\0${yield* hashBytes(contents)}`);
    }
    const names = untracked.stdout.split("\0").filter(Boolean).sort();
    if (names.length > MAX_FILES)
      return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
    const records: string[] = [];
    let bytes = 0;
    for (const name of names) {
      const link = yield* fs.readLink(path.resolve(cwd, name)).pipe(Effect.result);
      if (link._tag === "Success") {
        records.push(`${name}\0symlink:${yield* hash(link.success)}`);
        continue;
      }
      const contents = yield* safeBytes(cwd, name, 256 * 1024 * 1024);
      bytes += contents.byteLength;
      if (bytes > 256 * 1024 * 1024)
        return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
      records.push(`${name}\0${yield* hashBytes(contents)}`);
    }
    return {
      key: yield* hash(
        encodeJson([
          head.stdout,
          status.stdout,
          patch.stdout,
          records,
          currentConfig.config,
          installations,
          configurationHashes,
        ]),
      ),
      headCommit: head.stdout.trim(),
      configIdentity: yield* hash(encodeJson(currentConfig.config)),
      dirty: status.stdout.length > 0,
      untracked: names,
    };
  });
  const readFiles = Effect.fnUntraced(function* (
    cwd: string,
    base: string,
    head: string,
    working: boolean,
    untracked: readonly string[],
  ) {
    const metadata = yield* readGit(cwd, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      base,
      ...(working ? [] : [head]),
      "--",
    ]);
    if (metadata.stdoutTruncated)
      return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
    const tokens = metadata.stdout.split("\0");
    const records: { path: string; oldPath?: string; status: MonolithReviewFile["status"] }[] = [];
    for (let i = 0; i < tokens.length && tokens[i];) {
      const code = tokens[i++]!;
      const name = tokens[i++]!;
      const status =
        ({ A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechanged" } as const)[
          code[0] as "A" | "D" | "R" | "C" | "T"
        ] ?? "modified";
      records.push(
        code.startsWith("R") || code.startsWith("C")
          ? { path: tokens[i++]!, oldPath: name, status }
          : { path: name, status },
      );
    }
    if (working)
      for (const name of untracked)
        if (!records.some((item) => item.path === name))
          records.push({ path: name, status: "untracked" });
    const files: MonolithReviewFile[] = [];
    let remaining = TOTAL_PATCH_BYTES;
    for (const record of records.slice(0, MAX_FILES)) {
      let patch = "";
      let truncated = false;
      let fileHash: string | undefined;
      let sourceMessage: string | undefined;
      if (record.status === "untracked") {
        const captured = yield* safeBytes(cwd, record.path, 32 * 1024 * 1024).pipe(Effect.result);
        if (captured._tag === "Failure") {
          sourceMessage =
            "The source snapshot is unavailable or exceeds the 32 MiB capture limit; its patch and checks were omitted.";
          truncated = true;
        } else {
          const contents = Buffer.from(captured.success).toString("utf8");
          fileHash = yield* hashBytes(captured.success);
          const binary =
            captured.success.includes(0) ||
            !Buffer.from(contents).equals(Buffer.from(captured.success));
          if (binary)
            sourceMessage =
              "This is a binary source snapshot; no textual patch or automatic source checks are available.";
          if (remaining > 0) {
            const diff = yield* readGit(
              cwd,
              [
                "diff",
                "--no-index",
                "--patch",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
                "/dev/null",
                record.path,
              ],
              Math.min(PATCH_BYTES, remaining),
              true,
            );
            if (diff.exitCode > 1)
              sourceMessage =
                "The untracked source patch could not be captured. Automatic checks were omitted.";
            patch = diff.stdout;
            truncated = diff.stdoutTruncated || diff.exitCode > 1;
          } else truncated = true;
        }
      } else if (remaining > 0) {
        const result = yield* readGit(
          cwd,
          [
            "diff",
            "--patch",
            "--find-renames",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            base,
            ...(working ? [] : [head]),
            "--",
            ...[record.path, ...(record.oldPath ? [record.oldPath] : [])].map(
              (name) => `:(top,literal)${name}`,
            ),
          ],
          Math.min(PATCH_BYTES, remaining),
        );
        patch = result.stdout;
        truncated = result.stdoutTruncated;
      } else truncated = true;
      remaining = Math.max(0, remaining - Buffer.byteLength(patch));
      if (record.status !== "deleted" && record.status !== "untracked" && fileHash === undefined) {
        const captured = yield* (
          working
            ? safeBytes(cwd, record.path, 32 * 1024 * 1024).pipe(
                Effect.map((bytes) => ({ bytes, truncated: false })),
              )
            : readGit(cwd, ["show", `${head}:${record.path}`], 32 * 1024 * 1024).pipe(
                Effect.map((result) => ({
                  bytes: new TextEncoder().encode(result.stdout),
                  truncated: result.stdoutTruncated,
                })),
              )
        ).pipe(Effect.result);
        if (
          captured._tag === "Success" &&
          !captured.success.truncated &&
          !captured.success.bytes.includes(0) &&
          !Buffer.from(captured.success.bytes).toString("utf8").includes("\ufffd")
        )
          fileHash = yield* hashBytes(captured.success.bytes);
        else
          sourceMessage =
            "The full source snapshot is unavailable, unsupported, or exceeds the 32 MiB capture limit. Automatic checks were omitted.";
      }
      files.push({
        ...record,
        patch,
        patchHash: yield* hash(patch),
        patchTruncated: truncated,
        ...(fileHash ? { fileHash } : {}),
        checkStatus: sourceMessage ? "skipped" : "pending",
        ...(sourceMessage ? { message: sourceMessage } : {}),
      });
    }
    return { files, total: records.length, omitted: Math.max(0, records.length - files.length) };
  });
  const lookup = Effect.fnUntraced(function* (input: MonolithReviewGetInput) {
    const cwd = yield* rootOf(input.cwd);
    const job = jobs.get(input.runId);
    if (!job || job.run.cwd !== cwd)
      return yield* new MonolithReviewError({ operation: "get", reason: "not_found" });
    return job;
  });
  const start = Effect.fn("MonolithReviewService.start")(function* (
    input: MonolithReviewStartInput,
  ) {
    const cwd = yield* rootOf(input.cwd);
    if (active.has(cwd) || active.size >= 4)
      return yield* new MonolithReviewError({ operation: "start", reason: "busy" });
    const snapshot = yield* monolith
      .get({ cwd })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MonolithReviewError({ operation: "start", reason: "configuration", cause }),
        ),
      );
    let baseRef = input.baseRef ?? snapshot.config.defaultBaseBranch;
    if (!baseRef) {
      const remoteHead = yield* readGit(
        cwd,
        ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        1024,
        true,
      );
      baseRef = remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : undefined;
      if (!baseRef)
        for (const candidate of ["main", "master"]) {
          const resolved = yield* readGit(
            cwd,
            ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
            1024,
            true,
          );
          if (resolved.exitCode === 0) {
            baseRef = candidate;
            break;
          }
        }
      if (!baseRef) baseRef = "main";
    }
    if (baseRef.startsWith("-") || /[\0\r\n]/.test(baseRef))
      return yield* new MonolithReviewError({ operation: "start", reason: "git" });
    const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* timestamp;
    const initial: MonolithReviewRun = {
      runId,
      cwd,
      baseRef,
      baseCommit: "",
      mergeBase: "",
      headCommit: "",
      worktreeIdentity: "",
      revision: "",
      includeWorkingTree: input.includeWorkingTree ?? false,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      groups: [],
      coverage: { totalFiles: 0, checkedFiles: 0, omittedFiles: 0, truncatedPatches: 0 },
    };
    const job = {
      run: initial,
      done: yield* Deferred.make<void>(),
      fiber: undefined as Fiber.Fiber<void> | undefined,
    };
    // Root/configuration reads can yield; reserve atomically after those reads so two
    // concurrent starts cannot both claim one workspace or exceed the active limit.
    if (active.has(cwd) || active.size >= 4)
      return yield* new MonolithReviewError({ operation: "start", reason: "busy" });
    for (const [id, retained] of jobs)
      if (jobs.size >= 8 && !active.has(retained.run.cwd)) jobs.delete(id);
    jobs.set(runId, job);
    active.set(cwd, runId);
    const update = (fields: Partial<MonolithReviewRun>) =>
      timestamp.pipe(
        Effect.map((updatedAt) => {
          job.run = {
            ...job.run,
            ...fields,
            ...(fields.groups
              ? { groups: fields.groups.map((group) => ({ ...group, files: [...group.files] })) }
              : {}),
            updatedAt,
          };
        }),
      );
    const fail = (message: string) =>
      update({
        status: "failed",
        message,
        groups: job.run.groups.map(({ aiPackage: _aiPackage, ...group }) => ({
          ...group,
          files: group.files.map(({ checks: _checks, ...file }) => ({
            ...file,
            checkStatus: "stale",
            message:
              "Review could not verify the final repository snapshot; findings were discarded.",
          })),
        })),
        coverage: { ...job.run.coverage, checkedFiles: 0 },
      });
    const work = Effect.gen(function* () {
      yield* update({ status: "running" });
      const headCommit = (yield* readGit(
        cwd,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        1024,
      )).stdout.trim();
      const baseCommit = (yield* readGit(
        cwd,
        ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
        1024,
      )).stdout.trim();
      const mergeBase = (yield* readGit(
        cwd,
        ["merge-base", baseCommit, headCommit],
        1024,
      )).stdout.trim();
      const source = yield* identity(cwd);
      if (
        source.headCommit !== headCommit ||
        source.configIdentity !== (yield* hash(encodeJson(snapshot.config)))
      ) {
        yield* update({
          status: "stale",
          headCommit,
          baseCommit,
          mergeBase,
          message:
            "The repository changed while the review target was being captured. Start a new review.",
        });
        return;
      }
      const changed = yield* readFiles(
        cwd,
        mergeBase,
        headCommit,
        initial.includeWorkingTree,
        source.untracked,
      );
      const groups: MutableGroup[] = groupFilesByMonolithArea(
        changed.files,
        snapshot.config.areas,
        (file) => file,
      ).map((group) => ({
        areaId: group.area?.id ?? null,
        name: group.name,
        path: group.area?.path ?? "",
        kind: group.area?.kind ?? "other",
        files: group.files,
      }));
      const revision = yield* hash(
        encodeJson([
          baseCommit,
          mergeBase,
          headCommit,
          source.key,
          changed.files.map((file) => [file.path, file.fileHash, file.patchHash]),
          snapshot.config,
        ]),
      );
      const coverage = {
        totalFiles: changed.total,
        checkedFiles: 0,
        omittedFiles: changed.omitted,
        truncatedPatches: changed.files.filter((file) => file.patchTruncated).length,
      };
      yield* update({
        headCommit,
        baseCommit,
        mergeBase,
        worktreeIdentity: source.key,
        revision,
        groups,
        coverage,
      });
      const listed = yield* readGit(cwd, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      if (listed.stdoutTruncated)
        return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
      const deletedPaths = new Set(
        changed.files.filter((file) => file.status === "deleted").map((file) => file.path),
      );
      const unsupportedPaths = new Set(
        changed.files.filter((file) => file.message !== undefined).map((file) => file.path),
      );
      const indexedModes = yield* readGit(cwd, ["ls-files", "--stage", "-z"]);
      if (indexedModes.stdoutTruncated)
        return yield* new MonolithReviewError({ operation: "start", reason: "limit" });
      for (const entry of indexedModes.stdout.split("\0"))
        if (/^(?:120000|160000) /.test(entry))
          unsupportedPaths.add(entry.slice(entry.indexOf("\t") + 1));
      const allPaths = [
        ...new Set(
          listed.stdout
            .split("\0")
            .filter(
              (name) => name.length > 0 && !deletedPaths.has(name) && !unsupportedPaths.has(name),
            ),
        ),
      ];
      let stale = false;
      let retainedCheckBytes = 0;
      for (const group of groups) {
        const files = [...group.files];
        const selected: MonolithReviewFile[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          const applicable =
            group.kind === "php"
              ? /\.(?:php|ya?ml)$/i.test(file.path)
              : group.kind === "react"
                ? /\.(?:[cm]?[jt]sx?|jsonc?|css)$/i.test(file.path)
                : false;
          const message =
            file.message ??
            (file.status === "deleted"
              ? "Deleted files cannot be analyzed in the current workspace."
              : !applicable
                ? "No automatic analyzer applies to this file."
                : !initial.includeWorkingTree && source.dirty
                  ? "Checks skipped: the working tree differs from the committed review target. Include working-tree changes or use a clean checkout."
                  : undefined);
          if (message) files[i] = { ...file, checkStatus: "skipped", message };
          else selected.push(file);
        }
        const eligible: MonolithReviewFile[] = [];
        for (const file of selected) {
          const sourceContents = yield* safeContents(cwd, file.path, 2 * 1024 * 1024).pipe(
            Effect.result,
          );
          if (sourceContents._tag === "Failure") {
            files[files.findIndex((item) => item.path === file.path)] = {
              ...file,
              checkStatus: "skipped",
              message: "This file exceeds automatic check limits or is not a regular source file.",
            };
          } else eligible.push(file);
        }
        group.files = files;
        yield* update({ groups });
        for (let offset = 0; offset < eligible.length; offset += 128) {
          if ((yield* identity(cwd)).key !== source.key) {
            stale = true;
            break;
          }
          const batch = eligible.slice(offset, offset + 128);
          for (const file of batch)
            files[files.findIndex((item) => item.path === file.path)] = {
              ...file,
              checkStatus: "running",
            };
          yield* update({ groups });
          const areaPaths = allPaths.filter(
            (candidate) =>
              matchMonolithArea({ path: candidate }, snapshot.config.areas)?.id === group.areaId &&
              !/(?:^|\/)(?:vendor|node_modules|\.git|\.t3)\//.test(candidate),
          );
          const result = yield* analyzer
            .indexArea({
              cwd,
              areaId: group.areaId!,
              paths: batch.map((file) => file.path),
              ...(group.kind === "php" && areaPaths.length <= 50000
                ? { snapshot: { key: revision, paths: areaPaths } }
                : {}),
            })
            .pipe(Effect.result);
          for (const file of batch) {
            const checks =
              result._tag === "Success"
                ? result.success.find((item) => item.path === file.path)?.result
                : undefined;
            const checkBytes = checks ? Buffer.byteLength(encodeJson(checks)) : 0;
            const oversized =
              checkBytes > 256 * 1024 || retainedCheckBytes + checkBytes > 8 * 1024 * 1024;
            files[files.findIndex((item) => item.path === file.path)] =
              checks && checks.revision === file.fileHash && !oversized
                ? { ...file, checkStatus: "completed", checks }
                : {
                    ...file,
                    checkStatus: "failed",
                    ...(oversized ? { checksTruncated: true } : {}),
                    message: oversized
                      ? "Analyzer results exceeded the review context size limit and were omitted."
                      : "Automatic checks could not complete for this source snapshot.",
                  };
            if (checks?.revision === file.fileHash && !oversized) {
              coverage.checkedFiles++;
              retainedCheckBytes += checkBytes;
            }
          }
          yield* update({ groups, coverage });
        }
        if (stale) break;
      }
      stale ||= (yield* identity(cwd)).key !== source.key;
      if (stale) {
        for (const group of groups)
          group.files = group.files.map(({ checks: _checks, ...file }) => ({
            ...file,
            checkStatus: "stale",
            message:
              "The repository changed during review. Start a new review to obtain current findings.",
          }));
        coverage.checkedFiles = 0;
      }
      const finalStatus = stale ? "stale" : "completed";
      const packaged = buildMonolithReviewPackages(
        { ...job.run, groups, coverage, status: finalStatus },
        snapshot.config,
      );
      yield* update({
        status: finalStatus,
        groups: packaged,
        coverage,
        ...(stale
          ? {
              message:
                "Repository content changed while checks were running; analyzer findings were discarded.",
            }
          : {}),
      });
    }).pipe(
      Effect.catch((cause) =>
        fail(isReviewError(cause) ? cause.message : "PR review could not complete (filesystem)."),
      ),
      Effect.catchDefect(() => fail("PR review could not complete.")),
      Effect.ensuring(
        Effect.gen(function* () {
          if (active.get(cwd) === runId) active.delete(cwd);
          yield* Deferred.succeed(job.done, undefined);
        }),
      ),
    );
    job.fiber = yield* work.pipe(Effect.forkIn(scope));
    return initial;
  });
  return MonolithReviewService.of({
    start,
    get: (input) =>
      lookup(input).pipe(
        Effect.map((job) =>
          input.includeDetails === false
            ? {
                ...job.run,
                groups: job.run.groups.map(({ aiPackage: _aiPackage, ...group }) => ({
                  ...group,
                  files: group.files.map(({ checks: _checks, patch: _patch, ...file }) => ({
                    ...file,
                    patch: "",
                  })),
                })),
              }
            : job.run,
        ),
      ),
    cancel: (input) =>
      Effect.gen(function* () {
        const job = yield* lookup(input);
        if (job.run.status === "queued" || job.run.status === "running") {
          job.run = {
            ...job.run,
            status: "cancelled",
            updatedAt: yield* timestamp,
            message: "Review cancelled.",
          };
          if (job.fiber) yield* Fiber.interrupt(job.fiber);
        }
        return job.run;
      }),
    awaitIdle: (input) => lookup(input).pipe(Effect.flatMap((job) => Deferred.await(job.done))),
  });
});
export const layer = Layer.effect(MonolithReviewService, make);
