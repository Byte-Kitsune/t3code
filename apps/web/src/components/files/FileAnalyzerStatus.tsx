import type { useMonolithFileCheck } from "~/hooks/useMonolithFileCheck";

export function FileAnalyzerStatus({
  check,
}: {
  readonly check: ReturnType<typeof useMonolithFileCheck>;
}) {
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
            : check.result
              ? check.result.runs.length === 0
                ? "No analyzer is available for this file."
                : null
              : null;
  return text || check.result ? (
    <div
      className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
      role="status"
    >
      {text ? <span>{text}</span> : null}
      {check.result?.runs.map((run) => (
        <span key={`${run.tool}:${run.operation}`}>
          {run.tool} {run.operation}:{" "}
          {run.status === "findings" ? `${run.diagnosticCount} findings` : run.status}
          {run.message ? ` — ${run.message}` : ""}
        </span>
      ))}
    </div>
  ) : null;
}
