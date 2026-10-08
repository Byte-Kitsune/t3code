import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, MonolithReviewRun } from "@t3tools/contracts";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useMonolithAreas } from "../hooks/useMonolithAreas";
import { useRightPanelStore } from "../rightPanelStore";
import {
  isMonolithReviewActive,
  monolithReviewEnvironment,
  useMonolithReviewStore,
} from "../state/monolithReview";
import { useAtomCommand } from "../state/use-atom-command";
import {
  appendMonolithReviewPrompt,
  canUseMonolithReviewPackage,
} from "./MonolithPrReviewPanel.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function ReviewDisclosure({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: () => ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className={className} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer break-all">{summary}</summary>
      {expanded ? children() : null}
    </details>
  );
}

export function MonolithPrReviewPanel({
  environmentId,
  cwd,
  threadRef,
  composerDraftTarget,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}) {
  const { config, supported } = useMonolithAreas(environmentId, cwd, { initialize: false });
  const key = `${environmentId}:${cwd}`;
  const run = useMonolithReviewStore((state) => state.runs[key]);
  const setRun = useMonolithReviewStore((state) => state.setRun);
  const [base, setBase] = useState("");
  const [includeWorkingTree, setIncludeWorkingTree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const start = useAtomCommand(monolithReviewEnvironment.start, { reportFailure: false });
  const get = useAtomCommand(monolithReviewEnvironment.get, { reportFailure: false });
  const cancel = useAtomCommand(monolithReviewEnvironment.cancel, { reportFailure: false });
  const permission = useAtomValue(monolithReviewEnvironment.start.permissionAtom(environmentId));
  const active = isMonolithReviewActive(run);
  const runId = run?.runId;

  const refresh = useCallback(
    async (includeDetails = true): Promise<MonolithReviewRun | null> => {
      if (!runId) return null;
      const result = await get({ environmentId, input: { cwd, runId, includeDetails } });
      if (result._tag === "Failure") {
        setError("Could not refresh review status. Retry after reconnecting.");
        return null;
      }
      setRun(key, result.value, runId);
      return result.value;
    },
    [cwd, environmentId, get, key, runId, setRun],
  );

  useEffect(() => {
    if (!active) return;
    // A single request at a time; status refresh never starts another analyzer run.
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await refresh(false);
      // Publishing terminal progress retires this effect. Still finish loading
      // the captured details, unless another review has replaced this run.
      if (result && !isMonolithReviewActive(result)) {
        if (useMonolithReviewStore.getState().runs[key]?.runId === result.runId) await refresh();
        return;
      }
      if (disposed) return;
      timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, key, refresh]);

  async function begin() {
    setBusy(true);
    setError(null);
    setAdded(null);
    const baseRef = base.trim() || config?.defaultBaseBranch;
    const result = await start({
      environmentId,
      input: { cwd, ...(baseRef ? { baseRef } : {}), includeWorkingTree },
    });
    if (result._tag === "Failure")
      setError("Could not start PR review. Check the comparison branch and connection.");
    else setRun(key, result.value);
    setBusy(false);
  }

  async function stop() {
    if (!run) return;
    const result = await cancel({ environmentId, input: { cwd, runId: run.runId } });
    if (result._tag === "Failure")
      setError("Could not cancel the review. Retry after reconnecting.");
    else setRun(key, result.value, run.runId);
  }

  async function addPackage(areaId: string | null) {
    // Reload the captured review before placing its findings in the chat draft.
    const current = await refresh();
    if (
      !current ||
      !canUseMonolithReviewPackage(current) ||
      useMonolithReviewStore.getState().runs[key]?.runId !== current.runId
    ) {
      setError(
        "This captured review is unavailable or incomplete. Start a new review before using its findings.",
      );
      return;
    }
    const group = current.groups.find((entry) => entry.areaId === areaId);
    if (!group?.aiPackage?.text.trim()) return;
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      composerDraftTarget,
      appendMonolithReviewPrompt(
        store.getComposerDraft(composerDraftTarget)?.prompt ?? "",
        group.aiPackage.text,
      ),
    );
    setAdded(group.name);
    setError(null);
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 text-xs space-y-4">
      <p className="text-muted-foreground">
        Review changes against a branch, grouped by project area. Checks run in the background. Only
        saved workspace changes are included. AI packages are added to your draft for review before
        sending.
      </p>
      <label className="block space-y-1">
        <span>Comparison branch</span>
        <Input
          size="sm"
          value={base}
          placeholder={config?.defaultBaseBranch ?? "Automatic"}
          onChange={(event) => setBase(event.currentTarget.value)}
          disabled={busy || active}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={includeWorkingTree}
          disabled={busy || active}
          onChange={(event) => setIncludeWorkingTree(event.currentTarget.checked)}
        />
        Include uncommitted and new files
      </label>
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={!supported || !permission || busy || active}
          onClick={() => void begin()}
        >
          {busy ? "Starting…" : "Start PR review"}
        </Button>
        {active ? (
          <Button size="xs" variant="outline" onClick={() => void stop()}>
            Cancel
          </Button>
        ) : run ? (
          <Button size="xs" variant="outline" onClick={() => void refresh()}>
            Refresh status
          </Button>
        ) : null}
      </div>
      {!supported ? (
        <p>This server does not support monolith reviews.</p>
      ) : !permission ? (
        <p>This connection cannot run project checks.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {added ? <p role="status">Added {added} to the chat draft. Nothing has been sent.</p> : null}
      {run ? (
        <>
          <div role="status" className="space-y-1">
            <p className="font-medium">
              {run.status} · {run.coverage.checkedFiles}/{run.coverage.totalFiles} files checked
            </p>
            <p className="break-all text-muted-foreground">
              {run.baseRef} · base {run.baseCommit.slice(0, 8)} · HEAD {run.headCommit.slice(0, 8)}
              {run.includeWorkingTree ? " · includes working tree" : " · committed changes"}
            </p>
            <p className="text-muted-foreground">
              Snapshot: {run.createdAt} · Updated: {run.updatedAt}
            </p>
            <p className="text-muted-foreground">
              Captured review. Run again after later edits or branch changes; opening a file shows
              its current contents.
            </p>
            {run.message ? <p>{run.message}</p> : null}
            {run.coverage.omittedFiles || run.coverage.truncatedPatches ? (
              <p className="text-warning">
                {run.coverage.omittedFiles} omitted files · {run.coverage.truncatedPatches}{" "}
                truncated patches
              </p>
            ) : null}
          </div>
          {run.groups.map((group) => (
            <section
              key={group.areaId ?? "other"}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {group.name} · {group.files.length} files
                </span>
                {group.aiPackage ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canUseMonolithReviewPackage(run) || !group.aiPackage.text.trim()}
                    onClick={() => void addPackage(group.areaId)}
                  >
                    Add review to chat
                  </Button>
                ) : null}
              </div>
              {[...new Set(group.aiPackage?.omissions)].map((omission) => (
                <p key={omission} className="text-warning">
                  {omission}
                </p>
              ))}
              {group.aiPackage ? (
                <ReviewDisclosure
                  summary={
                    <span className="text-muted-foreground">
                      Review package {group.aiPackage.complete ? "" : "(partial)"}
                    </span>
                  }
                >
                  {() => (
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">
                      {group.aiPackage?.text}
                    </pre>
                  )}
                </ReviewDisclosure>
              ) : null}
              {group.files.map((file) => (
                <ReviewDisclosure
                  key={file.path}
                  className="border-t border-border pt-2"
                  summary={
                    <>
                      {file.status} · {file.path} · {file.checkStatus}
                      {file.patchTruncated ? " · truncated patch" : ""}
                    </>
                  }
                >
                  {() => (
                    <div className="mt-2 space-y-2">
                      {file.checksTruncated ? (
                        <p className="text-warning">
                          Some check details were omitted from this snapshot.
                        </p>
                      ) : null}
                      {file.oldPath ? <p>Previously {file.oldPath}</p> : null}
                      {file.message ? <p>{file.message}</p> : null}
                      {file.status !== "deleted" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            useRightPanelStore.getState().openFile(threadRef, file.path)
                          }
                        >
                          Open current file
                        </Button>
                      ) : null}
                      {file.checks?.runs.map((check) => (
                        <p key={`${check.tool}:${check.operation}`}>
                          {check.tool} {check.operation}: {check.status}
                          {check.message ? ` — ${check.message}` : ""}
                        </p>
                      ))}
                      {[
                        ...new Map(
                          file.checks?.diagnostics.map((diagnostic) => [
                            JSON.stringify(diagnostic),
                            diagnostic,
                          ]) ?? [],
                        ).entries(),
                      ].map(([diagnosticKey, diagnostic]) => (
                        <p
                          key={diagnosticKey}
                          className={
                            diagnostic.severity === "error"
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          <button
                            type="button"
                            aria-label={`Open current ${diagnostic.path} at reported snapshot line ${diagnostic.line ?? 1}`}
                            className="text-left underline"
                            onClick={() =>
                              useRightPanelStore
                                .getState()
                                .openFile(threadRef, diagnostic.path, diagnostic.line)
                            }
                          >
                            {diagnostic.severity} · {diagnostic.ruleId}
                            {diagnostic.line ? `:${diagnostic.line}` : ""}
                          </button>{" "}
                          — {diagnostic.message}
                        </p>
                      ))}
                      {file.checks?.queryBudget ? (
                        <p>
                          Doctrine queries: {file.checks.queryBudget.status}
                          {file.checks.queryBudget.message
                            ? ` — ${file.checks.queryBudget.message}`
                            : ""}{" "}
                          · {file.checks.queryBudget.methods.length} methods
                        </p>
                      ) : null}
                      {file.checks?.entryChains ? (
                        <p>
                          Entry callers: {file.checks.entryChains.status}
                          {file.checks.entryChains.message
                            ? ` — ${file.checks.entryChains.message}`
                            : ""}
                        </p>
                      ) : null}
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono">
                        {file.patch || "No text patch available."}
                      </pre>
                    </div>
                  )}
                </ReviewDisclosure>
              ))}
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}
