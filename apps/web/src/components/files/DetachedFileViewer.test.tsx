// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DetachedFileViewer } from "./DetachedFileViewer";
import type { FileReviewCommentActions } from "./FilePreviewPanel";
import { buildFileReviewComment } from "~/reviewCommentContext";
import {
  isDetachedFileViewerMessage,
  type DetachedFileViewerContext,
} from "./detachedFileViewerProtocol";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  restore: vi.fn(),
  snapshot: vi.fn(() => [] as { relativePath: string; contents: string }[]),
  flush: vi.fn(async () => {}),
}));
vi.mock("./projectFilesQueryState", () => ({
  restoreUnsavedProjectFiles: mocks.restore,
  snapshotUnsavedProjectFiles: mocks.snapshot,
}));
vi.mock("./useFileSaveCoordinator", () => ({
  flushProjectFileSaves: mocks.flush,
  resumeProjectFileSaves: mocks.resume,
}));
vi.mock("./FilePreviewPanel", () => ({
  default: ({
    relativePath,
    onOpenFile,
    reviewCommentActions,
  }: {
    relativePath: string | null;
    onOpenFile: (path: string) => void;
    reviewCommentActions: FileReviewCommentActions;
  }) => (
    <div>
      <p data-testid="path">{relativePath ?? "explorer"}</p>
      <button onClick={() => onOpenFile("src/Other.php")}>Open other file</button>
      <button
        onClick={() =>
          reviewCommentActions.add(context.composerDraftTarget, comment, { insertAtCaret: true })
        }
      >
        Comment
      </button>
      <button onClick={() => reviewCommentActions.remove(context.composerDraftTarget, comment.id)}>
        Remove comment
      </button>
    </div>
  ),
}));

const context: DetachedFileViewerContext = {
  environmentId: EnvironmentId.make("env-one"),
  cwd: "/workspace",
  projectName: "Demo",
  threadRef: {
    environmentId: EnvironmentId.make("env-one"),
    threadId: ThreadId.make("thread-one"),
  },
  composerDraftTarget: {
    environmentId: EnvironmentId.make("env-one"),
    threadId: ThreadId.make("thread-one"),
  },
  keybindings: [],
  availableEditors: [],
  workspaceMutationId: null,
};
const comment = buildFileReviewComment({
  id: "comment-one",
  filePath: "src/Demo.php",
  startLine: 1,
  endLine: 1,
  text: "Explain this",
  contents: "<?php",
});
const initialSnapshot = {
  surfaces: [
    {
      id: "file:src/Demo.php",
      kind: "file",
      relativePath: "src/Demo.php",
      revealLine: null,
      revealRequestId: 0,
    },
  ],
  activeSurfaceId: "file:src/Demo.php",
  drafts: [{ relativePath: "src/Demo.php", contents: "unsaved" }],
};
let root: Root;
let container: HTMLDivElement;
let opener: Window;
let post: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.snapshot.mockReturnValue([]);
  mocks.flush.mockResolvedValue(undefined);
  post = vi.fn();
  opener = { postMessage: post, closed: false } as unknown as Window;
  vi.stubGlobal("opener", opener);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<DetachedFileViewer environmentId="env-one" threadId="thread-one" />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function message(data: unknown, source = opener, origin = window.location.origin) {
  await act(async () =>
    window.dispatchEvent(new MessageEvent("message", { data, source, origin })),
  );
}
async function initialize() {
  await message({ type: "t3-file-viewer:initialize", context, snapshot: initialSnapshot });
}

describe("detached file handoff", () => {
  it("accepts only its opener, origin and thread before restoring edits", async () => {
    await message(
      { type: "t3-file-viewer:initialize", context, snapshot: initialSnapshot },
      window,
    );
    await message(
      { type: "t3-file-viewer:initialize", context, snapshot: initialSnapshot },
      opener,
      "https://wrong.example",
    );
    await message({
      type: "t3-file-viewer:initialize",
      context: { ...context, threadRef: { ...context.threadRef, threadId: "another-thread" } },
      snapshot: initialSnapshot,
    });
    expect(mocks.restore).not.toHaveBeenCalled();
    await initialize();
    expect(mocks.restore).toHaveBeenCalledWith(
      context.environmentId,
      context.cwd,
      initialSnapshot.drafts,
    );
    expect(container.querySelector('[data-testid="path"]')?.textContent).toBe("src/Demo.php");
    expect(post).toHaveBeenCalledWith(
      { type: "t3-file-viewer:initialized" },
      window.location.origin,
    );
  });

  it("opens tabs locally and returns unsaved text even when a save fails", async () => {
    await initialize();
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Open other file")!
        .click(),
    );
    expect(container.querySelector('[data-testid="path"]')?.textContent).toBe("src/Other.php");
    mocks.snapshot.mockReturnValue([
      { relativePath: "src/Other.php", contents: "newer unsaved text" },
    ]);
    mocks.flush.mockRejectedValue(new Error("write denied"));
    await message({ type: "t3-file-viewer:snapshot-request" });
    expect(mocks.flush).toHaveBeenCalledWith(context.environmentId, context.cwd);
    const response = post.mock.calls.find(
      ([value]) => value.type === "t3-file-viewer:snapshot",
    )![0];
    expect(response.snapshot.activeSurfaceId).toBe("file:src/Other.php");
    expect(response.snapshot.drafts).toEqual([
      { relativePath: "src/Other.php", contents: "newer unsaved text" },
    ]);
    expect(container.querySelector("[inert]")).not.toBeNull();
  });

  it("requests docking on window close and closes only after parent acknowledgement", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    await initialize();
    const event = new Event("beforeunload", { cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith(
      { type: "t3-file-viewer:dock-request" },
      window.location.origin,
    );
    expect(close).not.toHaveBeenCalled();
    await message({ type: "t3-file-viewer:allow-close" });
    expect(close).toHaveBeenCalledOnce();
    close.mockRestore();
  });

  it("keeps edits frozen until a cancelled handoff finishes its pending write", async () => {
    await initialize();
    let settle!: () => void;
    mocks.flush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    await message({ type: "t3-file-viewer:snapshot-request" });
    expect(container.querySelector("[inert]")).not.toBeNull();
    await message({ type: "t3-file-viewer:resume" });
    expect(container.querySelector("[inert]")).not.toBeNull();
    await act(async () => {
      settle();
    });
    expect(container.querySelector("[inert]")).toBeNull();
    expect(mocks.resume).toHaveBeenCalledWith(context.environmentId, context.cwd);
    expect(post.mock.calls.some(([value]) => value.type === "t3-file-viewer:snapshot")).toBe(false);
  });

  it("allows the parent to close a child that never initialized", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    await message({ type: "t3-file-viewer:allow-close" });
    expect(close).toHaveBeenCalledOnce();
    close.mockRestore();
  });

  it("sends file comments to the originating chat instead of a separate composer", async () => {
    await initialize();
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Comment")!
        .click(),
    );
    const sent = post.mock.calls.find(
      ([value]) => value.type === "t3-file-viewer:add-review-comment",
    )![0];
    expect(sent).toEqual({
      type: "t3-file-viewer:add-review-comment",
      comment,
      options: { insertAtCaret: true },
    });
    expect(isDetachedFileViewerMessage(sent)).toBe(true);
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove comment")!
        .click(),
    );
    expect(post).toHaveBeenCalledWith(
      { type: "t3-file-viewer:remove-review-comment", commentId: comment.id },
      window.location.origin,
    );
  });

  it("keeps the viewer editable when a reloaded chat no longer answers docking", async () => {
    await initialize();
    vi.useFakeTimers();
    try {
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.includes("Dock in chat"))!
          .click(),
      );
      expect(container.querySelector("[inert]")).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(30_000));
      expect(container.querySelector("[inert]")).toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "chat window is not responding",
      );
      expect(mocks.flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the open tab and unsaved draft across chat workspace updates", async () => {
    await initialize();
    mocks.snapshot.mockReturnValue([
      { relativePath: "src/Demo.php", contents: "edit in progress" },
    ]);
    await message({
      type: "t3-file-viewer:workspace-changed",
      workspaceMutationId: "agent-turn-two",
    });
    expect(container.querySelector('[data-testid="path"]')?.textContent).toBe("src/Demo.php");
    expect(mocks.restore).toHaveBeenCalledOnce();
    const response = post.mock.calls.findLast(
      ([value]) => value.type === "t3-file-viewer:state",
    )![0];
    expect(response.snapshot.activeSurfaceId).toBe("file:src/Demo.php");
    expect(response.snapshot.drafts).toEqual([
      { relativePath: "src/Demo.php", contents: "edit in progress" },
    ]);
  });

  it("navigates an already detached file viewer from parent links", async () => {
    await initialize();
    await message({ type: "t3-file-viewer:open-file", relativePath: "src/Linked.php", line: 23 });
    expect(container.querySelector('[data-testid="path"]')?.textContent).toBe("src/Linked.php");
    const response = post.mock.calls.findLast(
      ([value]) => value.type === "t3-file-viewer:state",
    )![0];
    expect(response.snapshot.surfaces.at(-1).revealLine).toBe(23);
  });
});

describe("handoff protocol", () => {
  it("rejects invalid snapshots and mismatched environments", () => {
    expect(
      isDetachedFileViewerMessage({
        type: "t3-file-viewer:initialize",
        context,
        snapshot: initialSnapshot,
      }),
    ).toBe(true);
    expect(
      isDetachedFileViewerMessage({
        type: "t3-file-viewer:initialize",
        context: { ...context, environmentId: "other" },
        snapshot: initialSnapshot,
      }),
    ).toBe(false);
    expect(
      isDetachedFileViewerMessage({
        type: "t3-file-viewer:snapshot",
        snapshot: { ...initialSnapshot, activeSurfaceId: "not-open" },
      }),
    ).toBe(false);
    expect(
      isDetachedFileViewerMessage({
        type: "t3-file-viewer:snapshot",
        snapshot: {
          ...initialSnapshot,
          surfaces: [...initialSnapshot.surfaces, ...initialSnapshot.surfaces],
        },
      }),
    ).toBe(false);
  });
});
