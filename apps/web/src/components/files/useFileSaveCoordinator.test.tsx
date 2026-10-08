import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile, readFile, clearFile, saved } =
  vi.hoisted(() => ({
    writeFile: vi.fn(),
    confirmFile: vi.fn(),
    readScope: vi.fn(),
    getUnsavedFile: vi.fn(),
    readFile: vi.fn(),
    clearFile: vi.fn(),
    saved: vi.fn(),
  }));
vi.mock("../../workspaceFileSaved", () => ({ notifyWorkspaceFileSaved: saved }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: readFile } }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: confirmFile,
  clearProjectFileQueryData: clearFile,
  getProjectFileQueryAtom: vi.fn(),
  getUnsavedProjectFileQueryData: getUnsavedFile,
}));

import { setMarkdownTaskChecked } from "./filePreviewMode";
import {
  flushProjectFileSaves,
  resumeProjectFileSaves,
  useFileSaveCoordinator,
} from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
let renderer: ReactTestRenderer | null;

function ChangeSource(_props: { onChange: (contents: string) => void }) {
  return null;
}

function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
  const coordinator = useFileSaveCoordinator(props);
  return <ChangeSource onChange={(contents) => coordinator.change(contents)} />;
}

function mount(props = defaultProps) {
  act(() => {
    renderer = create(
      <StrictMode>
        <FileSurface {...props} />
      </StrictMode>,
    );
  });
}

function changeHandler(): (contents: string) => void {
  return renderer!.root.findByType(ChangeSource).props.onChange;
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  onPendingChange.mockReset();
  readFile.mockReset().mockReturnValue(AsyncResult.initial());
  clearFile.mockReset();
  saved.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file-save React lifecycle", () => {
  it("failed saves cannot retry on disposal after ownership transfers", async () => {
    const failed = AsyncResult.failure(Cause.die(new Error("save failed")));
    writeFile.mockResolvedValue(failed);
    mount();
    changeHandler()("unsaved transferred draft");
    await flushProjectFileSaves(environmentId, "/workspace");
    expect(writeFile).toHaveBeenCalledOnce();
    await act(async () => renderer!.unmount());
    renderer = null;
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(confirmFile).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("also suspends ownership when a flush throws", async () => {
    writeFile.mockRejectedValueOnce(new Error("flush write rejected"));
    mount();
    changeHandler()("draft retained after exception");
    await expect(flushProjectFileSaves(environmentId, "/workspace")).rejects.toThrow(
      "flush write rejected",
    );
    await act(async () => renderer!.unmount());
    renderer = null;
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(confirmFile).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("resumes a suspended editor after a cancelled handoff", async () => {
    writeFile.mockResolvedValueOnce(AsyncResult.failure(Cause.die(new Error("first save failed"))));
    mount();
    changeHandler()("pending draft");
    await flushProjectFileSaves(environmentId, "/workspace");
    changeHandler()("ignored while transferring");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledOnce();
    resumeProjectFileSaves(environmentId, "/workspace");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0].input.contents).toBe("pending draft");
    changeHandler()("new edit after cancellation");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile.mock.calls[2]![0].input.contents).toBe("new edit after cancellation");
  });

  it("a project handoff waits for a disposed preview's in-flight write", async () => {
    let finishWrite!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
    const write = new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
      finishWrite = resolve;
    });
    writeFile.mockReturnValueOnce(write);
    mount();
    changeHandler()("pending transfer draft");
    await vi.advanceTimersByTimeAsync(500);
    await act(async () => renderer!.unmount());
    renderer = null;

    let settled = false;
    const handoff = flushProjectFileSaves(environmentId, "/workspace").then(() => {
      settled = true;
    });
    await flushProjectFileSaves(environmentId, "/unrelated");
    expect(settled).toBe(false);
    finishWrite(AsyncResult.success(undefined));
    await handoff;
    expect(confirmFile).toHaveBeenCalledWith(
      environmentId,
      "/workspace",
      "file.txt",
      "pending transfer draft",
    );
    expect(settled).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("a project handoff flushes only the requested environment and root", async () => {
    mount();
    changeHandler()("target project draft");
    await flushProjectFileSaves(EnvironmentId.make("unrelated-environment"), "/workspace");
    await flushProjectFileSaves(environmentId, "/unrelated");
    expect(writeFile).not.toHaveBeenCalled();
    await flushProjectFileSaves(environmentId, "/workspace");
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "target project draft" },
    });
  });

  it("contains automatic save exceptions while a later handoff can retry the retained draft", async () => {
    writeFile.mockRejectedValueOnce(new Error("host write rejected"));
    mount();
    changeHandler()("retained draft");
    await vi.advanceTimersByTimeAsync(500);
    expect(confirmFile).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    await flushProjectFileSaves(environmentId, "/workspace");
    expect(confirmFile).toHaveBeenCalledWith(
      environmentId,
      "/workspace",
      "file.txt",
      "retained draft",
    );
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer unsaved buffer when an earlier disk write finishes", async () => {
    confirmFile.mockReturnValue(false);
    mount();
    changeHandler()("older persisted source");
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toHaveBeenCalledOnce();
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
  });

  it("notifies the diff only after a successful confirmed write", async () => {
    mount();
    changeHandler()("new source");
    expect(saved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith({ environmentId, cwd: "/workspace" });
  });

  it("clears an unchanged optimistic draft without writing or refreshing analysis", async () => {
    readFile.mockReturnValue(AsyncResult.success({ contents: "disk contents", truncated: false }));
    getUnsavedFile.mockReturnValue({ contents: "disk contents" });
    mount();
    changeHandler()("disk contents");
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();
    expect(confirmFile).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(clearFile).toHaveBeenCalledWith(environmentId, "/workspace", "file.txt");
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("keeps a newer optimistic draft from another editor when a stale no-op arrives", async () => {
    readFile.mockReturnValue(AsyncResult.success({ contents: "disk contents", truncated: false }));
    mount();
    getUnsavedFile.mockReturnValue({ contents: "newer draft" });
    changeHandler()("disk contents");
    expect(clearFile).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalledWith("file.txt", false);
    getUnsavedFile.mockReturnValue(null);
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("persists a recovered draft using the raw disk baseline, not the optimistic draft", async () => {
    readFile.mockReturnValue(AsyncResult.success({ contents: "old contents", truncated: false }));
    getUnsavedFile.mockReturnValue({ contents: "draft contents" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("draft contents");
  });

  it("does not trust a truncated disk read as a complete baseline", async () => {
    readFile.mockReturnValue(AsyncResult.success({ contents: "prefix", truncated: true }));
    mount();
    changeHandler()("prefix");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    mount();
    changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("pending edit");
    await act(async () => renderer!.unmount());
    renderer = null;
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      mount();
      changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await act(async () => renderer!.unmount());
        renderer = null;
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(saved).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "pending draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("recovers an existing draft once after StrictMode setup replay", async () => {
    getUnsavedFile.mockReturnValue({ contents: "reopened draft" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "reopened draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...nextProps} />
        </StrictMode>,
      ),
    );
    retiredChange("stale editor contents");
    changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    mount();
    const retiredChange = changeHandler();
    await act(async () => renderer!.unmount());
    renderer = null;
    mount();
    retiredChange("stale contents");
    changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});
