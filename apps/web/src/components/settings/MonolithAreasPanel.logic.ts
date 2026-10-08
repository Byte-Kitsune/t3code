import type { MonolithArea, MonolithConfig } from "@t3tools/contracts";

export interface MonolithAreaDraft {
  readonly baseline: MonolithConfig;
  readonly areas: readonly MonolithArea[];
  readonly baseBranch: string;
  readonly conflictingConfig: MonolithConfig | null;
}

export function createMonolithAreaDraft(config: MonolithConfig): MonolithAreaDraft {
  return {
    baseline: config,
    areas: config.areas.map((area) => ({ ...area })),
    baseBranch: config.defaultBaseBranch ?? "",
    conflictingConfig: null,
  };
}

export function isMonolithAreaDraftDirty(draft: MonolithAreaDraft): boolean {
  return (
    JSON.stringify(draft.areas) !== JSON.stringify(draft.baseline.areas) ||
    draft.baseBranch.trim() !== (draft.baseline.defaultBaseBranch ?? "")
  );
}

export function reconcileMonolithAreaDraft(
  draft: MonolithAreaDraft,
  config: MonolithConfig,
): MonolithAreaDraft {
  if (JSON.stringify(draft.baseline) === JSON.stringify(config))
    return draft.conflictingConfig === null ? draft : { ...draft, conflictingConfig: null };
  return isMonolithAreaDraftDirty(draft)
    ? { ...draft, conflictingConfig: config }
    : createMonolithAreaDraft(config);
}

export function normalizeMonolithAreaPath(path: string): string | null {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (
    !trimmed ||
    trimmed.length > 1024 ||
    trimmed.startsWith("/") ||
    trimmed.includes(":") ||
    trimmed.includes("\0")
  )
    return null;
  const parts = trimmed.split("/");
  if (parts.includes("..")) return null;
  return parts.filter((part) => part !== "" && part !== ".").join("/") || ".";
}

export function validateMonolithAreas(areas: readonly MonolithArea[]): string | null {
  const paths = new Set<string>();
  for (const area of areas) {
    if (!area.name.trim()) return "Give every area a name.";
    if (area.name.trim().length > 200) return "Area names can contain up to 200 characters.";
    const path = normalizeMonolithAreaPath(area.path);
    if (path === null)
      return "Use a project-relative folder path, such as apps/web or . for the root.";
    if (paths.has(path)) return "Each folder can have one area.";
    paths.add(path);
  }
  return null;
}

/** Rescanning offers additions; existing custom names and excluded areas stay intact. */
export function monolithAreaSuggestions(
  current: readonly MonolithArea[],
  discovered: readonly MonolithArea[],
): readonly MonolithArea[] {
  const existing = new Set(
    current.map((area) => normalizeMonolithAreaPath(area.path) ?? area.path),
  );
  return discovered.filter((area) => {
    const key = normalizeMonolithAreaPath(area.path) ?? area.path;
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
}
