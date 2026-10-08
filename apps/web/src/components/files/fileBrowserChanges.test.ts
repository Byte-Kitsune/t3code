import { describe, expect, it } from "vite-plus/test";
import { changedFileBrowserEntries, fileBrowserGitStatuses } from "./fileBrowserChanges";

describe("file viewer Git changes", () => {
  it("preserves canonical paths, creates missing parents, and excludes deleted files", () => {
    expect(
      changedFileBrowserEntries([
        { path: "artifact/php/New.php", kind: "added", uncommitted: true },
        { path: "docs/deleted.md", kind: "deleted", uncommitted: false },
        { path: "artifact/php/Existing.php", kind: "modified", uncommitted: false },
      ]),
    ).toEqual([
      { path: "artifact/php/New.php", kind: "file" },
      { path: "artifact", kind: "directory" },
      { path: "artifact/php", kind: "directory" },
      { path: "artifact/php/Existing.php", kind: "file" },
    ]);
  });
  it("marks every uncommitted change red ahead of added green and committed modifications blue, preserving ignored gray", () => {
    expect(
      fileBrowserGitStatuses(
        [
          { path: "vendor", kind: "directory", ignored: true },
          { path: "ignored.txt", kind: "file", ignored: true },
        ],
        [
          { path: "new.txt", kind: "added", uncommitted: true },
          { path: "edit.txt", kind: "modified", uncommitted: true },
          { path: "rename.txt", kind: "renamed", uncommitted: true },
          { path: "added.txt", kind: "added", uncommitted: false },
          { path: "modified.txt", kind: "modified", uncommitted: false },
          { path: "renamed.txt", kind: "renamed", uncommitted: false },
          { path: "deleted.txt", kind: "deleted", uncommitted: true },
        ],
      ),
    ).toEqual([
      { path: "vendor/", status: "ignored" },
      { path: "ignored.txt", status: "ignored" },
      { path: "new.txt", status: "untracked" },
      { path: "edit.txt", status: "untracked" },
      { path: "rename.txt", status: "untracked" },
      { path: "added.txt", status: "added" },
      { path: "modified.txt", status: "modified" },
      { path: "renamed.txt", status: "modified" },
    ]);
  });
});
