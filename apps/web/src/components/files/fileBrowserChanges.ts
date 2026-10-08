import type { ProjectEntry } from "@t3tools/contracts";
import type { GitStatusEntry } from "@pierre/trees";

export interface FileBrowserChange {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted" | "renamed";
  readonly uncommitted: boolean;
}

/** Deleted files remain part of Git status, but cannot be opened by the file viewer. */
export function changedFileBrowserEntries(changes: readonly FileBrowserChange[]): ProjectEntry[] {
  const entries = new Map<string, ProjectEntry>();
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    entries.set(change.path, { path: change.path, kind: "file" });
    const segments = change.path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const path = segments.slice(0, index).join("/");
      if (!entries.has(path)) entries.set(path, { path, kind: "directory" });
    }
  }
  return [...entries.values()];
}

export function fileBrowserGitStatuses(
  entries: readonly ProjectEntry[],
  changes: readonly FileBrowserChange[],
): GitStatusEntry[] {
  const statuses = new Map<string, GitStatusEntry>();
  for (const entry of entries) {
    if (entry.ignored) {
      const path = entry.kind === "directory" ? `${entry.path}/` : entry.path;
      statuses.set(path, { path, status: "ignored" });
    }
  }
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    // Pierre has no separate uncommitted state. In this viewer, untracked is
    // the red state, including staged changes and existing modified files.
    statuses.set(change.path, {
      path: change.path,
      status: change.uncommitted ? "untracked" : change.kind === "added" ? "added" : "modified",
    });
  }
  return [...statuses.values()];
}

export const FILE_BROWSER_CHANGE_CSS = `
  :host {
    --trees-git-added-color-override: var(--success-foreground);
    --trees-git-modified-color-override: var(--info-foreground);
    --trees-git-untracked-color-override: var(--error-foreground);
  }
`;
