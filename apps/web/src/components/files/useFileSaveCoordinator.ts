import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { createRef, useEffect, useMemo } from "react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  clearProjectFileQueryData,
  getProjectFileQueryAtom,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

const activeFileSaves = new Map<
  FileSaveCoordinator,
  { environmentId: EnvironmentId; cwd: string }
>();

/** Freeze the editor before calling so the receiving window owns all subsequent writes. */
export async function flushProjectFileSaves(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<void> {
  const coordinators = [...activeFileSaves].flatMap(([coordinator, context]) =>
    context.environmentId === environmentId && context.cwd === cwd ? [coordinator] : [],
  );
  const results = await Promise.allSettled(coordinators.map((coordinator) => coordinator.flush()));
  for (const coordinator of coordinators) coordinator.suspend();
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export function resumeProjectFileSaves(environmentId: EnvironmentId, cwd: string): void {
  for (const [coordinator, context] of activeFileSaves) {
    if (context.environmentId === environmentId && context.cwd === cwd) coordinator.resume();
  }
}

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          canPersist: () => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
          readPersistedContents: () => {
            const result = appAtomRegistry.get(
              getProjectFileQueryAtom(environmentId, cwd, relativePath),
            );
            const file = Option.getOrUndefined(AsyncResult.value(result));
            return file?.truncated ? undefined : file?.contents;
          },
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: (nextContents) =>
            writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents },
            }),
          onConfirmed: (confirmedContents) =>
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents),
          onUnchanged: (contents) => {
            const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
            if (unsaved && unsaved.contents !== contents) return false;
            if (unsaved) clearProjectFileQueryData(environmentId, cwd, relativePath);
            return true;
          },
        });
        coordinatorRef.current = coordinator;
        activeFileSaves.set(coordinator, { environmentId, cwd });
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
          // Disposed previews may still own an in-flight write during a window handoff.
          void coordinator
            .waitForIdle()
            .catch(() => {})
            .finally(() => activeFileSaves.delete(coordinator));
        };
      },
    };
  }, [cwd, environmentId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => {
    if (!canWriteFiles) return;
    let cancelled = false;
    // Replay must retire the first session before recovery queues a draft to flush.
    queueMicrotask(() => {
      if (cancelled) return;
      const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      if (unsaved) session.change(unsaved.contents);
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFiles, cwd, environmentId, relativePath, session]);
  return session;
}
