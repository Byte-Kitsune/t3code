import { useState, type ComponentProps, type ReactNode } from "react";
import { PhpFileInsights } from "./PhpFileInsights";

type Props = ComponentProps<typeof PhpFileInsights> & { readonly loading?: boolean };

function AnalysisSection({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="border-b border-border/60"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium">{label}</summary>
      {expanded ? <div className="max-h-64 overflow-auto px-3 pb-2 text-xs">{children}</div> : null}
    </details>
  );
}

function MagoChecks({ check, loading }: Pick<Props, "check" | "loading">) {
  const waiting = loading
    ? "Loading file…"
    : !check.canRun
      ? "Tool setup and permissions are shown below the file."
      : check.status === "unsaved"
        ? "Checks wait for the saved file."
        : check.status === "checking"
          ? "Checking saved file…"
          : check.status === "stale"
            ? "Refreshing saved file before showing findings…"
            : check.status === "failed"
              ? "Checks failed. Execution details are shown below the file."
              : !check.result
                ? "Waiting for checks of the saved file."
                : null;
  if (waiting)
    return (
      <p className="text-muted-foreground" role="status">
        {waiting}
      </p>
    );
  const runs =
    check.result?.runs.filter((run) => run.tool === "mago" && run.status !== "unavailable") ?? [];
  return runs.length ? (
    <ul className="space-y-1">
      {runs.map((run) => (
        <li key={run.operation}>
          <span className="font-medium">{run.operation}</span>:{" "}
          {run.status === "findings" ? `${run.diagnosticCount} findings` : run.status}
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-muted-foreground">
      No Mago check result is available. Tool setup is shown below the file.
    </p>
  );
}

export function FileAnalysisHeader({ loading = false, ...props }: Props) {
  return (
    <div className="shrink-0" aria-label="PHP file analysis">
      <AnalysisSection label="Mago checks">
        <MagoChecks check={props.check} loading={loading} />
      </AnalysisSection>
      <AnalysisSection label="Entry files and callers">
        {loading ? (
          <p className="text-muted-foreground" role="status">
            Loading file…
          </p>
        ) : (
          <PhpFileInsights {...props} section="callers" />
        )}
      </AnalysisSection>
    </div>
  );
}
