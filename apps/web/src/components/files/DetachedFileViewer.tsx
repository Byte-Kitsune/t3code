import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { PanelLeftCloseIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import FilePreviewPanel, { type FileReviewCommentActions } from "./FilePreviewPanel";
import {
  detachedFileViewerTargetOrigin,
  isDetachedFileViewerMessage,
  type DetachedFileSurface,
  type DetachedFileViewerContext,
  type DetachedFileViewerMessage,
  type DetachedFileViewerSnapshot,
} from "./detachedFileViewerProtocol";
import { restoreUnsavedProjectFiles, snapshotUnsavedProjectFiles } from "./projectFilesQueryState";
import { flushProjectFileSaves, resumeProjectFileSaves } from "./useFileSaveCoordinator";

interface Session {
  context: DetachedFileViewerContext;
  surfaces: DetachedFileSurface[];
  activeSurfaceId: string | null;
}

export function DetachedFileViewer({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const allowClose = useRef(false);
  const snapshotInFlight = useRef(false);
  const handoffGeneration = useRef(0);
  const dockWatchdog = useRef<number | null>(null);
  const clearDockWatchdog = useCallback(() => {
    if (dockWatchdog.current !== null) window.clearTimeout(dockWatchdog.current);
    dockWatchdog.current = null;
  }, []);

  const post = useCallback((message: DetachedFileViewerMessage) => {
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) return false;
    opener.postMessage(message, detachedFileViewerTargetOrigin(window.location.origin));
    return true;
  }, []);

  const reviewCommentActions = useMemo<FileReviewCommentActions>(
    () => ({
      add: (_target, comment, options) => {
        post({
          type: "t3-file-viewer:add-review-comment",
          comment,
          ...(options ? { options } : {}),
        });
      },
      remove: (_target, commentId) => {
        post({ type: "t3-file-viewer:remove-review-comment", commentId });
      },
    }),
    [post],
  );

  const snapshot = useCallback((): DetachedFileViewerSnapshot | null => {
    const current = sessionRef.current;
    return current
      ? {
          surfaces: current.surfaces,
          activeSurfaceId: current.activeSurfaceId,
          drafts: snapshotUnsavedProjectFiles(current.context.environmentId, current.context.cwd),
        }
      : null;
  }, []);

  const updateSession = useCallback((next: Session) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const publishState = useCallback(() => {
    const current = snapshot();
    if (current) post({ type: "t3-file-viewer:state", snapshot: current });
  }, [post, snapshot]);

  const requestDock = useCallback(() => {
    if (dockWatchdog.current !== null) return;
    if (!post({ type: "t3-file-viewer:dock-request" })) {
      setError(
        "The chat window is no longer available. Save your changes before closing this window.",
      );
      return;
    }
    setHandoff(true);
    dockWatchdog.current = window.setTimeout(() => {
      dockWatchdog.current = null;
      setHandoff(false);
      setError(
        "The chat window is not responding. Your edits remain here; try docking again when the chat is ready.",
      );
    }, 30_000);
  }, [post]);

  const openFile = useCallback(
    (relativePath: string, line?: number) => {
      const current = sessionRef.current;
      if (!current || snapshotInFlight.current) return;
      const id = `file:${relativePath}` as const;
      const existing = current.surfaces.find((surface) => surface.id === id);
      const next: DetachedFileSurface = {
        id,
        kind: "file",
        relativePath,
        revealLine: line ?? null,
        revealRequestId: existing?.kind === "file" ? existing.revealRequestId + 1 : 0,
      };
      updateSession({
        ...current,
        surfaces: existing
          ? current.surfaces.map((surface) => (surface.id === id ? next : surface))
          : [...current.surfaces, next],
        activeSurfaceId: id,
      });
    },
    [updateSession],
  );

  const receive = useEffectEvent(async (event: MessageEvent<unknown>) => {
    if (
      event.source !== window.opener ||
      !window.opener ||
      event.origin !== window.location.origin ||
      !isDetachedFileViewerMessage(event.data)
    )
      return;
    const message = event.data;
    if (message.type === "t3-file-viewer:allow-close") {
      clearDockWatchdog();
      allowClose.current = true;
      window.close();
    } else if (message.type === "t3-file-viewer:resume") {
      clearDockWatchdog();
      handoffGeneration.current += 1;
      if (!snapshotInFlight.current) {
        const current = sessionRef.current;
        if (current) resumeProjectFileSaves(current.context.environmentId, current.context.cwd);
        setHandoff(false);
      }
    } else if (message.type === "t3-file-viewer:initialize") {
      if (
        sessionRef.current ||
        message.context.environmentId !== environmentId ||
        message.context.threadRef.threadId !== threadId
      )
        return;
      restoreUnsavedProjectFiles(
        message.context.environmentId,
        message.context.cwd,
        message.snapshot.drafts,
      );
      updateSession({
        context: message.context,
        surfaces: message.snapshot.surfaces,
        activeSurfaceId: message.snapshot.activeSurfaceId,
      });
      document.title = `${message.context.projectName} · Files · T3 Code`;
      post({ type: "t3-file-viewer:initialized" });
    } else if (message.type === "t3-file-viewer:workspace-changed") {
      const current = sessionRef.current;
      if (current && current.context.workspaceMutationId !== message.workspaceMutationId) {
        updateSession({
          ...current,
          context: { ...current.context, workspaceMutationId: message.workspaceMutationId },
        });
      }
    } else if (message.type === "t3-file-viewer:open-file") {
      openFile(message.relativePath, message.line);
    } else if (message.type === "t3-file-viewer:snapshot-request") {
      clearDockWatchdog();
      const current = sessionRef.current;
      if (!current || snapshotInFlight.current) return;
      snapshotInFlight.current = true;
      const generation = handoffGeneration.current;
      flushSync(() => setHandoff(true));
      try {
        await flushProjectFileSaves(current.context.environmentId, current.context.cwd);
      } catch {
        // Failed writes have settled and their optimistic text remains in the
        // snapshot. Returning it to the chat keeps that text recoverable.
      }
      if (generation !== handoffGeneration.current) {
        snapshotInFlight.current = false;
        resumeProjectFileSaves(current.context.environmentId, current.context.cwd);
        setHandoff(false);
        return;
      }
      const latest = snapshot();
      if (latest && !post({ type: "t3-file-viewer:snapshot", snapshot: latest })) {
        snapshotInFlight.current = false;
        resumeProjectFileSaves(current.context.environmentId, current.context.cwd);
        setHandoff(false);
        setError(
          "The chat window is no longer available. Your unsaved changes remain in this window.",
        );
      }
    }
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      void receive(event);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowClose.current || !sessionRef.current) return;
      event.preventDefault();
      event.returnValue = "";
      requestDock();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("beforeunload", onBeforeUnload);
    post({ type: "t3-file-viewer:ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearDockWatchdog();
    };
  }, [post, requestDock, clearDockWatchdog]);

  useEffect(() => {
    if (session) publishState();
  }, [session, publishState]);

  const onPendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      setPendingFiles((current) => {
        const next = new Set(current);
        if (pending) next.add(relativePath);
        else next.delete(relativePath);
        return next;
      });
      // The editor stores its optimistic text before notifying pending status.
      queueMicrotask(publishState);
    },
    [publishState],
  );

  if (!session)
    return (
      <div className="flex h-dvh items-center justify-center p-6 text-muted-foreground text-sm">
        {window.opener
          ? "Connecting to the File Viewer…"
          : "Open the File Viewer from a chat, then choose Detach to use this window."}
      </div>
    );
  const active = session.surfaces.find((surface) => surface.id === session.activeSurfaceId);
  const closeTab = (surface: DetachedFileSurface) => {
    const surfaces = session.surfaces.filter((item) => item.id !== surface.id);
    updateSession({
      ...session,
      surfaces,
      activeSurfaceId:
        session.activeSurfaceId === surface.id
          ? (surfaces.at(-1)?.id ?? null)
          : session.activeSurfaceId,
    });
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-11 shrink-0 items-center gap-3 border-b px-3 [-webkit-app-region:drag]">
        <span className="min-w-0 flex-1 truncate text-sm">
          {session.context.projectName} · Files
        </span>
        <span className="[-webkit-app-region:no-drag]">
          <Button size="sm" variant="ghost" disabled={handoff} onClick={requestDock}>
            <PanelLeftCloseIcon />
            Dock in chat
          </Button>
        </span>
      </header>
      {error && (
        <p role="alert" className="px-3 py-2 text-error text-sm">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col" inert={handoff}>
        <nav
          aria-label="Open files"
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-1"
        >
          <Button
            size="sm"
            variant={active?.kind === "files" ? "secondary" : "ghost"}
            onClick={() =>
              updateSession({
                ...session,
                surfaces: session.surfaces.some((surface) => surface.kind === "files")
                  ? session.surfaces
                  : [{ id: "files", kind: "files" }, ...session.surfaces],
                activeSurfaceId: "files",
              })
            }
          >
            Files
          </Button>
          {session.surfaces
            .filter((surface) => surface.kind === "file")
            .map((surface) => (
              <div key={surface.id} className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="sm"
                  variant={surface.id === session.activeSurfaceId ? "secondary" : "ghost"}
                  title={surface.relativePath}
                  onClick={() => updateSession({ ...session, activeSurfaceId: surface.id })}
                >
                  {surface.relativePath.split("/").at(-1)}
                  {pendingFiles.has(surface.relativePath) ? " •" : ""}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Close ${surface.relativePath}`}
                  onClick={() => closeTab(surface)}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
        </nav>
        <div className={cn("min-h-0 flex-1 overflow-hidden", handoff && "opacity-70")}>
          <FilePreviewPanel
            {...session.context}
            reviewCommentActions={reviewCommentActions}
            relativePath={active?.kind === "file" ? active.relativePath : null}
            revealLine={active?.kind === "file" ? active.revealLine : null}
            revealRequestId={active?.kind === "file" ? active.revealRequestId : 0}
            onOpenFile={openFile}
            onPendingChange={onPendingChange}
            selectedFilePending={active?.kind === "file" && pendingFiles.has(active.relativePath)}
          />
        </div>
      </div>
      {handoff && (
        <p role="status" className="shrink-0 px-3 py-2 text-muted-foreground text-sm">
          Saving and returning files to the chat…
        </p>
      )}
    </div>
  );
}
