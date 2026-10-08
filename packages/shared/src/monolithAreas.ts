/** A path boundary used to organize a monolith without changing its physical files. */
export interface MonolithAreaBoundary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: "php" | "react" | "folder";
  readonly enabled?: boolean | undefined;
}

export interface MonolithFilePath {
  readonly path?: string | null;
  readonly previousPath?: string | null;
}

export interface MonolithFileGroup<T> {
  readonly key: string;
  readonly name: string;
  readonly area: MonolithAreaBoundary | null;
  readonly files: ReadonlyArray<T>;
}

function normalizeBoundaryPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "");
}

/** Deepest directory wins; a disabled boundary excludes its subtree. Renames use their destination. */
export function matchMonolithArea(
  file: MonolithFilePath,
  areas: ReadonlyArray<MonolithAreaBoundary>,
): MonolithAreaBoundary | null {
  const path = file.path || file.previousPath;
  if (!path) return null;
  const normalizedPath = normalizeBoundaryPath(path);
  let match: MonolithAreaBoundary | null = null;
  let deepest = -1;
  for (const area of areas) {
    const boundary = normalizeBoundaryPath(area.path);
    if (
      boundary.length > deepest &&
      (boundary === "" || normalizedPath === boundary || normalizedPath.startsWith(`${boundary}/`))
    ) {
      match = area;
      deepest = boundary.length;
    }
  }
  return match?.enabled === false ? null : match;
}

export function monolithAreaGroupKey(area: MonolithAreaBoundary | null): string {
  return area === null ? "other" : `area:${area.id}`;
}

/** Config order outside, incoming file order inside, with unassigned files always last. */
export function groupFilesByMonolithArea<T>(
  files: ReadonlyArray<T>,
  areas: ReadonlyArray<MonolithAreaBoundary>,
  getPath: (file: T) => MonolithFilePath,
): ReadonlyArray<MonolithFileGroup<T>> {
  const groups = areas
    .filter((area) => area.enabled !== false)
    .map((area) => ({ key: monolithAreaGroupKey(area), name: area.name, area, files: [] as T[] }));
  const other = { key: monolithAreaGroupKey(null), name: "Other", area: null, files: [] as T[] };
  const byId = new Map(groups.map((group) => [group.area.id, group]));
  for (const file of files) {
    const area = matchMonolithArea(getPath(file), areas);
    (area ? (byId.get(area.id) ?? other) : other).files.push(file);
  }
  return [...groups, other].filter((group) => group.files.length > 0);
}
