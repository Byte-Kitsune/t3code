import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, MonolithArea, MonolithConfig, ProjectId } from "@t3tools/contracts";
import { FolderIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMonolithAreas } from "../../hooks/useMonolithAreas";
import { randomUUID } from "../../lib/utils";
import { useProjectClone } from "../../state/projectClones";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  monolithAreaSuggestions,
  createMonolithAreaDraft,
  isMonolithAreaDraftDirty,
  reconcileMonolithAreaDraft,
  normalizeMonolithAreaPath,
  validateMonolithAreas,
  editMonolithMagoDocker,
  editMonolithDoctrineThresholdOverride,
  normalizeMonolithMagoDocker,
} from "./MonolithAreasPanel.logic";
import { SettingsSection } from "./settingsLayout";
import { MonolithCommentMarkers } from "./MonolithCommentMarkers";

const AREA_KINDS = [
  { value: "php", label: "PHP" },
  { value: "react", label: "React" },
  { value: "folder", label: "Folder" },
] as const;

export function MonolithAreasPanel({
  environmentId,
  projectId,
  cwd,
  checkoutLabel,
  sectionId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  checkoutLabel?: string;
  sectionId?: string;
}) {
  const clone = useProjectClone(scopeProjectRef(environmentId, projectId));
  const awaitingClone = clone !== null && clone.phase !== "done";
  const state = useMonolithAreas(environmentId, awaitingClone ? null : cwd);
  return (
    <SettingsSection
      id={sectionId}
      title={checkoutLabel ? `Monolith areas · ${checkoutLabel}` : "Monolith areas"}
      icon={<FolderIcon className="size-4" />}
    >
      <div className="space-y-4 px-3 py-3 sm:px-4">
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Group changes by PHP, React, or any folder. Areas are saved in .t3/monolith.json for
            your team to commit.
          </p>
          {checkoutLabel ? <p className="break-all font-mono">{cwd}</p> : null}
          <p>
            Discovery runs once for a new project. Removed areas stay removed; rescanning offers
            additions for you to choose.
          </p>
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {state.config ? (
          <MonolithAreaEditor
            key={`${environmentId}:${cwd}`}
            config={state.config}
            canEdit={state.canEdit}
            persisted={state.persisted}
            saving={state.saving}
            save={state.save}
            discover={state.discover}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {awaitingClone
              ? "Project areas will be discovered when the repository clone finishes."
              : state.loading
                ? "Loading project areas…"
                : "Project areas are unavailable."}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function MonolithAreaEditor({
  config,
  canEdit,
  persisted,
  saving,
  save,
  discover,
}: {
  config: MonolithConfig;
  canEdit: boolean;
  persisted: boolean;
  saving: boolean;
  save: (config: MonolithConfig) => Promise<boolean>;
  discover: () => Promise<readonly MonolithArea[]>;
}) {
  const [draft, setDraft] = useState(() => createMonolithAreaDraft(config));
  const { areas, baseBranch } = draft;
  const configKey = JSON.stringify(config);
  const previousConfigKey = useRef(configKey);
  const [discovered, setDiscovered] = useState<readonly MonolithArea[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = isMonolithAreaDraftDirty(draft);
  const validationError =
    validateMonolithAreas(areas) ??
    (baseBranch.trim().length > 200 ? "Base branch names can contain up to 200 characters." : null);
  const suggestions = monolithAreaSuggestions(areas, discovered ?? []);
  const disabled = !canEdit || saving || scanning;

  useEffect(() => {
    if (previousConfigKey.current === configKey) return;
    previousConfigKey.current = configKey;
    setDraft((current) => reconcileMonolithAreaDraft(current, config));
    setSaved(false);
  }, [config, configKey]);

  function setAreas(transform: (current: readonly MonolithArea[]) => readonly MonolithArea[]) {
    setDraft((current) => ({ ...current, areas: transform(current.areas) }));
  }

  function updateArea(id: string, patch: Partial<MonolithArea>) {
    setSaved(false);
    setAreas((current) => current.map((area) => (area.id === id ? { ...area, ...patch } : area)));
  }

  function addArea(area?: MonolithArea) {
    setSaved(false);
    setAreas((current) => [
      ...current,
      area
        ? {
            ...area,
            id: current.some((existing) => existing.id === area.id) ? randomUUID() : area.id,
          }
        : { id: randomUUID(), name: "", path: "", kind: "folder" },
    ]);
  }

  async function scan() {
    setScanning(true);
    try {
      setDiscovered(await discover());
    } finally {
      setScanning(false);
    }
  }

  async function persist() {
    if (validationError || disabled || draft.conflictingConfig !== null) return;
    const branch = baseBranch.trim();
    const { defaultBaseBranch: _previousBranch, ...rest } = draft.baseline;
    const next = {
      ...rest,
      areas: areas.map((area) => ({
        ...area,
        name: area.name.trim(),
        ...(area.magoDocker ? { magoDocker: normalizeMonolithMagoDocker(area.magoDocker) } : {}),
        ...(area.commentMarkers
          ? {
              commentMarkers: area.commentMarkers.map((rule) => ({
                ...rule,
                marker: rule.marker.trim(),
              })),
            }
          : {}),
        path: normalizeMonolithAreaPath(area.path)!,
        ...(area.entrypointPaths
          ? {
              entrypointPaths: area.entrypointPaths.map((path) => normalizeMonolithAreaPath(path)!),
            }
          : {}),
      })),
      ...(branch ? { defaultBaseBranch: branch } : {}),
    };
    if (await save(next)) {
      setDraft(createMonolithAreaDraft(next));
      setSaved(true);
    }
  }

  return (
    <div className="space-y-4">
      {!canEdit ? (
        <p className="text-xs text-muted-foreground">This connection cannot edit project areas.</p>
      ) : null}
      <div className="space-y-3">
        {areas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No areas configured. Add a folder or rescan for suggestions.
          </p>
        ) : null}
        {areas.map((area, index) => (
          <div key={area.id} className="space-y-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                Area {index + 1}
                {area.enabled === false ? " · Excluded" : ""}
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs">
                  Include
                  <Switch
                    size="sm"
                    checked={area.enabled !== false}
                    disabled={disabled}
                    aria-label={`Include area ${index + 1}`}
                    onCheckedChange={(enabled) => updateArea(area.id, { enabled })}
                  />
                </label>
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  disabled={disabled}
                  aria-label={`Remove area ${index + 1}`}
                  onClick={() => {
                    setSaved(false);
                    setAreas((current) => current.filter((entry) => entry.id !== area.id));
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_7rem]">
              <label className="space-y-1 text-xs">
                <span>Name</span>
                <Input
                  size="sm"
                  value={area.name}
                  disabled={disabled}
                  aria-label={`Area ${index + 1} name`}
                  placeholder="Reports"
                  onChange={(event) => updateArea(area.id, { name: event.currentTarget.value })}
                />
              </label>
              <label className="space-y-1 text-xs">
                <span>Folder</span>
                <Input
                  size="sm"
                  font="mono"
                  value={area.path}
                  disabled={disabled}
                  aria-label={`Area ${index + 1} folder`}
                  placeholder="artifacts/reports"
                  onChange={(event) => updateArea(area.id, { path: event.currentTarget.value })}
                />
              </label>
              <div className="space-y-1 text-xs">
                <span>Kind</span>
                <Select
                  value={area.kind}
                  items={AREA_KINDS}
                  disabled={disabled}
                  onValueChange={(kind) => {
                    if (kind === "php" || kind === "react" || kind === "folder")
                      updateArea(area.id, { kind });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`Area ${index + 1} kind`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {AREA_KINDS.map((kind) => (
                      <SelectItem key={kind.value} value={kind.value}>
                        {kind.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            {area.kind === "php" ? (
              <div className="space-y-2">
                <label className="block space-y-1 text-xs">
                  <span>Mago Compose service</span>
                  <Input
                    size="sm"
                    font="mono"
                    disabled={disabled}
                    aria-label={`Area ${index + 1} Mago Compose service`}
                    value={area.magoDocker?.service ?? ""}
                    placeholder="php"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSaved(false);
                      setAreas((current) =>
                        current.map((entry) =>
                          entry.id === area.id
                            ? editMonolithMagoDocker(entry, "service", value)
                            : entry,
                        ),
                      );
                    }}
                  />
                  <p className="text-muted-foreground">
                    Run Mago in this existing Docker Compose service. Blank uses local execution.
                  </p>
                </label>
                {area.magoDocker ? (
                  <details>
                    <summary className="cursor-pointer text-xs">Docker paths (optional)</summary>
                    <label className="mt-2 block space-y-1 text-xs">
                      <span>Compose files (optional, in merge order)</span>
                      <Input
                        size="sm"
                        font="mono"
                        disabled={disabled}
                        aria-label={`Area ${index + 1} Compose files`}
                        value={area.magoDocker.composeFiles?.join(", ") ?? ""}
                        placeholder="infrastructure/docker/compose.yml, infrastructure/docker/catalog.yml"
                        onChange={(event) => {
                          const files = event.currentTarget.value
                            .split(",")
                            .map((file) => file.trim())
                            .filter(Boolean);
                          setSaved(false);
                          setAreas((current) =>
                            current.map((entry) =>
                              entry.id === area.id && entry.magoDocker
                                ? {
                                    ...entry,
                                    magoDocker: {
                                      ...entry.magoDocker,
                                      composeFiles: files.length ? files : undefined,
                                    },
                                  }
                                : entry,
                            ),
                          );
                        }}
                      />
                      <p className="text-muted-foreground">
                        Repository-relative paths. Blank uses the main Compose file and its
                        includes. Relative Docker paths follow the first file.
                      </p>
                    </label>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {(
                        [
                          {
                            field: "composeDirectory",
                            label: "Compose folder",
                            placeholder: "Auto-detect nearest Compose folder",
                            hint: "Relative to the repository root.",
                          },
                          {
                            field: "containerPath",
                            label: "PHP area in container",
                            placeholder: "Auto-detect bind mount",
                            hint: "Absolute path of this PHP area inside the container.",
                          },
                          {
                            field: "binary",
                            label: "Mago executable",
                            placeholder: "Auto-detect vendor Mago or mago",
                            hint: "One executable path; arguments are not accepted.",
                          },
                        ] as const
                      ).map(({ field, label, placeholder, hint }) => (
                        <label key={field} className="block space-y-1 text-xs">
                          <span>{label}</span>
                          <Input
                            size="sm"
                            font="mono"
                            disabled={disabled}
                            aria-label={`Area ${index + 1} ${label}`}
                            value={area.magoDocker?.[field] ?? ""}
                            placeholder={placeholder}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setSaved(false);
                              setAreas((current) =>
                                current.map((entry) =>
                                  entry.id === area.id
                                    ? editMonolithMagoDocker(entry, field, value)
                                    : entry,
                                ),
                              );
                            }}
                          />
                          <p className="text-muted-foreground">{hint}</p>
                        </label>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}
            {area.kind === "php" ? (
              <MonolithCommentMarkers
                markers={area.commentMarkers}
                disabled={disabled}
                areaLabel={`Area ${index + 1}`}
                onChange={(commentMarkers) => {
                  setSaved(false);
                  setAreas((current) =>
                    current.map((entry) => {
                      if (entry.id !== area.id) return entry;
                      const { commentMarkers: _previous, ...rest } = entry;
                      return commentMarkers === undefined ? rest : { ...rest, commentMarkers };
                    }),
                  );
                }}
              />
            ) : null}
            {area.kind === "php" ? (
              <div className="space-y-2 text-xs">
                <p className="font-medium">Inline Doctrine query thresholds</p>
                <label className="flex items-center justify-between gap-2">
                  <span>Override extension thresholds in T3</span>
                  <Switch
                    size="sm"
                    checked={area.doctrineQueryThresholds !== undefined}
                    disabled={disabled}
                    aria-label={`Area ${index + 1} override extension query thresholds`}
                    onCheckedChange={(enabled) => {
                      setSaved(false);
                      setAreas((current) =>
                        current.map((entry) =>
                          entry.id === area.id
                            ? editMonolithDoctrineThresholdOverride(entry, enabled)
                            : entry,
                        ),
                      );
                    }}
                  />
                </label>
                {!area.doctrineQueryThresholds ? (
                  <p className="text-muted-foreground">
                    Use extension configuration. Thresholds are read from .mago/extension.php when
                    possible; the effective values and their source appear with the inline
                    estimates.
                  </p>
                ) : null}
                {area.doctrineQueryThresholds ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(["warning", "error"] as const).map((level) => (
                      <label key={level} className="block space-y-1">
                        <span>{level === "warning" ? "Warning from" : "Error from"}</span>
                        <Input
                          size="sm"
                          type="number"
                          min={0}
                          step={1}
                          disabled={disabled}
                          aria-label={`Area ${index + 1} query ${level} threshold`}
                          value={
                            area.doctrineQueryThresholds?.[level] ?? (level === "warning" ? 10 : 50)
                          }
                          onChange={(event) =>
                            updateArea(area.id, {
                              doctrineQueryThresholds: {
                                warning: area.doctrineQueryThresholds?.warning ?? 10,
                                error: area.doctrineQueryThresholds?.error ?? 50,
                                [level]:
                                  event.currentTarget.value === ""
                                    ? -1
                                    : Number(event.currentTarget.value),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
                <p className="text-muted-foreground">
                  Query estimates appear above methods. The upper bound determines the color; an
                  unknown upper bound shows an incomplete-analysis warning.
                </p>
                {area.doctrineQueryThresholds ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setSaved(false);
                      setAreas((current) =>
                        current.map((entry) => {
                          if (entry.id !== area.id) return entry;
                          const { doctrineQueryThresholds: _previous, ...rest } = entry;
                          return rest;
                        }),
                      );
                    }}
                  >
                    Use extension configuration
                  </Button>
                ) : null}
              </div>
            ) : null}
            {area.kind === "php" ? (
              <label className="block space-y-1 text-xs">
                <span>Fallback entry folders</span>
                <Input
                  size="sm"
                  font="mono"
                  disabled={disabled}
                  aria-label={`Area ${index + 1} entry folders`}
                  value={area.entrypointPaths?.join(", ") ?? ""}
                  placeholder="src/Controller, src/Command"
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setSaved(false);
                    setAreas((current) =>
                      current.map((entry) => {
                        if (entry.id !== area.id) return entry;
                        const { entrypointPaths: _previous, ...rest } = entry;
                        return text.trim()
                          ? { ...rest, entrypointPaths: text.split(",").map((path) => path.trim()) }
                          : rest;
                      }),
                    );
                  }}
                />
                <p className="text-muted-foreground">
                  Comma-separated folders relative to this area. Blank uses Controller and Command
                  defaults. A graph policy's entry scopes take precedence.
                </p>
              </label>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => addArea()}>
          <PlusIcon />
          Add folder
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => void scan()}>
          <SearchIcon />
          {scanning ? "Scanning…" : "Rescan for suggestions"}
        </Button>
      </div>
      {discovered !== null ? (
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <p role="status" className="text-xs text-muted-foreground">
            {suggestions.length === 0
              ? "No new areas found."
              : "Discovered areas — add the ones you want to include."}
          </p>
          {suggestions.map((area) => (
            <div
              key={`${area.kind}:${area.path}`}
              className="flex items-center justify-between gap-3"
            >
              <div className="min-w-0 text-xs">
                <p>
                  {area.name} · {AREA_KINDS.find((kind) => kind.value === area.kind)?.label}
                </p>
                <p className="break-all font-mono text-muted-foreground">{area.path}</p>
              </div>
              <Button size="xs" variant="outline" disabled={disabled} onClick={() => addArea(area)}>
                Add
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <label className="block space-y-1 text-xs">
        <span>Default base branch (optional)</span>
        <Input
          size="sm"
          font="mono"
          value={baseBranch}
          disabled={disabled}
          placeholder="Automatic"
          aria-label="Monolith default base branch"
          onChange={(event) => {
            setSaved(false);
            const value = event.currentTarget.value;
            setDraft((current) => ({ ...current, baseBranch: value }));
          }}
        />
      </label>
      {dirty && validationError ? (
        <p role="alert" className="text-xs text-destructive">
          {validationError}
        </p>
      ) : null}
      {draft.conflictingConfig !== null ? (
        <p role="alert" className="text-xs text-destructive">
          Project areas changed elsewhere. Your draft is preserved. Discard changes to load the
          latest configuration.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          disabled={
            disabled ||
            (!dirty && persisted) ||
            validationError !== null ||
            draft.conflictingConfig !== null
          }
          onClick={() => void persist()}
        >
          {saving ? "Saving…" : "Save areas"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || (!dirty && draft.conflictingConfig === null)}
          onClick={() => {
            setDraft(createMonolithAreaDraft(config));
            setSaved(false);
          }}
        >
          Discard changes
        </Button>
        {saved ? (
          <p role="status" className="text-xs text-muted-foreground">
            Saved.
          </p>
        ) : dirty ? (
          <p className="text-xs text-muted-foreground">Unsaved changes</p>
        ) : null}
      </div>
    </div>
  );
}
