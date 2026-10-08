import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadRightPanelState } from "~/rightPanelStore";
import type {
  DetachedFileViewerContext,
  DetachedFileViewerSnapshot,
} from "./detachedFileViewerProtocol";

const mocks = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<void>>(),
  snapshot: vi.fn(() => [] as { relativePath: string; contents: string }[]),
  restore: vi.fn(),
  resume: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  close: vi.fn(),
  addReviewComment: vi.fn(),
  removeReviewComment: vi.fn(),
  state: { byThreadKey: {} as Record<string, ThreadRightPanelState> },
}));
vi.mock("./useFileSaveCoordinator", () => ({
  flushProjectFileSaves: mocks.flush,
  resumeProjectFileSaves: mocks.resume,
}));
vi.mock("./projectFilesQueryState", () => ({
  clearProjectFileQueryData: mocks.clear,
  getProjectFileQueryAtom: (environmentId: string, cwd: string, path: string) => ({
    environmentId,
    cwd,
    path,
  }),
  restoreUnsavedProjectFiles: mocks.restore,
  snapshotUnsavedProjectFiles: mocks.snapshot,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/composerDraftStore", async () => {
  const actual =
    await vi.importActual<typeof import("~/composerDraftStore")>("~/composerDraftStore");
  return {
    DraftId: actual.DraftId,
    useComposerDraftStore: {
      getState: () => ({
        addReviewComment: mocks.addReviewComment,
        removeReviewComment: mocks.removeReviewComment,
      }),
    },
  };
});
vi.mock("~/rightPanelStore", async () => {
  const { scopedThreadKey: key } = await import("@t3tools/client-runtime/environment");
  return {
    selectThreadRightPanelState: (
      by: Record<string, ThreadRightPanelState>,
      ref: ScopedThreadRef,
    ) => by[key(ref)],
    useRightPanelStore: {
      getState: () => ({ ...mocks.state, close: mocks.close }),
      setState: (update: (state: typeof mocks.state) => Partial<typeof mocks.state>) => {
        mocks.state = { ...mocks.state, ...update(mocks.state) };
      },
    },
  };
});

const threadRef = {
  environmentId: EnvironmentId.make("env-test"),
  threadId: ThreadId.make("thread-test"),
};
const context: DetachedFileViewerContext = {
  environmentId: threadRef.environmentId,
  threadRef,
  cwd: "/repo",
  projectName: "Project",
  composerDraftTarget: threadRef,
  availableEditors: [],
  keybindings: [],
  workspaceMutationId: null,
};
const surfaces: DetachedFileViewerSnapshot["surfaces"] = [
  { kind: "files", id: "files" },
  {
    kind: "file",
    id: "file:src/test.php",
    relativePath: "src/test.php",
    revealLine: null,
    revealRequestId: 0,
  },
];
let messageListeners: Set<(event: MessageEvent) => void>;
let child: {
  closed: boolean;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};
let open: ReturnType<typeof vi.fn>;
let api: typeof import("./useDetachedFileViewer");
function message(data: unknown, source: unknown = child, origin = "https://t3.test") {
  for (const listener of messageListeners) listener({ source, origin, data } as MessageEvent);
}
function sent(type: string) {
  return child.postMessage.mock.calls.filter(([value]) => value.type === type);
}
async function beginDetached() {
  await api.detachFileViewer(context);
  message({ type: "t3-file-viewer:ready" });
  message({ type: "t3-file-viewer:initialized" });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.flush.mockResolvedValue(undefined);
  mocks.snapshot.mockReturnValue([]);
  mocks.state = {
    byThreadKey: {
      [scopedThreadKey(threadRef)]: {
        isOpen: true,
        activeSurfaceId: "file:src/test.php",
        surfaces: [...surfaces],
      },
    },
  };
  mocks.close.mockImplementation((ref: ScopedThreadRef) => {
    mocks.state.byThreadKey[scopedThreadKey(ref)]!.isOpen = false;
  });
  messageListeners = new Set();
  child = { closed: false, focus: vi.fn(), postMessage: vi.fn() };
  open = vi.fn(() => child);
  vi.stubGlobal("window", {
    location: new URL("https://t3.test/#/threads/thread-test"),
    open,
    addEventListener: (name: string, listener: (event: MessageEvent) => void) => {
      if (name === "message") messageListeners.add(listener);
    },
    removeEventListener: (name: string, listener: (event: MessageEvent) => void) => {
      if (name === "message") messageListeners.delete(listener);
    },
  });
  api = await import("./useDetachedFileViewer");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("detached file viewer ownership", () => {
  it("waits for pending saves and child readiness before transferring drafts, then waits for acknowledgement", async () => {
    let finishSave!: () => void;
    mocks.flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    mocks.snapshot.mockReturnValue([{ relativePath: "src/test.php", contents: "unsaved" }]);
    const operation = api.detachFileViewer(context);
    message({ type: "t3-file-viewer:ready" });
    expect(sent("t3-file-viewer:initialize")).toHaveLength(0);
    expect(mocks.close).not.toHaveBeenCalled();
    finishSave();
    await operation;
    expect(sent("t3-file-viewer:initialize")[0]?.[0].snapshot.drafts).toEqual([
      { relativePath: "src/test.php", contents: "unsaved" },
    ]);
    expect(mocks.clear).not.toHaveBeenCalled();
    message({ type: "t3-file-viewer:initialized" });
    expect(mocks.close).toHaveBeenCalledWith(threadRef);
    expect(mocks.clear).toHaveBeenCalledWith(context.environmentId, context.cwd, "src/test.php");
    expect(new URL(open.mock.calls[0]?.[0]).hash).toContain(
      "/detached-files?environmentId=env-test&threadId=thread-test",
    );
  });

  it("ignores acknowledgements before initialization was sent", async () => {
    await api.detachFileViewer(context);
    message({ type: "t3-file-viewer:initialized" });
    expect(mocks.close).not.toHaveBeenCalled();
    expect(sent("t3-file-viewer:initialize")).toHaveLength(0);
  });

  it("ignores wrong origins, unrelated windows and malformed snapshots", async () => {
    await api.detachFileViewer(context);
    message({ type: "t3-file-viewer:ready" }, {}, "https://t3.test");
    message({ type: "t3-file-viewer:ready" }, child, "https://evil.test");
    message({ type: "unknown" });
    expect(sent("t3-file-viewer:initialize")).toHaveLength(0);
    message({ type: "t3-file-viewer:ready" });
    message({ type: "t3-file-viewer:initialized" });
    api.dockDetachedFileViewer();
    message({
      type: "t3-file-viewer:snapshot",
      snapshot: { surfaces, activeSurfaceId: "wrong", drafts: [] },
    });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(sent("t3-file-viewer:allow-close")).toHaveLength(0);
  });

  it("uses the trusted opener source on opaque desktop origins while posting with wildcard target", async () => {
    Object.defineProperty(window, "location", {
      value: new URL("t3code://app/#/threads/thread-test"),
    });
    await api.detachFileViewer(context);
    message({ type: "t3-file-viewer:ready" }, {}, "null");
    expect(sent("t3-file-viewer:initialize")).toHaveLength(0);
    message({ type: "t3-file-viewer:ready" }, child, "null");
    expect(sent("t3-file-viewer:initialize")[0]?.[1]).toBe("*");
    message({ type: "t3-file-viewer:initialized" }, child, "null");
    expect(mocks.close).toHaveBeenCalledWith(threadRef);
  });

  it("restores authoritative child drafts and refreshes disk data only after docking snapshot arrives", async () => {
    await beginDetached();
    api.dockDetachedFileViewer();
    expect(sent("t3-file-viewer:snapshot-request")).toHaveLength(1);
    expect(mocks.restore).not.toHaveBeenCalled();
    const snapshot = {
      surfaces,
      activeSurfaceId: "file:src/test.php",
      drafts: [{ relativePath: "src/test.php", contents: "child edits" }],
    };
    message({ type: "t3-file-viewer:snapshot", snapshot });
    expect(mocks.restore).toHaveBeenCalledWith(context.environmentId, context.cwd, snapshot.drafts);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledWith(context.environmentId, context.cwd);
    expect(mocks.state.byThreadKey[scopedThreadKey(threadRef)]?.isOpen).toBe(true);
    expect(sent("t3-file-viewer:allow-close")).toHaveLength(1);
    expect(messageListeners.size).toBe(0);
  });

  it("forwards review comments to the original composer after another thread becomes active", async () => {
    await beginDetached();
    const other = { ...threadRef, threadId: ThreadId.make("other-thread") };
    mocks.state.byThreadKey[scopedThreadKey(other)] = {
      isOpen: true,
      surfaces: [{ kind: "diff", id: "diff" }],
      activeSurfaceId: "diff",
    };
    const comment = {
      id: "comment-one",
      sectionId: "file:src/test.php",
      sectionTitle: "test.php",
      filePath: "src/test.php",
      startIndex: 1,
      endIndex: 2,
      rangeLabel: "L1–2",
      text: "Check this",
      diff: "code",
    };
    const options = { appendReference: true, insertAtCaret: false };
    message({ type: "t3-file-viewer:add-review-comment", comment, options });
    expect(mocks.addReviewComment).toHaveBeenCalledWith(
      context.composerDraftTarget,
      comment,
      options,
    );
    message({ type: "t3-file-viewer:remove-review-comment", commentId: comment.id });
    expect(mocks.removeReviewComment).toHaveBeenCalledWith(context.composerDraftTarget, comment.id);
    expect(mocks.addReviewComment.mock.calls[0]?.[0]).not.toEqual(other);
  });

  it("persists child tabs without reopening the panel or replacing a non-file active surface", async () => {
    await beginDetached();
    const snapshot = { surfaces: [surfaces[0]!], activeSurfaceId: "files", drafts: [] };
    message({ type: "t3-file-viewer:state", snapshot });
    const key = scopedThreadKey(threadRef);
    expect(mocks.state.byThreadKey[key]?.isOpen).toBe(false);
    expect(mocks.state.byThreadKey[key]?.surfaces).toEqual(snapshot.surfaces);
    mocks.state.byThreadKey[key] = {
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [{ kind: "diff", id: "diff" }, ...snapshot.surfaces],
    };
    message({ type: "t3-file-viewer:state", snapshot });
    expect(mocks.state.byThreadKey[key]?.activeSurfaceId).toBe("diff");
    expect(mocks.state.byThreadKey[key]?.isOpen).toBe(true);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("keeps the main viewer and drafts when popups are blocked or saves cannot settle", async () => {
    open.mockReturnValueOnce(null);
    await api.detachFileViewer(context);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    mocks.flush.mockRejectedValueOnce(new Error("save failed"));
    await api.detachFileViewer(context);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledWith(context.environmentId, context.cwd);
    expect(sent("t3-file-viewer:allow-close")).toHaveLength(1);
    expect(messageListeners.size).toBe(0);
  });

  it("times out opening without transferring ownership away from the main window", async () => {
    await api.detachFileViewer(context);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(messageListeners.size).toBe(0);
    expect(sent("t3-file-viewer:allow-close")).toHaveLength(1);
  });

  it("resumes main-window saves again when a flush finishes after opening already timed out", async () => {
    let finishSave!: () => void;
    mocks.flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    const operation = api.detachFileViewer(context);
    message({ type: "t3-file-viewer:ready" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    await api.detachFileViewer(context);
    expect(open).toHaveBeenCalledTimes(1);
    finishSave();
    await operation;
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.resume).toHaveBeenLastCalledWith(context.environmentId, context.cwd);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(sent("t3-file-viewer:initialize")).toHaveLength(0);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    await api.detachFileViewer(context);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps ownership in the child after a docking timeout and allows retry", async () => {
    await beginDetached();
    api.dockDetachedFileViewer();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.state.byThreadKey[scopedThreadKey(threadRef)]?.isOpen).toBe(false);
    expect(sent("t3-file-viewer:allow-close")).toHaveLength(0);
    expect(sent("t3-file-viewer:resume")).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    api.dockDetachedFileViewer();
    expect(sent("t3-file-viewer:snapshot-request")).toHaveLength(2);
    message({
      type: "t3-file-viewer:snapshot",
      snapshot: { surfaces, activeSurfaceId: "files", drafts: [] },
    });
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.state.byThreadKey[scopedThreadKey(threadRef)]?.isOpen).toBe(true);
  });

  it("recovers the latest trusted child snapshot when the child unexpectedly closes", async () => {
    await beginDetached();
    const snapshot = {
      surfaces,
      activeSurfaceId: "files",
      drafts: [{ relativePath: "src/test.php", contents: "latest draft" }],
    };
    message({ type: "t3-file-viewer:state", snapshot });
    child.closed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.restore).toHaveBeenCalledWith(context.environmentId, context.cwd, snapshot.drafts);
    expect(mocks.state.byThreadKey[scopedThreadKey(threadRef)]?.isOpen).toBe(true);
    expect(messageListeners.size).toBe(0);
  });
});
