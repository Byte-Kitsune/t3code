import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const registryTasks = vi.hoisted(() => new Set<() => void>());

vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return {
    appAtomRegistry: AtomRegistry.make({
      scheduleTask: (task) => {
        registryTasks.add(task);
        return () => {
          registryTasks.delete(task);
        };
      },
    }),
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getUnsavedProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
  snapshotUnsavedProjectFiles,
  restoreUnsavedProjectFiles,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");
const optimisticFile = projectEnvironment.optimisticFile({
  environmentId,
  cwd: "/repo",
  relativePath: "convex.json",
});

function drainRegistryTasks(): void {
  while (registryTasks.size > 0) {
    const tasks = [...registryTasks];
    registryTasks.clear();
    for (const task of tasks) task();
  }
}

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    drainRegistryTasks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("transfers all retained drafts while isolating environments and project roots", () => {
    const otherEnvironment = EnvironmentId.make("environment-draft-transfer-other");
    const transferredEnvironment = EnvironmentId.make("environment-draft-transfer-destination");
    const files = ["convex.json", "src/closed-preview.ts"];
    try {
      setProjectFileQueryData(environmentId, "/repo", files[0]!, "first draft");
      setProjectFileQueryData(environmentId, "/repo", files[0]!, "latest draft");
      setProjectFileQueryData(environmentId, "/repo", files[1]!, "closed preview draft ✓");
      setProjectFileQueryData(otherEnvironment, "/repo", files[0]!, "other environment");
      setProjectFileQueryData(environmentId, "/other", files[0]!, "other project");
      const snapshot = snapshotUnsavedProjectFiles(environmentId, "/repo");
      expect(snapshot).toEqual([
        { relativePath: files[0], contents: "latest draft" },
        { relativePath: files[1], contents: "closed preview draft ✓" },
      ]);

      restoreUnsavedProjectFiles(transferredEnvironment, "/destination", snapshot);
      expect(snapshotUnsavedProjectFiles(transferredEnvironment, "/destination")).toEqual(snapshot);
      expect(
        getUnsavedProjectFileQueryData(transferredEnvironment, "/destination", files[1]!),
      ).toMatchObject({
        contents: "closed preview draft ✓",
        byteLength: new TextEncoder().encode("closed preview draft ✓").byteLength,
      });
      expect(getUnsavedProjectFileQueryData(otherEnvironment, "/repo", files[0]!)?.contents).toBe(
        "other environment",
      );
    } finally {
      for (const path of files) {
        clearProjectFileQueryData(environmentId, "/repo", path);
        clearProjectFileQueryData(transferredEnvironment, "/destination", path);
      }
      clearProjectFileQueryData(otherEnvironment, "/repo", files[0]!);
      clearProjectFileQueryData(environmentId, "/other", files[0]!);
    }
  });

  it("does not transfer confirmed or explicitly cleared drafts", () => {
    vi.stubGlobal("window", {});
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "saved contents");
    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", "saved contents"),
    ).toBe(true);
    expect(snapshotUnsavedProjectFiles(environmentId, "/repo")).toEqual([]);
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "discarded contents");
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    expect(snapshotUnsavedProjectFiles(environmentId, "/repo")).toEqual([]);
  });

  it("resumes an unsaved draft after closing the preview and restoring write access", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    const closePreview = appAtomRegistry.mount(optimisticFile);
    let canWrite = true;
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(environmentId, "/repo", "convex.json", contents),
      });
    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "unsaved draft");
    initial.change("unsaved draft");
    canWrite = false;
    initial.dispose();
    closePreview();
    await vi.runAllTimersAsync();
    drainRegistryTasks();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    const unsaved = getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json");
    expect(unsaved?.contents).toBe("unsaved draft");

    canWrite = true;
    const reopened = makeCoordinator();
    reopened.change(unsaved!.contents);
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved draft");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
    drainRegistryTasks();
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
  });

  it("releases a retained unsaved draft when explicitly cleared", () => {
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft");
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "latest draft");
    drainRegistryTasks();
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      "latest draft",
    );

    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    drainRegistryTasks();
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
  });

  it("keeps a reopened editor's newer draft pending when the old editor's write finishes", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    let canWrite = true;
    const saved = AsyncResult.success(undefined);
    let finishFirstWrite!: (result: typeof saved) => void;
    const firstWrite = new Promise<typeof saved>((resolve) => {
      finishFirstWrite = resolve;
    });
    const persist = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValue(saved);
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(environmentId, "/repo", "convex.json", contents),
      });

    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft");
    initial.change("first draft");
    await vi.advanceTimersByTimeAsync(500);
    initial.dispose();

    const reopened = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "newer draft");
    reopened.change("newer draft");
    canWrite = false;
    finishFirstWrite(saved);
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      "newer draft",
    );

    canWrite = true;
    reopened.change("newer draft");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenLastCalledWith("newer draft");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });
});
