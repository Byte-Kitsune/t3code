import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";
import { cn } from "~/lib/utils";

export function FileAnalyzerAnnotation({
  diagnostics,
}: {
  readonly diagnostics: readonly MonolithAnalyzerDiagnostic[];
}) {
  return (
    <div className="space-y-1 py-1">
      {diagnostics.map((diagnostic) => (
        <div
          key={JSON.stringify(diagnostic)}
          className={cn(
            "border-l-2 bg-muted/40 px-3 py-2 text-xs whitespace-normal",
            diagnostic.severity === "error"
              ? "border-destructive"
              : diagnostic.severity === "warning"
                ? "border-warning"
                : "border-muted-foreground",
          )}
        >
          <span className="font-medium">{diagnostic.message}</span>
          <div className="mt-1 text-muted-foreground">
            {diagnostic.tool} · {diagnostic.operation} · {diagnostic.severity} · {diagnostic.ruleId}{" "}
            · L{diagnostic.line}:{diagnostic.column}
          </div>
        </div>
      ))}
    </div>
  );
}
