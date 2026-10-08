import { describe, expect, it } from "vite-plus/test";
import type { MonolithArea, MonolithConfig } from "@t3tools/contracts";

import {
  monolithAreaSuggestions,
  createMonolithAreaDraft,
  isMonolithAreaDraftDirty,
  reconcileMonolithAreaDraft,
  normalizeMonolithAreaPath,
  validateMonolithAreas,
  editMonolithMagoDocker,
  normalizeMonolithMagoDocker,
  editMonolithDoctrineThresholdOverride,
} from "./MonolithAreasPanel.logic";

const phpRoot: MonolithArea = { id: "php-root", name: "PHP", path: ".", kind: "php" };
const config: MonolithConfig = { version: 1, initialized: true, areas: [phpRoot] };

describe("Monolith area editing", () => {
  it("inherits extension configuration unless a T3 threshold override is explicitly enabled", () => {
    expect(createMonolithAreaDraft(config).areas[0]?.doctrineQueryThresholds).toBeUndefined();
    const custom = {
      ...phpRoot,
      commentMarkers: [],
      doctrineQueryThresholds: { warning: 2, error: 8 },
    };
    expect(editMonolithDoctrineThresholdOverride(custom, true).doctrineQueryThresholds).toEqual({
      warning: 2,
      error: 8,
    });
    expect(editMonolithDoctrineThresholdOverride(custom, false)).toEqual({
      ...phpRoot,
      commentMarkers: [],
    });
    expect(editMonolithDoctrineThresholdOverride(phpRoot, true).doctrineQueryThresholds).toEqual({
      warning: 10,
      error: 50,
    });
  });
  it("permits disabling comment hints while rejecting ambiguous or invalid custom markers", () => {
    expect(validateMonolithAreas([{ ...phpRoot, commentMarkers: [] }])).toBeNull();
    expect(
      validateMonolithAreas([
        { ...phpRoot, commentMarkers: [{ marker: "@todo", severity: "warning" }] },
      ]),
    ).toBeNull();
    for (const commentMarkers of [
      [{ marker: "", severity: "info" as const }],
      [{ marker: "line\nbreak", severity: "info" as const }],
      [
        { marker: "@todo", severity: "info" as const },
        { marker: "@TODO", severity: "warning" as const },
      ],
    ])
      expect(validateMonolithAreas([{ ...phpRoot, commentMarkers }])).not.toBeNull();
  });
  it("keeps query thresholds through draft reconciliation and prevents invalid threshold saves", () => {
    const configured = { ...phpRoot, doctrineQueryThresholds: { warning: 5, error: 20 } };
    const draft = createMonolithAreaDraft({ ...config, areas: [configured] });
    expect(
      reconcileMonolithAreaDraft(draft, { ...config, areas: [configured] }).areas[0]
        ?.doctrineQueryThresholds,
    ).toEqual({ warning: 5, error: 20 });
    expect(validateMonolithAreas([configured])).toBeNull();
    expect(
      validateMonolithAreas([
        { ...configured, doctrineQueryThresholds: { warning: 20, error: 5 } },
      ]),
    ).toContain("warning below error");
  });
  it("enables Docker per PHP area, preserves overrides while renaming service and fully disables it when cleared", () => {
    const enabled = editMonolithMagoDocker(phpRoot, "service", "php");
    const custom = editMonolithMagoDocker(enabled, "containerPath", "/app");
    const renamed = editMonolithMagoDocker(custom, "service", "php-dev");
    expect(renamed.magoDocker).toEqual({ service: "php-dev", containerPath: "/app" });
    expect(editMonolithMagoDocker(renamed, "containerPath", "").magoDocker).toEqual({
      service: "php-dev",
    });
    expect(editMonolithMagoDocker(renamed, "service", " ")).toEqual(phpRoot);
  });
  it("normalizes Docker paths before validating and saving shared configuration", () => {
    const magoDocker = {
      service: " php ",
      composeDirectory: " ./artifact//api/ ",
      containerPath: " /app/api/ ",
      binary: " ./tools/vendor/bin/mago ",
    };
    expect(normalizeMonolithMagoDocker(magoDocker)).toEqual({
      service: "php",
      composeDirectory: "artifact/api",
      containerPath: "/app/api",
      binary: "tools/vendor/bin/mago",
    });
    expect(validateMonolithAreas([{ ...phpRoot, magoDocker }])).toBeNull();
    expect(
      validateMonolithAreas([{ ...phpRoot, magoDocker: { service: "php;whoami" } }]),
    ).not.toBeNull();
    expect(
      validateMonolithAreas([
        { ...phpRoot, magoDocker: { service: "php", containerPath: "../app" } },
      ]),
    ).not.toBeNull();
  });
  it("keeps Docker overrides in dirty drafts and after external config refresh", () => {
    const saved = {
      ...config,
      areas: [{ ...phpRoot, magoDocker: { service: "php", binary: "mago" } }],
    };
    const draft = createMonolithAreaDraft(saved);
    const edited = {
      ...draft,
      areas: draft.areas.map((area) => editMonolithMagoDocker(area, "service", "php-dev")),
    };
    const conflicting = reconcileMonolithAreaDraft(edited, { ...saved, defaultBaseBranch: "main" });
    expect(conflicting.areas[0]?.magoDocker?.service).toBe("php-dev");
    expect(conflicting.conflictingConfig).not.toBeNull();
  });
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
