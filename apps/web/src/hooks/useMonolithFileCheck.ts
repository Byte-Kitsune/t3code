import { useAtomValue } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type MonolithCheckFileResult,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzerContentRevision,
  fileAnalyzerDiagnostics,
} from "~/components/files/fileAnalyzerDiagnostics";
import { monolithAnalyzerEnvironment } from "~/state/monolithAnalyzers";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

type CheckState = {
  key: string;
  sourceKey: string;
  status: "checked" | "failed" | "stale";
  result?: MonolithCheckFileResult;
};

const EMPTY_DIAGNOSTICS: MonolithCheckFileResult["diagnostics"] = [];

export function useMonolithFileCheck(input: {
  environmentId: EnvironmentId;
  cwd: string;
  path: string | null;
  contents: string | null;
  persisted: boolean;
  onStale: () => void;
}) {
  const { environmentId, cwd, path, contents, persisted, onStale } = input;
  const configs = useServerConfigs();
  const supported = configs.get(environmentId)?.environment.capabilities.monolithAnalyzers === true;
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canRun = useAtomValue(monolithAnalyzerEnvironment.checkFile.permissionAtom(environmentId));
  const check = useAtomCommand(monolithAnalyzerEnvironment.checkFile, { reportFailure: false });
  const toolsRevision = useAtomValue(
    monolithAnalyzerEnvironment.checkRevision(`${environmentId}:${cwd}`),
  );
  const revision = useMemo(
    () =>
      !supported || path === null || contents === null ? null : analyzerContentRevision(contents),
    [contents, supported, path],
  );
  const sourceKey = JSON.stringify([environmentId, cwd, path, revision]);
  const key = JSON.stringify([sourceKey, toolsRevision]);
  const staleCallback = useRef(onStale);
  useEffect(() => {
    staleCallback.current = onStale;
  }, [onStale]);
  const [state, setState] = useState<CheckState | null>(null);
  const inFlight = useRef<{ key: string; response: ReturnType<typeof check> } | null>(null);
  const eligible =
    supported && canRead && canRun && persisted && path !== null && revision !== null;

  useEffect(() => {
    if (!supported || !canRead || !canRun) {
      inFlight.current = null;
      return;
    }
    if (!eligible || path === null || state?.key === key) return;
    let active = true;
    // A background read or unchanged save can briefly suspend eligibility.
    // Reattach to the same native run instead of queuing another full PHP analysis.
    if (inFlight.current?.key !== key)
      inFlight.current = { key, response: check({ environmentId, input: { cwd, path } }) };
    void inFlight.current.response.then((response) => {
      if (!active) return;
      if (response._tag === "Failure") {
        setState({ key, sourceKey, status: "failed" });
      } else if (response.value.revision !== revision) {
        // An external write during the run invalidates line locations. Wait for
        // the file query's next revision instead of labeling the old source.
        setState({ key, sourceKey, status: "stale" });
        staleCallback.current();
      } else {
        setState({ key, sourceKey, status: "checked", result: response.value });
      }
    });
    return () => {
      active = false;
    };
  }, [
    check,
    cwd,
    eligible,
    environmentId,
    key,
    path,
    revision,
    sourceKey,
    state,
    supported,
    canRead,
    canRun,
  ]);

  const accessible = supported && canRead && canRun;
  const current = accessible && state?.key === key ? state : null;
  // A tool/dependency refresh can keep results for identical source bytes. A
  // different file or draft must immediately lose the old line locations.
  const result =
    accessible && state?.sourceKey === sourceKey && state.status === "checked"
      ? state.result
      : undefined;
  const diagnostics = useMemo(
    () =>
      result && path !== null && contents !== null
        ? fileAnalyzerDiagnostics(result.diagnostics, path, contents)
        : EMPTY_DIAGNOSTICS,
    [contents, result, path],
  );
  return {
    supported,
    canRun: canRead && canRun,
    status: !persisted
      ? result
        ? ("checked" as const)
        : ("unsaved" as const)
      : (current?.status ?? (eligible ? ("checking" as const) : ("idle" as const))),
    result: result ?? null,
    diagnostics,
  };
}
