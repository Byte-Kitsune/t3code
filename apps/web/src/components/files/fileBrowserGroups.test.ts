import { describe, expect, it } from "vite-plus/test";
import type { MonolithArea } from "@t3tools/contracts";
import {
  fileBrowserGroupStorageKey,
  readFileBrowserGroupPreference,
  writeFileBrowserGroupPreference,
  orderFileBrowserGroups,
  reconcileFileBrowserGroupPreference,
  visitFileBrowserGroup,
  isPathInFileBrowserGroup,
  matchFileBrowserGroup,
  fileBrowserGroupDirectories,
  fileBrowserGroupSearchCwd,
  prefixFileBrowserGroupEntries,
  fileBrowserGroupValue,
  ALL_REPOSITORY_GROUP,
  CHANGED_FILES_GROUP,
  visitChangedFilesGroup,
} from "./fileBrowserGroups";
const areas: readonly MonolithArea[] = [
  { id: "php", name: "Catalog", path: "artifact/catalog", kind: "php" },
  { id: "react", name: "Portal", path: "artifact/portal", kind: "react" },
  { id: "docs", name: "Docs", path: "docs", kind: "folder" },
  { id: "disabled", name: "Disabled", path: "old", kind: "php", enabled: false },
];
describe("file browser project groups", () => {
  it("orders recent groups first while keeping untouched config order and excluding disabled areas", () => {
    const first = reconcileFileBrowserGroupPreference(null, areas);
    expect(first.activeAreaId).toBe("php");
    const visited = visitFileBrowserGroup(visitFileBrowserGroup(first, "docs"), "react");
    expect(orderFileBrowserGroups(areas, visited.recentAreaIds).map((area) => area.id)).toEqual([
      "react",
      "docs",
      "php",
    ]);
    expect(visitFileBrowserGroup(visited, null).recentAreaIds).toEqual(["react", "docs"]);
    expect(visitFileBrowserGroup(visited, "docs").recentAreaIds).toEqual(["docs", "react"]);
  });
  it("preserves All repository and clears disabled/removed selections and recency", () => {
    expect(
      reconcileFileBrowserGroupPreference(
        { activeAreaId: null, recentAreaIds: ["docs", "disabled", "removed"] },
        areas,
      ),
    ).toEqual({ activeAreaId: null, recentAreaIds: ["docs"] });
    for (const activeAreaId of ["disabled", "removed"])
      expect(
        reconcileFileBrowserGroupPreference({ activeAreaId, recentAreaIds: [] }, areas)
          .activeAreaId,
      ).toBeNull();
    expect(fileBrowserGroupValue(null)).toBe(ALL_REPOSITORY_GROUP);
    expect(fileBrowserGroupValue("repository")).not.toBe(ALL_REPOSITORY_GROUP);
  });
  it("matches nested folders by complete path segment and prefers nested groups over root", () => {
    const nested = [
      { id: "root", name: "Root", kind: "folder" as const, path: "." },
      ...areas,
      { id: "nested", name: "Nested", kind: "folder" as const, path: "artifact/catalog/docs" },
    ];
    expect(matchFileBrowserGroup("artifact/catalog/docs/readme.md", nested)?.id).toBe("nested");
    expect(matchFileBrowserGroup("artifact/catalog/src/Demo.php", nested)?.id).toBe("php");
    expect(matchFileBrowserGroup("old/Demo.php", nested)?.id).toBe("root");
    expect(isPathInFileBrowserGroup("artifact/catalog-other/Demo.php", "artifact/catalog")).toBe(
      false,
    );
    expect(isPathInFileBrowserGroup("mago.toml", ".")).toBe(true);
    expect(isPathInFileBrowserGroup("mago.toml", null)).toBe(true);
  });
  it("loads only group ancestors and roots, preserving full repo paths for scoped search", () => {
    expect(fileBrowserGroupDirectories("artifact/catalog")).toEqual([
      "",
      "artifact",
      "artifact/catalog",
    ]);
    expect(fileBrowserGroupDirectories(".")).toEqual([""]);
    expect(fileBrowserGroupSearchCwd("/repo/", "artifact/catalog")).toBe("/repo/artifact/catalog");
    expect(fileBrowserGroupSearchCwd("/repo", ".")).toBe("/repo");
    expect(
      prefixFileBrowserGroupEntries([{ path: "src/Demo.php", kind: "file" }], "artifact/catalog"),
    ).toEqual([{ path: "artifact/catalog/src/Demo.php", kind: "file" }]);
  });
  it("persists isolated project/environment preferences with safe storage fallback", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const key = fileBrowserGroupStorageKey("local", "/repo");
    writeFileBrowserGroupPreference(storage, key, {
      activeAreaId: "php",
      recentAreaIds: ["php", "docs"],
    });
    expect(readFileBrowserGroupPreference(storage, key)).toEqual({
      activeAreaId: "php",
      recentAreaIds: ["php", "docs"],
    });
    expect(
      readFileBrowserGroupPreference(storage, fileBrowserGroupStorageKey("remote", "/repo")),
    ).toBeNull();
    expect(
      readFileBrowserGroupPreference(storage, fileBrowserGroupStorageKey("local", "/other")),
    ).toBeNull();
    expect(
      readFileBrowserGroupPreference(
        {
          getItem: () => {
            throw new Error("Denied");
          },
        },
        key,
      ),
    ).toBeNull();
    expect(() =>
      writeFileBrowserGroupPreference(
        {
          setItem: () => {
            throw new Error("Denied");
          },
        },
        key,
        { activeAreaId: null, recentAreaIds: [] },
      ),
    ).not.toThrow();
  });
  it("rejects malformed or oversized persisted preferences and deduplicates recent ids", () => {
    for (const raw of [
      "{",
      JSON.stringify({ activeAreaId: 1, recentAreaIds: [] }),
      JSON.stringify({ activeAreaId: null, recentAreaIds: Array(65).fill("php") }),
    ])
      expect(readFileBrowserGroupPreference({ getItem: () => raw }, "k")).toBeNull();
    expect(
      readFileBrowserGroupPreference(
        { getItem: () => JSON.stringify({ activeAreaId: "php", recentAreaIds: ["php", "php"] }) },
        "k",
      )?.recentAreaIds,
    ).toEqual(["php"]);
  });
  it("persists Changed Files independently of area IDs and preserves recent groups when returning", () => {
    const preference = visitChangedFilesGroup({
      activeAreaId: "docs",
      recentAreaIds: ["docs", "php"],
    });
    expect(reconcileFileBrowserGroupPreference(preference, areas)).toEqual({
      activeAreaId: "docs",
      recentAreaIds: ["docs", "php"],
      changedFiles: true,
    });
    expect(reconcileFileBrowserGroupPreference(preference, [])).toEqual({
      activeAreaId: null,
      recentAreaIds: [],
      changedFiles: true,
    });
    expect(visitFileBrowserGroup(preference, "php")).toEqual({
      activeAreaId: "php",
      recentAreaIds: ["php", "docs"],
    });
    expect(fileBrowserGroupValue(CHANGED_FILES_GROUP)).not.toBe(CHANGED_FILES_GROUP);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeFileBrowserGroupPreference(storage, "key", preference);
    expect(readFileBrowserGroupPreference(storage, "key")).toEqual(preference);
  });
});
