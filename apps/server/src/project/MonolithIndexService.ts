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

export class MonolithIndexError extends Schema.TaggedError<MonolithIndexError>()(
  "MonolithIndexError",
  {
    operation: Schema.Literals(["index", "status", "check"]),
    reason: Schema.Literals(["configuration", "filesystem", "unsafe_path", "limit", "analysis"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
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

const Cache = Schema.Struct({
  version: Schema.Literal(2),
  signature: Schema.String,
  createdAt: Schema.Number,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, result: MonolithCheckFileResult }),
  ).check(Schema.isMaxLength(2000)),
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
  const failedAt = new Map<string, number>();
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
    const folders = [areaRoot];
    let entries = 0;
    let sourceBytes = 0;
    const addFile = Effect.fnUntraced(function* (absolute: string, source: boolean) {
      const info = yield* fs.stat(absolute);
      if (info.type !== "File") return;
      if (info.size > (source ? 2 : 4) * 1024 * 1024)
        return yield* new MonolithIndexError({ operation: "index", reason: "limit" });
      if (source && (sourceBytes += Number(info.size)) > 32 * 1024 * 1024)
        return yield* new MonolithIndexError({ operation: "index", reason: "limit" });
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const hash = yield* digest(yield* fs.readFileString(absolute));
      records.push([relative, hash]);
      if (source) {
        files.push(relative);
        revisions.set(relative, hash);
      }
    });
    while (folders.length) {
      const folder = folders.pop()!;
      for (const name of (yield* fs.readDirectory(folder)).toSorted()) {
        if (++entries > 20000)
          return yield* new MonolithIndexError({ operation: "index", reason: "limit" });
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
              ? /\.php$/i.test(name)
              : /\.(?:[cm]?[jt]sx?|jsonc?|css)$/i.test(name);
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          const source =
            candidateSource && matchMonolithArea({ path: relative }, groups)?.id === area.id;
          yield* addFile(absolute, source);
          if (files.length > 2000)
            return yield* new MonolithIndexError({ operation: "index", reason: "limit" });
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
          if (++entries > 20000)
            return yield* new MonolithIndexError({ operation: "index", reason: "limit" });
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
    if ((yield* fs.realPath(file)) !== file || info.type !== "File" || info.size > 16 * 1024 * 1024)
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
    if (new TextEncoder().encode(encoded).byteLength > 16 * 1024 * 1024)
      return yield* new MonolithIndexError({ operation: "index", reason: "limit" });
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
  const usable = Effect.fnUntraced(function* (cache: Cache | null, signature: string) {
    if (!cache || cache.signature !== signature) return false;
    const degraded = cache.files.some(
      ({ result }) =>
        result.runs.some((run) => run.status === "failed" || run.status === "unavailable") ||
        [result.queryBudget, result.entryChains].some(
          (insight) =>
            insight?.status === "failed" ||
            (insight?.status === "unavailable" &&
              insight.message !==
                "The opened file has no uniquely modeled method in the source graph.") ||
            (insight?.status === "unsupported" &&
              insight.message !== "The file is absent from the configured Mago source snapshot."),
        ),
    );
    const age = (yield* Clock.currentTimeMillis) - cache.createdAt;
    return !degraded || (age >= 0 && age < 30000);
  });
  const stateChecked = Effect.fnUntraced(function* (root: string, area: MonolithArea) {
    const key = keyOf(root, area.id);
    if (running.has(key)) return statuses.get(key)!;
    const before = yield* fingerprint(root, area);
    const cache = yield* loadCache(root, area);
    if (yield* usable(cache, before.signature))
      return {
        areaId: area.id,
        status: "ready" as const,
        fileCount: cache!.files.length,
        revision: cache!.signature,
      };
    const previous = statuses.get(key);
    return previous?.status === "failed" &&
      (yield* Clock.currentTimeMillis) - (failedAt.get(key) ?? 0) < 30000
      ? previous
      : {
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
    const current = yield* state(root, area);
    if (!force && current.status === "ready") return;
    const completion = yield* Deferred.make<void>();
    // State validation yields for I/O; another requester may have started this area meanwhile.
    if (running.has(key)) return;
    completions.set(key, completion);
    running.add(key);
    statuses.set(key, { areaId: area.id, status: "indexing", fileCount: current.fileCount });
    const work = Effect.gen(function* () {
      const before = yield* fingerprint(root, area);
      const files = yield* analyzer
        .indexArea({ cwd: root, areaId: area.id, paths: before.files })
        .pipe(
          Effect.mapError(
            (cause) => new MonolithIndexError({ operation: "index", reason: "analysis", cause }),
          ),
        );
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
        version: 2,
        signature: after.signature,
        createdAt: yield* Clock.currentTimeMillis,
        files,
      });
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
        Effect.gen(function* () {
          failedAt.set(key, yield* Clock.currentTimeMillis);
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
    return { areas: yield* Effect.forEach(areas, (area) => state(root, area)) };
  });
  const checkFileCached = Effect.fn("MonolithIndexService.checkFileCached")(function* (
    input: MonolithCheckFileInput,
  ) {
    const { root, areas, allAreas } = yield* config(input.cwd);
    const boundary = matchMonolithArea({ path: input.path }, allAreas);
    const area = areas.find((candidate) => candidate.id === boundary?.id);
    if (area) {
      const cache = yield* loadCache(root, area);
      const current = yield* fingerprint(root, area);
      if (!current.revisions.has(input.path))
        return yield* analyzer
          .checkFile(input)
          .pipe(
            Effect.mapError(
              (cause) => new MonolithIndexError({ operation: "check", reason: "analysis", cause }),
            ),
          );
      const result = (yield* usable(cache, current.signature))
        ? cache!.files.find((entry) => entry.path === input.path)?.result
        : undefined;
      if (result && result.revision === current.revisions.get(input.path)) return result;
      yield* start(root, area);
      const completion = completions.get(keyOf(root, area.id));
      if (completion) yield* Deferred.await(completion);
      const latestArea = (yield* config(root)).areas.find((candidate) => candidate.id === area.id);
      if (latestArea) {
        const latest = yield* fingerprint(root, latestArea);
        const updated = yield* loadCache(root, latestArea);
        const cached = (yield* usable(updated, latest.signature))
          ? updated!.files.find((entry) => entry.path === input.path)?.result
          : undefined;
        if (cached && cached.revision === latest.revisions.get(input.path)) return cached;
      }
      return yield* new MonolithIndexError({ operation: "check", reason: "analysis" });
    }
    return yield* analyzer
      .checkFile(input)
      .pipe(
        Effect.mapError(
          (cause) => new MonolithIndexError({ operation: "check", reason: "analysis", cause }),
        ),
      );
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
    status: (input) => mapError("status", status(input)),
    checkFileCached: (input) => mapError("check", checkFileCached(input)),
  });
});

export const layer = Layer.effect(MonolithIndexService, make);
