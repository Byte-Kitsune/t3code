import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: (result: AtomCommandResult<void, never>) => void;
  const promise = new Promise<AtomCommandResult<void, never>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator", () => {
  it("flushes a debounced draft immediately and waits for the write to settle", async () => {
    vi.useFakeTimers();
    const write = deferred();
    const persist = vi.fn().mockReturnValue(write.promise);
    const confirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: confirmed,
    });
    coordinator.change("draft");
    let settled = false;
    const flushing = coordinator.flush().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(persist).toHaveBeenCalledExactlyOnceWith("draft");
    expect(settled).toBe(false);
    write.resolve(AsyncResult.success(undefined));
    await flushing;
    expect(confirmed).toHaveBeenCalledWith("draft");
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight old write and then flushes the newest draft", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const persist = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(() => {
        markSecondStarted();
        return second.promise;
      });
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    const flushing = coordinator.flush();
    first.resolve(AsyncResult.success(undefined));
    await secondStarted;
    expect(persist).toHaveBeenLastCalledWith("latest");
    second.resolve(AsyncResult.success(undefined));
    await flushing;
    expect(persist).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("reports rejected writes and permits a later flush without deadlocking", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(AsyncResult.success(undefined));
    const confirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: confirmed,
    });
    coordinator.change("retained draft");
    await expect(coordinator.flush()).rejects.toThrow("write failed");
    expect(confirmed).not.toHaveBeenCalled();
    await coordinator.flush();
    expect(confirmed).toHaveBeenCalledWith("retained draft");
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite unchanged persisted contents or a successful save", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      readPersistedContents: () => "original",
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("original");
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
    coordinator.change("edited");
    await vi.runAllTimersAsync();
    coordinator.change("edited");
    await vi.runAllTimersAsync();
    coordinator.dispose();
    expect(persist).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("keeps the original debounce when identical editor events arrive", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("edited");
    await vi.advanceTimersByTimeAsync(400);
    coordinator.change("edited");
    await vi.advanceTimersByTimeAsync(100);
    expect(persist).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("cancels an edit reverted before the write starts", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const pending = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      readPersistedContents: () => "original",
      persist,
      onPendingChange: pending,
      onConfirmed: vi.fn(),
    });
    coordinator.change("edited");
    coordinator.change("original");
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it("persists a revert to the initial contents after an in-flight write", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      readPersistedContents: () => "original",
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("edited");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("original");
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist.mock.calls).toEqual([["edited"], ["original"]]);
  });

  it("does not rewrite a concurrent edit reverted to the in-flight contents", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi.fn().mockReturnValueOnce(inFlight.promise);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("edited");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("temporary");
    coordinator.change("edited");
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("retries failed writes on an identical change event", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("edited");
    await vi.runAllTimersAsync();
    coordinator.change("edited");
    await vi.runAllTimersAsync();
    expect(persist.mock.calls).toEqual([["edited"], ["edited"]]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and persists only the latest contents", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("saves an edit made inside the debounce window when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved");
  });

  it.each([false, true])(
    "keeps an edit pending after write permission is removed (closing=%s)",
    async (closeEditor) => {
      vi.useFakeTimers();
      let canWrite = true;
      const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      const onPendingChange = vi.fn();
      const coordinator = new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: vi.fn(),
      });

      coordinator.change("unsaved");
      canWrite = false;
      if (closeEditor) coordinator.dispose();
      await vi.runAllTimersAsync();

      expect(persist).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith(true);
    },
  );

  it("flushes an edit made while a write was in flight when the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("does not rewrite a write that lands while the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("only");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
  });

  it("retries a failed write when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed")))),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores editor changes emitted after disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.dispose();
    coordinator.change("stale contents");
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("does not persist confirmed contents again on disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("temporary edit");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("original contents");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(2);

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
  });
});
