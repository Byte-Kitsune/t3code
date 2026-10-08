import type { MonolithArea, ProjectEntry } from "@t3tools/contracts";

export interface FileBrowserGroupPreference {
  readonly activeAreaId: string | null;
  readonly recentAreaIds: readonly string[];
}
export const ALL_REPOSITORY_GROUP = "repository";
export const fileBrowserGroupValue = (areaId: string | null) =>
  areaId === null ? ALL_REPOSITORY_GROUP : `area:${areaId}`;
export const fileBrowserGroupStorageKey = (environmentId: string, cwd: string) =>
  `t3:file-browser-groups:${JSON.stringify([environmentId, cwd])}`;
export function readFileBrowserGroupPreference(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
): FileBrowserGroupPreference | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw || raw.length > 16_384) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const preference = value as Record<string, unknown>;
    if (
      preference.activeAreaId !== null &&
      (typeof preference.activeAreaId !== "string" || preference.activeAreaId.length > 512)
    )
      return null;
    if (
      !Array.isArray(preference.recentAreaIds) ||
      preference.recentAreaIds.length > 64 ||
      preference.recentAreaIds.some((id) => typeof id !== "string" || id.length > 512)
    )
      return null;
    return {
      activeAreaId: preference.activeAreaId as string | null,
      recentAreaIds: [...new Set(preference.recentAreaIds as string[])],
    };
  } catch {
    return null;
  }
}
export function writeFileBrowserGroupPreference(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  preference: FileBrowserGroupPreference,
): void {
  try {
    storage?.setItem(key, JSON.stringify(preference));
  } catch {
    /* Browsing remains available when browser storage is disabled. */
  }
}
export function orderFileBrowserGroups(
  areas: readonly MonolithArea[],
  recent: readonly string[],
): readonly MonolithArea[] {
  const enabled = areas.filter((area) => area.enabled !== false);
  const positions = new Map(recent.map((id, index) => [id, index]));
  return enabled.toSorted(
    (a, b) =>
      (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
export function reconcileFileBrowserGroupPreference(
  preference: FileBrowserGroupPreference | null,
  areas: readonly MonolithArea[],
): FileBrowserGroupPreference {
  const enabled = areas.filter((area) => area.enabled !== false);
  const ids = new Set(enabled.map((area) => area.id));
  const recentAreaIds = (preference?.recentAreaIds ?? []).filter((id) => ids.has(id)).slice(0, 64);
  const activeAreaId =
    preference?.activeAreaId === null
      ? null
      : preference && ids.has(preference.activeAreaId)
        ? preference.activeAreaId
        : preference === null
          ? (orderFileBrowserGroups(enabled, recentAreaIds)[0]?.id ?? null)
          : null;
  return { activeAreaId, recentAreaIds };
}
export function visitFileBrowserGroup(
  preference: FileBrowserGroupPreference,
  areaId: string | null,
): FileBrowserGroupPreference {
  return {
    activeAreaId: areaId,
    recentAreaIds:
      areaId === null
        ? preference.recentAreaIds
        : [areaId, ...preference.recentAreaIds.filter((id) => id !== areaId)].slice(0, 64),
  };
}
export function isPathInFileBrowserGroup(path: string, areaPath: string | null): boolean {
  return (
    areaPath === null || areaPath === "." || path === areaPath || path.startsWith(`${areaPath}/`)
  );
}
export function matchFileBrowserGroup(
  path: string,
  areas: readonly MonolithArea[],
): MonolithArea | null {
  return (
    areas
      .filter((area) => area.enabled !== false && isPathInFileBrowserGroup(path, area.path))
      .toSorted(
        (a, b) => (b.path === "." ? 0 : b.path.length) - (a.path === "." ? 0 : a.path.length),
      )[0] ?? null
  );
}
export function fileBrowserGroupDirectories(areaPath: string): readonly string[] {
  if (areaPath === ".") return [""];
  const segments = areaPath.split("/");
  return ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}
export function fileBrowserGroupSearchCwd(cwd: string, areaPath: string | null): string {
  return areaPath === null || areaPath === "." ? cwd : `${cwd.replace(/[\\/]$/u, "")}/${areaPath}`;
}
export function prefixFileBrowserGroupEntries(
  entries: readonly ProjectEntry[],
  areaPath: string | null,
): readonly ProjectEntry[] {
  return areaPath === null || areaPath === "."
    ? entries
    : entries.map((entry) => ({ ...entry, path: `${areaPath}/${entry.path}` }));
}
