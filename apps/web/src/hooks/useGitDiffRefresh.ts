import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { subscribeWorkspaceFileSaved } from "../workspaceFileSaved";

/** Reconcile the cached diff with existing status events; no extra Git polling loop. */
export function useGitDiffRefresh({
  enabled,
  environmentId,
  cwd,
  status,
  refresh,
}: {
  enabled: boolean;
  environmentId: EnvironmentId | null;
  cwd: string | null;
  status: VcsStatusResult | null;
  refresh: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(() => {
    if (!enabled || document.visibilityState === "hidden") return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      refresh();
    }, 200);
  }, [enabled, refresh]);
  const signature = useMemo(
    () =>
      status
        ? JSON.stringify([
            status.isRepo,
            status.refName,
            status.workingTree,
            status.fileChanges,
            status.branchChanges,
            status.aheadCount,
            status.behindCount,
          ])
        : null,
    [status],
  );
  useEffect(() => {
    if (signature !== null) schedule();
  }, [schedule, signature]);
  useEffect(() => {
    if (!enabled || environmentId === null || cwd === null) return;
    // A recently cached preview can survive reopening the panel unchanged.
    schedule();
    const unsubscribe = subscribeWorkspaceFileSaved((saved) => {
      if (saved.environmentId === environmentId && saved.cwd === cwd) schedule();
    });
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [cwd, enabled, environmentId, schedule]);
}
