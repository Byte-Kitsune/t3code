import { useEffect, useSyncExternalStore } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore, selectThreadRightPanelState } from "~/rightPanelStore";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  clearProjectFileQueryData,
  getProjectFileQueryAtom,
  restoreUnsavedProjectFiles,
  snapshotUnsavedProjectFiles,
} from "./projectFilesQueryState";
import { flushProjectFileSaves, resumeProjectFileSaves } from "./useFileSaveCoordinator";
import { isDetachedFileViewerMessage } from "./detachedFileViewerProtocol";
import type {
  DetachedFileSurface,
  DetachedFileViewerContext,
  DetachedFileViewerSnapshot,
} from "./detachedFileViewerProtocol";

interface DetachedSession {
  child: Window;
  context: DetachedFileViewerContext;
  snapshot: DetachedFileViewerSnapshot;
  phase: "opening" | "detached" | "docking";
  closeMonitor: ReturnType<typeof setInterval> | null;
  timer: ReturnType<typeof setTimeout> | null;
  listener: (event: MessageEvent) => void;
}
// The owner survives chat/thread route changes. Only one renderer may edit
// these files at a time; draft handoff happens after its writes have settled.
let session: DetachedSession | null = null;
let pendingFlush: Promise<void> | null = null;
let revision = 0;
const listeners = new Set<() => void>();
function changed() {
  revision += 1;
  for (const listener of listeners) listener();
}
function targetOrigin() {
  return window.location.origin === "null" ? "*" : window.location.origin;
}
function send(current: DetachedSession, message: unknown) {
  current.child.postMessage(message, targetOrigin());
}
function finish(current: DetachedSession) {
  if (session !== current) return;
  if (current.timer !== null) clearTimeout(current.timer);
  if (current.closeMonitor !== null) clearInterval(current.closeMonitor);
  window.removeEventListener("message", current.listener);
  session = null;
  changed();
}
function restore(current: DetachedSession) {
  const { context, snapshot } = current;
  // Read fresh disk data for files saved in the other renderer, retaining only
  // drafts that really remain unsaved at the point of handoff.
  for (const surface of snapshot.surfaces) {
    if (surface.kind !== "file" || surface.attachment) continue;
    clearProjectFileQueryData(context.environmentId, context.cwd, surface.relativePath);
    appAtomRegistry.refresh(
      getProjectFileQueryAtom(context.environmentId, context.cwd, surface.relativePath),
    );
  }
  restoreUnsavedProjectFiles(context.environmentId, context.cwd, snapshot.drafts);
  resumeProjectFileSaves(context.environmentId, context.cwd);
  useRightPanelStore.setState((state) => {
    const key = scopedThreadKey(context.threadRef);
    const panel = selectThreadRightPanelState(state.byThreadKey, context.threadRef);
    return {
      byThreadKey: {
        ...state.byThreadKey,
        [key]: {
          ...panel,
          surfaces: [
            ...panel.surfaces.filter(
              (surface) => surface.kind !== "file" && surface.kind !== "files",
            ),
            ...snapshot.surfaces,
          ],
          activeSurfaceId: snapshot.activeSurfaceId,
          isOpen: true,
        },
      },
    };
  });
}
function fail(current: DetachedSession, description: string) {
  resumeProjectFileSaves(current.context.environmentId, current.context.cwd);
  if (session !== current) return;
  finish(current);
  send(current, { type: "t3-file-viewer:allow-close" });
  toastManager.add({ type: "error", title: "Could not detach File Viewer", description });
}

export function dockDetachedFileViewer() {
  const current = session;
  if (!current || current.phase !== "detached") return;
  current.phase = "docking";
  changed();
  send(current, { type: "t3-file-viewer:snapshot-request" });
  current.timer = setTimeout(() => {
    if (session !== current || current.phase !== "docking") return;
    current.timer = null;
    current.phase = "detached";
    send(current, { type: "t3-file-viewer:resume" });
    changed();
    toastManager.add({
      type: "error",
      title: "Could not dock File Viewer",
      description:
        "The separate window did not finish its pending saves. Your files remain there; try docking again.",
    });
  }, 30_000);
}

export async function detachFileViewer(context: DetachedFileViewerContext) {
  if (session) {
    session.child.focus();
    return;
  }
  if (pendingFlush) {
    toastManager.add({
      type: "warning",
      title: "File Viewer is waiting for a save",
      description:
        "A previous transfer is still finishing its pending writes. Try detaching again when it finishes.",
    });
    return;
  }
  const panel = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    context.threadRef,
  );
  const url = new URL(window.location.href);
  url.hash =
    "/detached-files?" +
    new URLSearchParams({
      environmentId: context.environmentId,
      threadId: context.threadRef.threadId,
    });
  const child = window.open(url.href, "t3-file-viewer", "popup,width=1200,height=850");
  if (!child) {
    toastManager.add({
      type: "error",
      title: "Could not detach File Viewer",
      description: "The separate window could not be opened.",
    });
    return;
  }
  const current: DetachedSession = {
    child,
    context,
    snapshot: {
      surfaces: panel.surfaces.filter(
        (surface): surface is DetachedFileSurface =>
          surface.kind === "files" || (surface.kind === "file" && !surface.attachment),
      ),
      activeSurfaceId: panel.activeSurfaceId,
      drafts: [],
    },
    phase: "opening",
    timer: null,
    closeMonitor: null,
    listener: () => {},
  };
  session = current;
  changed();
  let ready = false;
  let settled = false;
  let initializationSent = false;
  const initialize = () => {
    if (ready && settled && session === current && !initializationSent) {
      initializationSent = true;
      send(current, { type: "t3-file-viewer:initialize", context, snapshot: current.snapshot });
    }
  };
  current.listener = (event) => {
    if (
      session !== current ||
      event.source !== child ||
      event.origin !== window.location.origin ||
      !isDetachedFileViewerMessage(event.data)
    )
      return;
    const message = event.data;
    if (message.type === "t3-file-viewer:ready") {
      ready = true;
      initialize();
    } else if (
      message.type === "t3-file-viewer:initialized" &&
      current.phase === "opening" &&
      initializationSent
    ) {
      if (current.timer !== null) clearTimeout(current.timer);
      current.timer = null;
      for (const draft of current.snapshot.drafts)
        clearProjectFileQueryData(context.environmentId, context.cwd, draft.relativePath);
      current.phase = "detached";
      useRightPanelStore.getState().close(context.threadRef);
      changed();
    } else if (
      message.type === "t3-file-viewer:add-review-comment" &&
      current.phase === "detached"
    ) {
      useComposerDraftStore
        .getState()
        .addReviewComment(context.composerDraftTarget, message.comment, message.options);
    } else if (
      message.type === "t3-file-viewer:remove-review-comment" &&
      current.phase === "detached"
    ) {
      useComposerDraftStore
        .getState()
        .removeReviewComment(context.composerDraftTarget, message.commentId);
    } else if (message.type === "t3-file-viewer:dock-request") {
      dockDetachedFileViewer();
    } else if (
      (message.type === "t3-file-viewer:snapshot" && current.phase === "docking") ||
      message.type === "t3-file-viewer:state"
    ) {
      // Messages originate from our own trusted application renderer. The child
      // validates its project context before accepting initialization.
      const tabsChanged =
        current.snapshot.activeSurfaceId !== message.snapshot.activeSurfaceId ||
        JSON.stringify(current.snapshot.surfaces) !== JSON.stringify(message.snapshot.surfaces);
      current.snapshot = message.snapshot;
      if (message.type === "t3-file-viewer:state" && current.phase !== "opening" && tabsChanged) {
        useRightPanelStore.setState((state) => {
          const key = scopedThreadKey(context.threadRef);
          const panel = selectThreadRightPanelState(state.byThreadKey, context.threadRef);
          const fileActive = panel.surfaces.some(
            (surface) =>
              surface.id === panel.activeSurfaceId &&
              (surface.kind === "file" || surface.kind === "files"),
          );
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: {
                ...panel,
                surfaces: [
                  ...panel.surfaces.filter(
                    (surface) => surface.kind !== "file" && surface.kind !== "files",
                  ),
                  ...message.snapshot.surfaces,
                ],
                activeSurfaceId: fileActive
                  ? message.snapshot.activeSurfaceId
                  : panel.activeSurfaceId,
              },
            },
          };
        });
      }
      if (message.type === "t3-file-viewer:snapshot") {
        restore(current);
        finish(current);
        send(current, { type: "t3-file-viewer:allow-close" });
      }
    }
  };
  window.addEventListener("message", current.listener);
  current.closeMonitor = setInterval(() => {
    if (!child.closed || session !== current) return;
    if (current.phase !== "opening") restore(current);
    else resumeProjectFileSaves(context.environmentId, context.cwd);
    finish(current);
  }, 1_000);
  current.timer = setTimeout(
    () =>
      fail(current, "The separate window did not become ready. Your files remain in this window."),
    30_000,
  );
  const flushing = flushProjectFileSaves(context.environmentId, context.cwd);
  pendingFlush = flushing;
  try {
    await flushing;
    if (session !== current) {
      resumeProjectFileSaves(context.environmentId, context.cwd);
      return;
    }
    current.snapshot.drafts = snapshotUnsavedProjectFiles(context.environmentId, context.cwd);
    settled = true;
    initialize();
  } catch {
    fail(current, "A pending save could not settle. Your files remain in this window.");
  } finally {
    if (pendingFlush === flushing) pendingFlush = null;
  }
}

export function useDetachedFileViewer(
  ref: ScopedThreadRef | null,
  cwd?: string | null,
  workspaceMutationId?: string | null,
) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revision,
    () => 0,
  );
  const current = session;
  const matches =
    current &&
    ref &&
    (cwd
      ? current.context.environmentId === ref.environmentId && current.context.cwd === cwd
      : scopedThreadKey(current.context.threadRef) === scopedThreadKey(ref));
  useEffect(() => {
    if (
      !matches ||
      current.phase === "opening" ||
      workspaceMutationId === undefined ||
      current.context.workspaceMutationId === workspaceMutationId
    )
      return;
    current.context = { ...current.context, workspaceMutationId };
    send(current, { type: "t3-file-viewer:workspace-changed", workspaceMutationId });
  }, [current, matches, workspaceMutationId]);
  return {
    detached: Boolean(matches && current.phase !== "opening"),
    busy: Boolean(matches && current.phase !== "detached"),
    detach: detachFileViewer,
    dock: dockDetachedFileViewer,
    focus: () => session?.child.focus(),
    openFile: (relativePath: string, line?: number) => {
      if (matches)
        send(current, {
          type: "t3-file-viewer:open-file",
          relativePath,
          ...(line !== undefined ? { line } : {}),
        });
    },
  };
}
