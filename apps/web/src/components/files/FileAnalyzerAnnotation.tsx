import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";
import { cn } from "~/lib/utils";

export function FileAnalyzerAnnotation({
  diagnostics,
}: {
  readonly diagnostics: readonly MonolithAnalyzerDiagnostic[];
}) {
  return (
    <div className="space-y-1 py-1">
      {diagnostics.map((diagnostic) =>
        diagnostic.severity === "info" ? (
          <details key={JSON.stringify(diagnostic)} className="text-xs whitespace-normal">
            <summary
              className="w-fit cursor-pointer px-2 py-0.5"
              aria-label={`Help: ${diagnostic.ruleId}`}
            >
              <span role="img" aria-label="Information" className="text-muted-foreground">
                ⓘ
              </span>
            </summary>
            <div className="px-3 pb-1">
              <span>{diagnostic.message}</span>
              <div className="mt-1 text-muted-foreground">
                {diagnostic.tool} · {diagnostic.operation} · {diagnostic.severity} ·{" "}
                {diagnostic.ruleId}
                {diagnostic.line === undefined
                  ? " · File"
                  : ` · L${diagnostic.line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`}
              </div>
            </div>
          </details>
        ) : (
          <div
            key={JSON.stringify(diagnostic)}
            className={cn(
              "border-l-2 bg-muted/40 px-3 py-2 text-xs whitespace-normal",
              diagnostic.severity === "error" ? "border-destructive" : "border-warning",
            )}
          >
            <span className="font-medium">{diagnostic.message}</span>
            <div className="mt-1 text-muted-foreground">
              {diagnostic.tool} · {diagnostic.operation} · {diagnostic.severity} ·{" "}
              {diagnostic.ruleId}
              {diagnostic.line === undefined
                ? " · File"
                : ` · L${diagnostic.line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
