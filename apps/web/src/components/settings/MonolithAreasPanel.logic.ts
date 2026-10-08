import {
  MonolithDoctrineQueryThresholds,
  MonolithCommentMarkers,
  MonolithMagoDocker,
  type MonolithArea,
  type MonolithConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isMagoDocker = Schema.is(MonolithMagoDocker);
const isQueryThresholds = Schema.is(MonolithDoctrineQueryThresholds);
const isCommentMarkers = Schema.is(MonolithCommentMarkers);

export const DEFAULT_COMMENT_MARKERS = [
  { marker: "[DEV COMMENT]", severity: "info" },
  { marker: "@deprecated", severity: "warning" },
  { marker: "@todo", severity: "info" },
  { marker: "@see", severity: "reference" },
] as const;

export function editMonolithDoctrineThresholdOverride(
  area: MonolithArea,
  enabled: boolean,
): MonolithArea {
  const { doctrineQueryThresholds, ...rest } = area;
  return enabled
    ? { ...rest, doctrineQueryThresholds: doctrineQueryThresholds ?? { warning: 10, error: 50 } }
    : rest;
}

export interface MonolithAreaDraft {
  readonly baseline: MonolithConfig;
  readonly areas: readonly MonolithArea[];
  readonly baseBranch: string;
  readonly reviewPrompt: string;
  readonly conflictingConfig: MonolithConfig | null;
}

export function createMonolithAreaDraft(config: MonolithConfig): MonolithAreaDraft {
  return {
    baseline: config,
    areas: config.areas.map((area) => ({ ...area })),
    baseBranch: config.defaultBaseBranch ?? "",
    reviewPrompt: config.reviewPrompt ?? "",
    conflictingConfig: null,
  };
}

export function isMonolithAreaDraftDirty(draft: MonolithAreaDraft): boolean {
  return (
    JSON.stringify(draft.areas) !== JSON.stringify(draft.baseline.areas) ||
    draft.baseBranch.trim() !== (draft.baseline.defaultBaseBranch ?? "") ||
    draft.reviewPrompt !== (draft.baseline.reviewPrompt ?? "")
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

export function editMonolithMagoDocker(
  area: MonolithArea,
  field: keyof MonolithMagoDocker,
  value: string,
): MonolithArea {
  if (field === "service" && !value.trim()) {
    const { magoDocker: _previous, ...rest } = area;
    return rest;
  }
  const previous = area.magoDocker ?? { service: "" };
  if (field !== "service" && !value.trim()) {
    const { [field]: _previous, ...rest } = previous;
    return { ...area, magoDocker: rest };
  }
  return { ...area, magoDocker: { ...previous, [field]: value } };
}

export function normalizeMonolithMagoDocker(docker: MonolithMagoDocker): MonolithMagoDocker {
  const { service, composeDirectory, composeFiles, containerPath, binary } = docker;
  return {
    service: service.trim(),
    ...(composeFiles
      ? { composeFiles: composeFiles.map((file) => normalizeMonolithAreaPath(file) ?? file.trim()) }
      : {}),
    ...(composeDirectory
      ? { composeDirectory: normalizeMonolithAreaPath(composeDirectory) ?? composeDirectory.trim() }
      : {}),
    ...(containerPath ? { containerPath: containerPath.trim().replace(/\/$/, "") || "/" } : {}),
    ...(binary ? { binary: binary.trim().replace(/^(\.\/)+/, "") } : {}),
  };
}

export function validateMonolithAreas(areas: readonly MonolithArea[]): string | null {
  const paths = new Set<string>();
  for (const area of areas) {
    if ((area.reviewPrompt?.length ?? 0) > 16_384)
      return "Review prompts can contain up to 16,384 characters.";
    if (!area.name.trim()) return "Give every area a name.";
    if (area.name.trim().length > 200) return "Area names can contain up to 200 characters.";
    const path = normalizeMonolithAreaPath(area.path);
    if (path === null)
      return "Use a project-relative folder path, such as apps/web or . for the root.";
    if (paths.has(path)) return "Each folder can have one area.";
    if (area.entrypointPaths?.some((entry) => normalizeMonolithAreaPath(entry) === null))
      return "Entry folders must be relative to the PHP area, such as src/Controller.";
    if ((area.entrypointPaths?.length ?? 0) > 100)
      return "An area can contain up to 100 entry folders.";
    if (area.magoDocker && !isMagoDocker(normalizeMonolithMagoDocker(area.magoDocker)))
      return "Docker Mago needs a valid Compose service name, a project-relative Compose folder and an absolute container folder. The binary must be a single POSIX executable path.";
    if (area.doctrineQueryThresholds && !isQueryThresholds(area.doctrineQueryThresholds))
      return "Query thresholds must be non-negative whole numbers, with warning below error.";
    if (
      area.commentMarkers &&
      (!isCommentMarkers(area.commentMarkers) ||
        new Set(area.commentMarkers.map((rule) => rule.marker.trim().toLowerCase())).size !==
          area.commentMarkers.length)
    )
      return "Use up to 32 unique single-line comment markers (1–128 characters) and a valid level.";
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
