import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileTreeBatchOperation, FileTreeSortComparator, GitStatus } from "@pierre/trees";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { groupFilesByMonolithArea, type MonolithAreaBoundary } from "@t3tools/shared/monolithAreas";

/** One changed file as the tree shows it: its current path and how it changed. */
export interface DiffFileTreeEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: GitStatus;
}

/** Virtual group folders are tree ids only; every action still uses the real repository path. */
export function groupedDiffFileTreeEntries(
  entries: ReadonlyArray<DiffFileTreeEntry>,
  areas: ReadonlyArray<MonolithAreaBoundary>,
  selectedAreaKey: string | null,
) {
  const enabledAreas = areas.filter((area) => area.enabled !== false);
  const grouped = enabledAreas.length > 0;
  const groups = grouped ? groupFilesByMonolithArea(entries, areas, (entry) => entry) : [];
  const treeEntries = grouped
    ? groups.flatMap((group) => {
        if (selectedAreaKey !== null && selectedAreaKey !== group.key) return [];
        const index =
          group.area === null
            ? enabledAreas.length
            : enabledAreas.findIndex((area) => area.id === group.area?.id);
        const label = group.name.replace(/[\\/]/g, " · ");
        const kind = group.area?.kind;
        const folder = `${index + 1}. ${label}${kind && kind !== "folder" ? ` · ${kind === "php" ? "PHP" : "React"}` : ""}`;
        return group.files.map((entry) => ({ ...entry, treePath: `${folder}/${entry.path}` }));
      })
    : entries.map((entry) => ({ ...entry, treePath: entry.path }));
  return { groups, treeEntries };
}

function toGitStatus(file: FileDiffMetadata): GitStatus {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

/**
 * Maps parsed diff files to tree entries, keeping the diff's own order. A path
 * appears once: a type change (regular file to symlink) is a deletion plus an
 * addition of the same path, and the tree shows the surviving file as modified.
 */
export function diffFileTreeEntries(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<DiffFileTreeEntry> {
  const statusByPath = new Map<string, GitStatus>();
  for (const file of files) {
    const path = resolveFileDiffPath(file);
    const status = toGitStatus(file);
    const previous = statusByPath.get(path);
    statusByPath.set(path, previous === undefined || previous === status ? status : "modified");
  }
  return [...statusByPath].map(([path, status]) => ({ path, status }));
}

/**
 * Every directory on the way to each file, registered with the trailing slash Pierre uses for
 * directory ids. Parents come before children so the tree can add them in order.
 */
export function collectDirectoryPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    let directory = "";
    for (const segment of segments.slice(0, -1)) {
      directory += `${segment}/`;
      directories.add(directory);
    }
  }
  return [...directories];
}

/** A folder takes the position of its first file in the diff. */
export function diffFileTreePositions(paths: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  paths.forEach((path, index) => {
    positions.set(path, index);
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      if (!positions.has(directory)) positions.set(directory, index);
    }
  });
  return positions;
}

export function compareDiffFileTreeEntries(
  getPositions: () => ReadonlyMap<string, number>,
): FileTreeSortComparator {
  return (left, right) => {
    const positions = getPositions();
    return (
      (positions.get(left.path) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.path) ?? Number.MAX_SAFE_INTEGER) ||
      left.depth - right.depth ||
      left.path.localeCompare(right.path)
    );
  };
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * The adds and removes that turn one set of file paths into another, so a diff that changes
 * under the reader (a new slice, a refresh after an agent edit) keeps the directories they
 * have already opened or closed instead of rebuilding the tree from scratch.
 *
 * Directories are removed only once no file needs them; a directory that gains its first file
 * is added before that file.
 */
export function buildDiffFileTreeUpdates(
  previousPaths: ReadonlyArray<string>,
  nextPaths: ReadonlyArray<string>,
): FileTreeBatchOperation[] {
  const previousDirectories = new Set(collectDirectoryPaths(previousPaths));
  const nextDirectories = new Set(collectDirectoryPaths(nextPaths));
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const updates: FileTreeBatchOperation[] = [];

  for (const path of previousPaths) {
    if (!next.has(path)) updates.push({ type: "remove", path });
  }
  // Deepest first: a directory can only go once everything under it has.
  const removedDirectories = [...previousDirectories]
    .filter((directory) => !nextDirectories.has(directory))
    .toSorted((left, right) => pathDepth(right) - pathDepth(left));
  for (const directory of removedDirectories) {
    updates.push({ type: "remove", path: directory, recursive: true });
  }

  // Shallowest first: a file's directory has to exist before the file does.
  const addedDirectories = [...nextDirectories]
    .filter((directory) => !previousDirectories.has(directory))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const directory of addedDirectories) updates.push({ type: "add", path: directory });
  for (const path of nextPaths) {
    if (!previous.has(path)) updates.push({ type: "add", path });
  }

  return updates;
}
