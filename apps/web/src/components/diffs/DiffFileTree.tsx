import type { MonolithAreaBoundary } from "@t3tools/shared/monolithAreas";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  groupedDiffFileTreeEntries,
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

const EMPTY_AREAS: ReadonlyArray<MonolithAreaBoundary> = [];

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly areas?: ReadonlyArray<MonolithAreaBoundary>;
  readonly selectedAreaKey?: string | null;
  readonly onSelectedAreaChange?: (key: string | null) => void;
  /** Called with the file's path when the reader picks a file row. */
  readonly onSelectFile: (path: string) => void;
  /**
   * The file the diff is currently showing, kept selected in the tree. Bump `revealRequestId` to
   * scroll the tree to the same path again.
   */
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  /** Right-aligned content in the header row, after the file count. */
  readonly headerAccessory?: ReactNode;
  /** Rendered under the tree, for a host that still has files to fetch. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * A directory tree of the files in a diff. Every directory starts open: a diff is a short list
 * compared to a workspace, and the reader came for the files, not the folders.
 */
export function DiffFileTree(props: DiffFileTreeProps) {
  const grouped = props.areas?.some((area) => area.enabled !== false) ?? false;
  return <DiffFileTreeContent key={grouped ? "areas" : "files"} {...props} />;
}

function DiffFileTreeContent({
  entries,
  areas = EMPTY_AREAS,
  selectedAreaKey = null,
  onSelectedAreaChange,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const { groups, treeEntries } = useMemo(
    () => groupedDiffFileTreeEntries(entries, areas, selectedAreaKey),
    [entries, areas, selectedAreaKey],
  );
  const paths = useMemo(() => treeEntries.map((entry) => entry.treePath), [treeEntries]);
  const physicalPaths = useMemo(
    () => new Map(treeEntries.map((entry) => [entry.treePath, entry.path])),
    [treeEntries],
  );
  const selectedTreePath = useMemo(
    () => treeEntries.find((entry) => entry.path === selectedPath)?.treePath ?? null,
    [selectedPath, treeEntries],
  );
  const directoryPaths = useMemo(() => collectDirectoryPaths(paths), [paths]);
  const positions = useMemo(() => diffFileTreePositions(paths), [paths]);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(
    () => treeEntries.map((entry) => ({ path: entry.treePath, status: entry.status })),
    [treeEntries],
  );
  const filePathsRef = useRef<ReadonlyMap<string, string>>(physicalPaths);
  const onSelectFileRef = useRef(onSelectFile);
  // Selection driven by `selectedPath` below is an echo of a file already on screen, not a
  // request to scroll to it again.
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealRequestId: number } | null>(null);
  const mountedPathsRef = useRef<ReadonlyArray<string> | null>(null);

  useEffect(() => {
    filePathsRef.current = physicalPaths;
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile, physicalPaths]);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: !areas.some((area) => area.enabled !== false),
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const path = selectedPaths.at(-1)?.replace(/\/$/, "");
      const physicalPath = path ? filePathsRef.current.get(path) : undefined;
      if (physicalPath !== undefined) onSelectFileRef.current(physicalPath);
    },
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    ordering.update(positions);
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === paths) return;
    mountedPathsRef.current = paths;
    if (mountedPaths === null) {
      model.resetPaths(paths);
    } else if (mountedPaths.every((path, index) => paths[index] === path)) {
      // PR slices only append files, so keep the existing tree and its open folders.
      const updates = buildDiffFileTreeUpdates(mountedPaths, paths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A refreshed diff can change the rank of existing siblings. Mutations do not reorder
      // those rows, so rebuild while carrying the reader's folder expansion forward.
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      model.resetPaths(paths);
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, ordering, paths, positions]);

  useEffect(() => {
    if (selectedTreePath === null) {
      handledRevealRef.current = null;
      return;
    }
    // A path list that changes under an already-revealed file (a refresh, a later slice) must
    // not pull the tree back to it over whatever the reader has picked since.
    const item = model.getItem(selectedTreePath);
    if (item === null || item.isDirectory()) {
      // A file that left the diff has to be revealed again when it comes back.
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedTreePath && handled.revealRequestId === revealRequestId) return;
    handledRevealRef.current = { path: selectedTreePath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedTreePath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of selectedTreePath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(selectedTreePath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    // `paths` is a dependency so a file that arrives after it was asked for is still revealed.
  }, [model, paths, revealRequestId, selectedTreePath]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{treeEntries.length}</span>
        {groups.length > 0 && onSelectedAreaChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" size="xs" variant="ghost" />}>
              {groups.find((group) => group.key === selectedAreaKey)?.name ??
                areas.find((area) => `area:${area.id}` === selectedAreaKey)?.name ??
                "All areas"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={selectedAreaKey ?? "all"}
                onValueChange={(key) => onSelectedAreaChange(key === "all" ? null : key)}
              >
                <DropdownMenuRadioItem value="all">All areas</DropdownMenuRadioItem>
                {groups.map((group) => (
                  <DropdownMenuRadioItem key={group.key} value={group.key}>
                    {group.name} ({group.files.length})
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {headerAccessory}
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre does not emit a selection change for its sole selected row.
          // Read selection before the row handles the click so new selections reveal only once.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !filePathsRef.current.has(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          const physicalPath = filePathsRef.current.get(path);
          if (clickedSelectedRow && physicalPath !== undefined)
            onSelectFileRef.current(physicalPath);
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      {footer}
    </div>
  );
}
