import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MonolithConfig } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { monolithAnalyzerEnvironment } from "~/state/monolithAnalyzers";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

/** The server coalesces sessions for the same workspace; no index job belongs to a thread. */
export function useMonolithIndex(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  config: MonolithConfig | null,
  mutationId?: string | null,
) {
  const canIndex = useAtomValue(monolithAnalyzerEnvironment.index.permissionAtom(environmentId));
  const index = useAtomCommand(monolithAnalyzerEnvironment.index, { reportFailure: false });
  const eligible = environmentId !== null && cwd !== null && config !== null && canIndex;
  const status = useEnvironmentQuery(
    eligible ? monolithAnalyzerEnvironment.indexStatus({ environmentId, input: { cwd } }) : null,
  );
  const refresh = status.refresh;
  const invalidateChecks = useAtomSet(
    monolithAnalyzerEnvironment.checkRevision(`${environmentId ?? ""}:${cwd ?? ""}`),
  );
  const observedRevisions = useRef<{
    destination: string;
    areas: Map<string, string | null>;
  } | null>(null);
  useEffect(() => {
    if (!status.data) return;
    const destination = JSON.stringify([environmentId, cwd]);
    const previous = observedRevisions.current;
    const sameDestination = previous?.destination === destination;
    const areas = new Map(
      status.data.areas.map((area) => [
        area.areaId,
        area.revision ?? (sameDestination ? previous.areas.get(area.areaId) : null) ?? null,
      ]),
    );
    // Index validation temporarily reports "indexing" even when source hashes
    // are identical. Only a changed content/config signature invalidates checks.
    if (
      sameDestination &&
      (areas.size !== previous.areas.size ||
        [...areas].some(([id, revision]) => previous.areas.get(id) !== revision))
    )
      invalidateChecks((value) => value + 1);
    observedRevisions.current = { destination, areas };
  }, [status.data, environmentId, cwd, invalidateChecks]);
  const signature = config ? JSON.stringify(config) : null;
  const lastKey = useRef<{ destination: string; request: string } | null>(null);
  useEffect(() => {
    if (!eligible) return;
    const key = JSON.stringify([environmentId, cwd]);
    const request = JSON.stringify([signature, mutationId]);
    const delay = lastKey.current?.destination === key ? 800 : 0;
    lastKey.current = { destination: key, request };
    const timer = setTimeout(() => {
      void index({ environmentId, input: { cwd } });
    }, delay);
    return () => clearTimeout(timer);
  }, [eligible, environmentId, cwd, signature, mutationId, index]);
  const indexing = status.data?.areas.some((area) => area.status === "indexing") ?? false;
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const reconcile = async () => {
      if (!active) return;
      clearTimeout(timer);
      // Reopening a window, switching branches externally and installing tools
      // all require a new signature check even if no editor write occurred.
      await index({ environmentId, input: { cwd } });
      if (!active) return;
      refresh();
      timer = setTimeout(reconcile, indexing ? 2_000 : 30_000);
    };
    timer = setTimeout(reconcile, indexing ? 2_000 : 30_000);
    const focused = () => {
      if (document.visibilityState !== "hidden") void reconcile();
    };
    window.addEventListener("focus", focused);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("focus", focused);
    };
  }, [eligible, environmentId, cwd, index, indexing, refresh]);
  return status;
}
