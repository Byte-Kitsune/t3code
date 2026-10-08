import type { useMonolithFileCheck } from "~/hooks/useMonolithFileCheck";
import { fileCheckSummary } from "./fileAnalyzerStatusHelpers";
import { phpInsightStatusLabel } from "./phpInsightTargets";

export function FileAnalyzerStatus({
  check,
}: {
  readonly check: ReturnType<typeof useMonolithFileCheck>;
}) {
  const summary = fileCheckSummary(check);
  if (summary === null) return null;
  const text = !check.canRun
    ? "File checks require permission to run project tools."
    : check.status === "unsaved"
      ? "File checks wait for the saved file."
      : check.status === "checking"
        ? "Checking saved file…"
        : check.status === "failed"
          ? "File checks failed."
          : check.status === "stale"
            ? "File changed during checks. Findings are hidden until the saved file is refreshed."
            : check.result?.runs.length === 0
              ? "No analyzer is available for this file."
              : null;
  return (
    <details className="shrink-0 border-t border-border/60 text-xs text-muted-foreground">
      <summary className="cursor-pointer overflow-hidden px-3 py-1.5 text-ellipsis whitespace-nowrap">
        <span className="font-medium">File checks</span>
        <span role="status" className="ml-2">
          {summary}
        </span>
      </summary>
      <div className="max-h-40 space-y-1 overflow-auto px-3 pb-2">
        {text ? <p>{text}</p> : null}
        {check.result?.runs.map((run) => (
          <p key={`${run.tool}:${run.operation}`}>
            {run.tool} {run.operation}:{" "}
            {run.status === "findings" ? `${run.diagnosticCount} findings` : run.status}
            {run.message ? ` — ${run.message}` : ""}
          </p>
        ))}
        {check.status === "checked" && check.result?.queryBudget ? (
          <p>
            Doctrine queries: {phpInsightStatusLabel(check.result.queryBudget.status)}
            {check.result.queryBudget.message ? ` — ${check.result.queryBudget.message}` : ""}
          </p>
        ) : null}
      </div>
    </details>
  );
}
