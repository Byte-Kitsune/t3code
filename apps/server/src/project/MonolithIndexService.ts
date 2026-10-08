import {
  MonolithCheckFileResult,
  MonolithArea,
  type MonolithCheckFileInput,
  type MonolithIndexInput,
  type MonolithIndexStatus,
  type MonolithIndexStatusInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { matchMonolithArea } from "@t3tools/shared/monolithAreas";
import * as MonolithAnalyzerService from "./MonolithAnalyzerService.ts";
import * as MonolithService from "./MonolithService.ts";

const MiB = 1024 * 1024;
const MAX_SCAN_ENTRIES = 100000;
const MAX_SOURCE_FILES = 50000;
const MAX_SOURCE_BYTES = 256 * MiB;
const MAX_FINGERPRINT_BYTES = 512 * MiB;
const MAX_SOURCE_FILE_BYTES = 2 * MiB;
const MAX_DEPENDENCY_FILE_BYTES = 64 * MiB;
const MAX_BATCH_FILES = 2000;
const MAX_BATCH_BYTES = 32 * MiB;
const MAX_CACHE_BYTES = 64 * MiB;

export class MonolithIndexError extends Schema.TaggedError<MonolithIndexError>()(
  "MonolithIndexError",
  {
    operation: Schema.Literals(["index", "status", "check"]),
    reason: Schema.Literals(["configuration", "filesystem", "unsafe_path", "limit", "analysis"]),
    limit: Schema.optional(
      Schema.Literals([
        "scan_entries",
        "source_files",
        "source_bytes",
        "fingerprint_bytes",
        "source_file_bytes",
        "dependency_file_bytes",
        "cache_bytes",
      ]),
    ),
    path: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    if (this.reason === "limit") {
      switch (this.limit) {
        case "scan_entries":
          return "Automatic indexing exceeded the limit of 100,000 filesystem entries in this area.";
        case "source_files":
          return "Automatic indexing exceeded the limit of 50,000 source files in this area.";
        case "source_bytes":
          return "Automatic indexing exceeded the 256 MiB source-content limit for this area.";
        case "fingerprint_bytes":
          return "Automatic indexing exceeded the 512 MiB source and dependency-content limit for this area.";
        case "source_file_bytes":
          return `The source file ${this.path ?? "in this area"} exceeds the 2 MiB automatic indexing limit. Other files can still be checked individually.`;
        case "dependency_file_bytes":
          return `The dependency file ${this.path ?? "in this area"} exceeds the 64 MiB automatic indexing limit.`;
        case "cache_bytes":
          return "The analysis results exceed the 64 MiB area-cache limit. Reduce the indexed area or exclude generated folders.";
      }
    }
    return `Monolith indexing could not complete (${this.reason}).`;
  }
}

export type MonolithAreaIndexStatus = {
  readonly areaId: string;
  readonly status: "idle" | "indexing" | "ready" | "stale" | "failed";
  readonly fileCount: number;
  readonly revision?: string;
  readonly message?: string;
};

const CacheEntry = Schema.Struct({ path: Schema.String, result: MonolithCheckFileResult });
const encodeCacheEntry = Schema.encodeSync(Schema.fromJsonString(CacheEntry));
const Cache = Schema.Struct({
  version: Schema.Literal(3),
  signature: Schema.String,
  createdAt: Schema.Number,
  files: Schema.Array(CacheEntry).check(Schema.isMaxLength(MAX_SOURCE_FILES)),
});
type Cache = typeof Cache.Type;
const decodeCache = Schema.decodeUnknownSync(Schema.fromJsonString(Cache));
const encodeCache = Schema.encodeSync(Schema.fromJsonString(Cache));
const encodeFingerprint = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      area: MonolithArea,
      records: Schema.Array(Schema.Array(Schema.String)),
    }),
  ),
);
export const isMonolithIndexError = Schema.is(MonolithIndexError);
const skippedDirectories = new Set(["vendor", "node_modules", ".git", ".t3", ".cache", ".next"]);

export class MonolithIndexService extends Context.Service<
  MonolithIndexService,
  {
    readonly index: (
      input: MonolithIndexInput,
    ) => Effect.Effect<MonolithIndexStatus, MonolithIndexError>;
    readonly status: (
      input: MonolithIndexStatusInput,
    ) => Effect.Effect<MonolithIndexStatus, MonolithIndexError>;
    /** Waits for the jobs already registered for this workspace; failures are reported by status. */
    readonly awaitIdle: (input: {
      readonly cwd: string;
      readonly areaId?: string;
    }) => Effect.Effect<void, MonolithIndexError>;
    readonly checkFileCached: (
      input: MonolithCheckFileInput,
    ) => Effect.Effect<typeof MonolithCheckFileResult.Type, MonolithIndexError>;
  }
>()("t3/project/MonolithIndexService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const monolith = yield* MonolithService.MonolithService;
  const analyzer = yield* MonolithAnalyzerService.MonolithAnalyzerService;
  const permits = yield* Semaphore.make(2);
  const running = new Set<string>();
  const completions = new Map<string, Deferred.Deferred<void>>();
  const statuses = new Map<string, MonolithAreaIndexStatus>();
  const failedSignatures = new Map<string, string>();
  const memory = new Map<string, Cache>();
  const digest = (contents: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(contents)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) => new MonolithIndexError({ operation: "index", reason: "filesystem", cause }),
      ),
    );
  const keyOf = (root: string, areaId: string) => `${root}\0${areaId}`;
  const safeDirectory = Effect.fnUntraced(function* (directory: string) {
    if ((yield* fs.realPath(directory)) !== directory)
      return yield* new MonolithIndexError({ operation: "index", reason: "unsafe_path" });
  });
  const config = Effect.fnUntraced(function* (cwd: string) {
    const root = yield* fs
      .realPath(path.resolve(cwd))
      .pipe(
        Effect.mapError(
          (cause) => new MonolithIndexError({ operation: "index", reason: "filesystem", cause }),
        ),
      );
    const snapshot = yield* monolith
      .get({ cwd: root, initialize: false })
      .pipe(
        Effect.mapError(
          (cause) => new MonolithIndexError({ operation: "index", reason: "configuration", cause }),
        ),
      );
    return {
      root,
      allAreas: snapshot.config.areas,
      areas: snapshot.config.areas.filter(
        (area) => area.kind !== "folder" && area.enabled !== false,
      ),
    };
  });
  // Hash content rather than modification timestamps so checkout, pull and same-size edits invalidate graphs.
  const fingerprint = Effect.fnUntraced(function* (root: string, area: MonolithArea) {
    const groups = (yield* config(root)).allAreas;
    const areaRoot = path.resolve(root, area.path);
    const relativeRoot = path.relative(root, areaRoot);
    if (
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeRoot)
    )
      return yield* new MonolithIndexError({ operation: "index", reason: "unsafe_path" });
    yield* safeDirectory(areaRoot);
    const records: [string, string][] = [];
    const files: string[] = [];
    const revisions = new Map<string, string>();
    const sizes = new Map<string, number>();
    const recorded = new Set<string>();
    const folders = [areaRoot];
    let entries = 0;
    let sourceBytes = 0;
    let fingerprintBytes = 0;
    const addFile = Effect.fnUntraced(function* (absolute: string, source: boolean) {
      const info = yield* fs.stat(absolute);
      if (info.type !== "File") return;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (recorded.has(relative)) return;
      if (info.size > (source ? MAX_SOURCE_FILE_BYTES : MAX_DEPENDENCY_FILE_BYTES))
        return yield* new MonolithIndexError({
          operation: "index",
          reason: "limit",
          limit: source ? "source_file_bytes" : "dependency_file_bytes",
          path: relative.slice(0, 1024),
        });
      const contents = yield* fs.readFileString(absolute);
      const bytes = new TextEncoder().encode(contents).byteLength;
      if (source && (sourceBytes += bytes) > MAX_SOURCE_BYTES)
        return yield* new MonolithIndexError({
          operation: "index",
          reason: "limit",
          limit: "source_bytes",
        });
      if ((fingerprintBytes += bytes) > MAX_FINGERPRINT_BYTES)
        return yield* new MonolithIndexError({
          operation: "index",
          reason: "limit",
          limit: "fingerprint_bytes",
        });
      const hash = yield* digest(contents);
      records.push([relative, `${source ? "source" : "dependency"}:${hash}`]);
      recorded.add(relative);
      if (source) {
        files.push(relative);
        revisions.set(relative, hash);
        sizes.set(relative, bytes);
      }
    });
    while (folders.length) {
      const folder = folders.pop()!;
      for (const name of (yield* fs.readDirectory(folder)).toSorted()) {
        if (++entries > MAX_SCAN_ENTRIES)
          return yield* new MonolithIndexError({
            operation: "index",
            reason: "limit",
            limit: "scan_entries",
          });
        const absolute = path.join(folder, name);
        const info = yield* fs.stat(absolute);
        if ((yield* fs.realPath(absolute)) !== absolute) continue;
        if (info.type === "Directory") {
          if (
            !skippedDirectories.has(name) &&
            !["var/cache", "var/log"].includes(
              path.relative(areaRoot, absolute).split(path.sep).join("/"),
            )
          )
            folders.push(absolute);
        } else if (
          info.type === "File" &&
          /\.(?:php|[cm]?[jt]sx?|jsonc?|css|toml|lock|ya?ml)$/i.test(name)
        ) {
          const candidateSource =
            area.kind === "php"
              ? /\.(?:php|ya?ml)$/i.test(name)
              : /\.(?:[cm]?[jt]sx?|jsonc?|css)$/i.test(name);
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          const source =
            candidateSource && matchMonolithArea({ path: relative }, groups)?.id === area.id;
          yield* addFile(absolute, source);
          if (files.length > MAX_SOURCE_FILES)
            return yield* new MonolithIndexError({
              operation: "index",
              reason: "limit",
              limit: "source_files",
            });
          if (name === "composer.json") {
            const installed = path.join(folder, "vendor/composer/installed.json");
            if ((yield* fs.exists(installed)) && (yield* fs.realPath(installed)) === installed)
              yield* addFile(installed, false);
          }
        }
      }
    }
    // Compose execution and its bind mounts may be configured above an individual PHP area.
    for (let folder = areaRoot; folder !== path.dirname(root); folder = path.dirname(folder)) {
      let hasCompose = false;
      for (const name of [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
      ])
        if (yield* fs.exists(path.join(folder, name))) {
          hasCompose = true;
          if ((yield* fs.realPath(path.join(folder, name))) !== path.join(folder, name))
            return yield* new MonolithIndexError({ operation: "index", reason: "unsafe_path" });
          yield* addFile(path.join(folder, name), false);
        }
      if (hasCompose && (yield* fs.exists(path.join(folder, ".env")))) {
        const environmentFile = path.join(folder, ".env");
        if ((yield* fs.realPath(environmentFile)) !== environmentFile)
          return yield* new MonolithIndexError({ operation: "index", reason: "unsafe_path" });
        yield* addFile(environmentFile, false);
      }
      if (folder === root) break;
    }
    for (const file of area.magoDocker?.composeFiles ?? []) {
      const absolute = path.resolve(root, file);
      if ((yield* fs.realPath(absolute)) !== absolute)
        return yield* new MonolithIndexError({ operation: "index", reason: "unsafe_path" });
      yield* addFile(absolute, false);
    }
    if (area.magoDocker?.composeDirectory) {
      const composeRoot = path.resolve(root, area.magoDocker.composeDirectory);
      yield* safeDirectory(composeRoot);
      const composeFolders = [composeRoot];
      while (composeFolders.length) {
        const folder = composeFolders.pop()!;
        for (const name of yield* fs.readDirectory(folder)) {
          if (++entries > MAX_SCAN_ENTRIES)
            return yield* new MonolithIndexError({
              operation: "index",
              reason: "limit",
              limit: "scan_entries",
            });
          const file = path.join(folder, name);
          if ((yield* fs.realPath(file)) !== file) continue;
          const info = yield* fs.stat(file);
          if (info.type === "Directory" && !skippedDirectories.has(name)) composeFolders.push(file);
          else if (info.type === "File" && (/\.ya?ml$/i.test(name) || name.includes(".env")))
            yield* addFile(file, false);
        }
      }
    }
    records.sort(([left], [right]) => left.localeCompare(right));
    return {
      signature: yield* digest(encodeFingerprint({ area, records })),
      files: files.toSorted(),
      revisions,
      sizes,
    };
  });
  const cachePath = Effect.fnUntraced(function* (root: string, areaId: string) {
    return path.join(root, ".t3/monolith-index", `${yield* digest(areaId)}.json`);
  });
  const loadCache = Effect.fnUntraced(function* (root: string, area: MonolithArea) {
    const key = keyOf(root, area.id);
    const existing = memory.get(key);
    if (existing) return existing;
    const file = yield* cachePath(root, area.id);
    if (!(yield* fs.exists(file))) return null;
    const info = yield* fs.stat(file);
    if ((yield* fs.realPath(file)) !== file || info.type !== "File" || info.size > MAX_CACHE_BYTES)
      return null;
    // Invalid and older cache files are misses, never analyzer results.
    const parsed = yield* fs.readFileString(file).pipe(
      Effect.flatMap((raw) => Effect.try({ try: () => decodeCache(raw), catch: () => null })),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (parsed) memory.set(key, parsed);
    return parsed;
  });
  const publish = Effect.fnUntraced(function* (root: string, area: MonolithArea, cache: Cache) {
    const encoded = encodeCache(cache);
    if (new TextEncoder().encode(encoded).byteLength > MAX_CACHE_BYTES)
      return yield* new MonolithIndexError({
        operation: "index",
        reason: "limit",
        limit: "cache_bytes",
      });
    const parent = path.join(root, ".t3");
    if (yield* fs.exists(parent)) yield* safeDirectory(parent);
    else yield* fs.makeDirectory(parent);
    const directory = path.join(parent, "monolith-index");
    if (yield* fs.exists(directory)) yield* safeDirectory(directory);
    else yield* fs.makeDirectory(directory);
    const file = yield* cachePath(root, area.id);
    if ((yield* fs.exists(file)) && (yield* fs.realPath(file)) !== file)
      return yield* new MonolithIndexError({ operation: "index", reason: "unsafe_path" });
    const temporary = yield* fs.makeTempFileScoped({
      directory,
      prefix: "index-",
      suffix: ".json",
    });
    yield* fs.writeFileString(temporary, encoded);
    yield* fs.rename(temporary, file);
    memory.set(keyOf(root, area.id), cache);
  });
  // Analyzer outcomes are immutable for a source/dependency/configuration snapshot.
  // Retry a failed tool explicitly or after its inputs change, never on a timer.
  const usable = (cache: Cache | null, signature: string) =>
    Effect.succeed(cache !== null && cache.signature === signature);
  const stateChecked = Effect.fnUntraced(function* (root: string, area: MonolithArea) {
    const key = keyOf(root, area.id);
    if (running.has(key)) return statuses.get(key)!;
    const before = yield* fingerprint(root, area);
    const cache = yield* loadCache(root, area);
    const previous = statuses.get(key);
    if (previous?.status === "failed" && failedSignatures.get(key) === before.signature)
      return previous;
    if (yield* usable(cache, before.signature))
      return {
        areaId: area.id,
        status: "ready" as const,
        fileCount: cache!.files.length,
        revision: cache!.signature,
      };
    return {
      areaId: area.id,
      status: cache ? ("stale" as const) : ("idle" as const),
      fileCount: before.files.length,
      revision: before.signature,
    };
  });
  const state = (root: string, area: MonolithArea) =>
    stateChecked(root, area).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          areaId: area.id,
          status: "failed" as const,
          fileCount: 0,
          message: isMonolithIndexError(cause)
            ? cause.message
            : "Monolith indexing could not complete (filesystem).",
        }),
      ),
    );
  const start = Effect.fnUntraced(function* (root: string, area: MonolithArea, force = false) {
    const key = keyOf(root, area.id);
    if (running.has(key)) return;
    const cached = yield* loadCache(root, area);
    const current = statuses.get(key) ?? {
      areaId: area.id,
      status: cached ? ("ready" as const) : ("idle" as const),
      fileCount: cached?.files.length ?? 0,
      ...(cached ? { revision: cached.signature } : {}),
    };
    const completion = yield* Deferred.make<void>();
    // State validation yields for I/O; another requester may have started this area meanwhile.
    if (running.has(key)) return;
    completions.set(key, completion);
    running.add(key);
    // Keep a settled state while validating hashes; only real analysis is indexing.
    statuses.set(
      key,
      current.status === "idle" && !cached
        ? { areaId: area.id, status: "indexing", fileCount: current.fileCount }
        : current,
    );
    let attemptSignature: string | undefined;
    const work = Effect.gen(function* () {
      const before = yield* fingerprint(root, area);
      attemptSignature = before.signature;
      if (!force && failedSignatures.get(key) === before.signature) return;
      if (!force && (yield* usable(cached, before.signature))) {
        statuses.set(key, {
          areaId: area.id,
          status: "ready",
          fileCount: cached!.files.length,
          revision: before.signature,
        });
        return;
      }
      const batches: string[][] = [];
      let batch: string[] = [];
      let bytes = 0;
      for (const file of before.files) {
        const size = before.sizes.get(file)!;
        if (batch.length && (batch.length >= MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES)) {
          batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(file);
        bytes += size;
      }
      if (batch.length) batches.push(batch);
      const files: Cache["files"][number][] = [];
      // Reserve bounded header/timestamp overhead and account each entry before retaining it.
      // Never serialize an unbounded whole-area graph merely to discover it exceeds the limit.
      let cacheBytes = 1024;
      for (const [index, paths] of batches.entries()) {
        statuses.set(key, {
          areaId: area.id,
          status: "indexing",
          fileCount: before.files.length,
          message: `Checking batch ${index + 1} of ${batches.length}.`,
        });
        const results = yield* analyzer
          .indexArea({ cwd: root, areaId: area.id, paths })
          .pipe(
            Effect.mapError(
              (cause) => new MonolithIndexError({ operation: "index", reason: "analysis", cause }),
            ),
          );
        for (const entry of results) {
          cacheBytes += new TextEncoder().encode(encodeCacheEntry(entry)).byteLength + 1;
          if (cacheBytes > MAX_CACHE_BYTES)
            return yield* new MonolithIndexError({
              operation: "index",
              reason: "limit",
              limit: "cache_bytes",
            });
          files.push(entry);
        }
      }
      const after = yield* fingerprint(root, area);
      const currentArea = (yield* config(root)).areas.find((candidate) => candidate.id === area.id);
      if (
        before.signature !== after.signature ||
        !currentArea ||
        encodeFingerprint({ area: currentArea, records: [] }) !==
          encodeFingerprint({ area, records: [] }) ||
        files.length !== before.files.length ||
        new Set(files.map((entry) => entry.path)).size !== files.length ||
        files.some(
          (entry) =>
            entry.result.areaId !== area.id ||
            before.revisions.get(entry.path) !== entry.result.revision,
        )
      ) {
        statuses.set(key, { areaId: area.id, status: "stale", fileCount: after.files.length });
        return;
      }
      yield* publish(root, area, {
        version: 3,
        signature: after.signature,
        createdAt: yield* Clock.currentTimeMillis,
        files,
      });
      failedSignatures.delete(key);
      statuses.set(key, {
        areaId: area.id,
        status: "ready",
        fileCount: files.length,
        revision: after.signature,
      });
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isMonolithIndexError(cause)
          ? cause
          : new MonolithIndexError({ operation: "index", reason: "filesystem", cause }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          if (attemptSignature) failedSignatures.set(key, attemptSignature);
          statuses.set(key, {
            areaId: area.id,
            status: "failed",
            fileCount: current.fileCount,
            message: error.message,
          });
        }),
      ),
      Effect.asVoid,
      Effect.ensuring(
        Effect.gen(function* () {
          running.delete(key);
          yield* Deferred.succeed(completion, undefined);
        }),
      ),
    );
    yield* permits.withPermits(1)(work).pipe(Effect.forkIn(scope));
  });
  const status = Effect.fn("MonolithIndexService.status")(function* ({
    cwd,
  }: MonolithIndexStatusInput) {
    const { root, areas } = yield* config(cwd);
    return { areas: yield* Effect.forEach(areas, (area) => state(root, area)) };
  });
  const index = Effect.fn("MonolithIndexService.index")(function* ({
    cwd,
    areaId,
    force,
  }: MonolithIndexInput) {
    const { root, areas } = yield* config(cwd);
    if (areaId && !areas.some((area) => area.id === areaId))
      return yield* new MonolithIndexError({ operation: "index", reason: "configuration" });
    for (const area of areas) if (!areaId || area.id === areaId) yield* start(root, area, force);
    return {
      areas: areas.map(
        (area) =>
          statuses.get(keyOf(root, area.id)) ?? {
            areaId: area.id,
            status: "idle" as const,
            fileCount: 0,
          },
      ),
    };
  });
  const foreground = (input: MonolithCheckFileInput) =>
    analyzer
      .checkFile(input)
      .pipe(
        Effect.mapError(
          (cause) => new MonolithIndexError({ operation: "check", reason: "analysis", cause }),
        ),
      );
  const checkFileCached = Effect.fn("MonolithIndexService.checkFileCached")(function* (
    input: MonolithCheckFileInput,
  ) {
    const { root, areas, allAreas } = yield* config(input.cwd);
    const boundary = matchMonolithArea({ path: input.path }, allAreas);
    const area = areas.find((candidate) => candidate.id === boundary?.id);
    if (!area) return yield* foreground(input);
    const source = area.kind === "php" ? /\.(?:php|ya?ml)$/i : /\.(?:[cm]?[jt]sx?|jsonc?|css)$/i;
    if (!source.test(input.path)) return yield* foreground(input);
    const cache = yield* loadCache(root, area);
    if (running.has(keyOf(root, area.id)) || !cache) {
      yield* start(root, area);
      return yield* foreground(input);
    }
    const current = yield* fingerprint(root, area).pipe(
      Effect.catchTags({
        MonolithIndexError: (error) =>
          error.reason === "limit" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (!current) return yield* foreground(input);
    if (!current.revisions.has(input.path)) return yield* foreground(input);
    const result = (yield* usable(cache, current.signature))
      ? cache.files.find((entry) => entry.path === input.path)?.result
      : undefined;
    if (result && result.revision === current.revisions.get(input.path)) return result;
    yield* start(root, area);
    return yield* foreground(input);
  });
  const awaitIdle = Effect.fn("MonolithIndexService.awaitIdle")(function* ({
    cwd,
    areaId,
  }: {
    readonly cwd: string;
    readonly areaId?: string;
  }) {
    const { root, areas } = yield* config(cwd);
    const jobs = areas
      .filter((area) => !areaId || area.id === areaId)
      .flatMap((area) => {
        const completion = completions.get(keyOf(root, area.id));
        return completion ? [completion] : [];
      });
    yield* Effect.forEach(jobs, (job) => Deferred.await(job), { discard: true });
  });
  const mapError = <A>(
    operation: "index" | "status" | "check",
    effect: Effect.Effect<A, MonolithIndexError | PlatformError.PlatformError>,
  ) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isMonolithIndexError(cause)
          ? cause
          : new MonolithIndexError({ operation, reason: "filesystem", cause }),
      ),
    );
  return MonolithIndexService.of({
    index: (input) => mapError("index", index(input)),
    awaitIdle: (input) => mapError("status", awaitIdle(input)),
    status: (input) => mapError("status", status(input)),
    checkFileCached: (input) => mapError("check", checkFileCached(input)),
  });
});

export const layer = Layer.effect(MonolithIndexService, make);
