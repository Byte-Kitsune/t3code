import type { MonolithCheckFileResult } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import type { useMonolithFileCheck } from "~/hooks/useMonolithFileCheck";
import {
  phpInsightSourceTarget,
  phpInsightStatusLabel,
  queryBudgetLabel,
} from "./phpInsightTargets";

type Source = {
  symbol: string;
  path: string;
  line?: number | undefined;
  serviceId?: string | undefined;
};
type OpenFile = (path: string, line?: number) => void;

function SourceLink({ source, onOpenFile }: { source: Source; onOpenFile: OpenFile }) {
  const target = phpInsightSourceTarget(source);
  const location = `${source.path}${source.line ? `:${source.line}` : ""}`;
  return target ? (
    <Button variant="link" size="micro" onClick={() => onOpenFile(target.path, target.line)}>
      {source.symbol}
      {source.serviceId ? ` (${source.serviceId})` : ""} · {location}
    </Button>
  ) : (
    <span>
      {source.symbol}
      {source.serviceId ? ` (${source.serviceId})` : ""} · {location}
    </span>
  );
}

function AnalysisStatus({
  insight,
}: {
  insight: {
    status: NonNullable<MonolithCheckFileResult["queryBudget"]>["status"];
    message?: string | undefined;
  };
}) {
  return (
    <p className="text-muted-foreground">
      {phpInsightStatusLabel(insight.status)}
      {insight.message ? ` — ${insight.message}` : ""}
    </p>
  );
}

export function PhpFileInsights({
  check,
  onOpenFile,
  onOpenSymbol,
  section,
}: {
  check: ReturnType<typeof useMonolithFileCheck>;
  section?: "queries" | "callers";
  onOpenFile: OpenFile;
  onOpenSymbol?: (
    target: NonNullable<MonolithCheckFileResult["entryChains"]>["targets"][number],
  ) => void;
}) {
  const queries = check.result?.queryBudget;
  const callers = check.result?.entryChains;
  const waiting = !check.canRun
    ? "PHP insights require permission to run project tools."
    : check.status === "unsaved"
      ? "PHP insights wait for the saved file."
      : check.status === "checking"
        ? "Analyzing queries and entry chains…"
        : check.status === "stale"
          ? "PHP insights are hidden while the saved source is refreshed."
          : check.status === "failed"
            ? "PHP insights failed."
            : null;
  const pending =
    waiting ??
    (!queries && !callers
      ? "Waiting for PHP analysis of the saved file."
      : section === "queries" && !queries
        ? "No Doctrine query result is available for this file."
        : section === "callers" && !callers
          ? "No entry-file or caller result is available for this file."
          : null);
  return (
    <div
      className={
        section
          ? "space-y-1 text-xs"
          : "max-h-64 shrink-0 overflow-auto border-b border-border/60 px-3 py-2 text-xs"
      }
      aria-label="PHP file insights"
    >
      {pending ? (
        <p role="status" className="text-muted-foreground">
          {pending}
        </p>
      ) : null}
      {queries && section !== "callers" ? (
        <div>
          {!section ? <h4 className="font-medium">Doctrine queries per method</h4> : null}
          <AnalysisStatus insight={queries} />
          <p className="text-muted-foreground">
            Static estimates per invocation; runtime behavior and input can change the count.
          </p>
          {queries.methods.length === 0 && queries.status === "complete" ? (
            <p>No method budgets were reported for this file.</p>
          ) : null}
          <ul className="mt-1 space-y-1">
            {queries.methods.map((method) => (
              <li key={`${method.symbol}:${method.line ?? ""}`}>
                <SourceLink source={method} onOpenFile={onOpenFile} /> —{" "}
                <span>{queryBudgetLabel(method)}</span>
                {method.unknown.length ? (
                  <p className="text-muted-foreground">Unresolved: {method.unknown.join("; ")}</p>
                ) : null}
                {method.cycles.length ? (
                  <p className="text-muted-foreground">
                    Recursive calls: {method.cycles.join("; ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {callers && section !== "queries" ? (
        <div className={section ? undefined : "mt-2"}>
          {!section ? <h4 className="font-medium">Entry files and callers</h4> : null}
          <AnalysisStatus insight={callers} />
          {onOpenSymbol ? (
            <p className="text-muted-foreground">
              Ctrl-click (⌘-click on Mac) a modeled class or method in the source to open its call
              graph.
            </p>
          ) : null}
          {callers.targets.length === 0 && callers.status === "complete" ? (
            <p>No symbols were reported for this file.</p>
          ) : null}
          {callers.targets.map((target) => (
            <details key={target.id ?? `${target.symbol}:${target.line ?? ""}`} className="mt-1">
              <summary className="cursor-pointer">
                {target.symbol}
                {target.serviceId ? ` (${target.serviceId})` : ""} — {target.entries.length} entry{" "}
                {target.entries.length === 1 ? "chain" : "chains"}
              </summary>
              {onOpenSymbol ? (
                <Button variant="link" size="micro" onClick={() => onOpenSymbol(target)}>
                  Open call graph for {target.symbol}
                </Button>
              ) : null}
              <p className="text-muted-foreground">Direct callers</p>
              {target.directCallers.length ? (
                <ul>
                  {target.directCallers.map((caller) => (
                    <li key={JSON.stringify(caller)}>
                      <SourceLink source={caller} onOpenFile={onOpenFile} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No direct callers found in the available graph.</p>
              )}
              <ul className="mt-1 space-y-1">
                {target.entries.map((entry) => (
                  <li key={JSON.stringify(entry)}>
                    <span className="text-muted-foreground">
                      {entry.evidence === "call"
                        ? "Call chain"
                        : "Service wiring (does not prove a method call)"}
                      {entry.complete ? "" : " · incomplete"}:{" "}
                    </span>
                    <SourceLink source={entry.entry} onOpenFile={onOpenFile} />
                    <ol className="ml-3 list-inside list-decimal">
                      {entry.chain.map((step, stepIndex) => (
                        <li key={JSON.stringify(entry.chain.slice(0, stepIndex + 1))}>
                          <SourceLink source={step} onOpenFile={onOpenFile} />
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
              {target.entries.length === 0 ? (
                <p>
                  No entry chain found in the available graph; this does not prove the symbol is
                  unused.
                </p>
              ) : null}
              {target.unknown.length ? (
                <p className="text-muted-foreground">Unresolved: {target.unknown.join("; ")}</p>
              ) : null}
              {target.cycles?.length ? (
                <p className="text-muted-foreground">
                  Recursive call paths: {target.cycles.join("; ")}
                </p>
              ) : null}
              {target.truncated ? (
                <p className="text-muted-foreground">
                  More paths exist; the displayed chains are limited.
                </p>
              ) : null}
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
}
