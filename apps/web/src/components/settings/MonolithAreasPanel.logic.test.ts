import { describe, expect, it } from "vite-plus/test";
import type { MonolithArea, MonolithConfig } from "@t3tools/contracts";

import {
  monolithAreaSuggestions,
  createMonolithAreaDraft,
  isMonolithAreaDraftDirty,
  reconcileMonolithAreaDraft,
  normalizeMonolithAreaPath,
  validateMonolithAreas,
} from "./MonolithAreasPanel.logic";

const phpRoot: MonolithArea = { id: "php-root", name: "PHP", path: ".", kind: "php" };
const config: MonolithConfig = { version: 1, initialized: true, areas: [phpRoot] };

describe("Monolith area editing", () => {
  it("validates PHP entry folders relative to the area and preserves them through draft refresh", () => {
    const area = { ...phpRoot, entrypointPaths: ["src/Controller", "src/Jobs"] };
    expect(validateMonolithAreas([area])).toBeNull();
    expect(validateMonolithAreas([{ ...area, entrypointPaths: ["../other"] }])).not.toBeNull();
    expect(validateMonolithAreas([{ ...area, entrypointPaths: [""] }])).not.toBeNull();
    const draft = createMonolithAreaDraft({ ...config, areas: [area] });
    expect(draft.areas[0]?.entrypointPaths).toEqual(area.entrypointPaths);
    expect(
      reconcileMonolithAreaDraft(draft, { ...config, areas: [{ ...area, name: "Updated" }] })
        .areas[0]?.entrypointPaths,
    ).toEqual(area.entrypointPaths);
  });
  it("normalizes nested relative folders and rejects paths outside the project", () => {
    expect(normalizeMonolithAreaPath(" ./apps//web/ ")).toBe("apps/web");
    expect(normalizeMonolithAreaPath(".\\artifacts\\reports")).toBe("artifacts/reports");
    expect(normalizeMonolithAreaPath("./")).toBe(".");
    for (const path of [
      "",
      "../other",
      "apps/../other",
      "/tmp/project",
      "C:\\project",
      "\\\\host\\share",
      "reports:archived",
      "reports\0",
    ]) {
      expect(normalizeMonolithAreaPath(path)).toBeNull();
    }
  });

  it("permits nested folders but catches equivalent duplicate groups across kinds", () => {
    expect(
      validateMonolithAreas([
        phpRoot,
        { ...phpRoot, id: "react", path: "apps/web", kind: "react" },
      ]),
    ).toBeNull();
    expect(
      validateMonolithAreas([phpRoot, { ...phpRoot, id: "react-root", kind: "react" }]),
    ).not.toBeNull();
    expect(
      validateMonolithAreas([phpRoot, { ...phpRoot, id: "second", path: "./" }]),
    ).not.toBeNull();
    expect(validateMonolithAreas([{ ...phpRoot, name: " " }])).not.toBeNull();
  });

  it("offers only new suggestions while preserving custom and excluded entries", () => {
    const current = [
      { ...phpRoot, name: "Backend", enabled: false },
      { id: "custom", name: "Deliverables", path: "artifacts", kind: "folder" as const },
    ];
    const nested: MonolithArea = {
      id: "nested",
      name: "Reports",
      path: "artifacts/reports",
      kind: "folder",
    };
    expect(
      monolithAreaSuggestions(current, [
        phpRoot,
        { ...current[1]!, name: "Artifacts" },
        nested,
        nested,
      ]),
    ).toEqual([nested]);
    expect(current[0]).toEqual({ ...phpRoot, name: "Backend", enabled: false });
    expect(monolithAreaSuggestions([], [phpRoot])).toEqual([phpRoot]);
  });

  it("loads external changes when clean and preserves unsaved exclusions when dirty", () => {
    const initial = createMonolithAreaDraft(config);
    const incoming = { ...config, areas: [{ ...phpRoot, name: "Server changed name" }] };
    expect(reconcileMonolithAreaDraft(initial, incoming).areas).toEqual(incoming.areas);
    const excludedDraft = { ...initial, areas: [{ ...phpRoot, enabled: false }] };
    const conflicted = reconcileMonolithAreaDraft(excludedDraft, incoming);
    expect(conflicted.areas).toEqual(excludedDraft.areas);
    expect(conflicted.conflictingConfig).toEqual(incoming);
    expect(isMonolithAreaDraftDirty(conflicted)).toBe(true);
    const reverted = reconcileMonolithAreaDraft(conflicted, config);
    expect(reverted.areas).toEqual(excludedDraft.areas);
    expect(reverted.conflictingConfig).toBeNull();
    expect(createMonolithAreaDraft(incoming).conflictingConfig).toBeNull();
  });

  it("accepts its saved snapshot without creating a conflict on refresh", () => {
    const savedConfig = {
      ...config,
      areas: [{ ...phpRoot, enabled: false }],
      defaultBaseBranch: "main",
    };
    const savedDraft = createMonolithAreaDraft(savedConfig);
    expect(isMonolithAreaDraftDirty(savedDraft)).toBe(false);
    expect(reconcileMonolithAreaDraft(savedDraft, savedConfig)).toBe(savedDraft);
  });
});
