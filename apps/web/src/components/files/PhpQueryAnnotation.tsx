import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { queryBudgetLabel } from "./phpFileInsights";
import type { PhpQueryAnnotation as QueryAnnotation } from "./phpQueryAnnotations";

export function PhpQueryAnnotation({ methods }: { readonly methods: readonly QueryAnnotation[] }) {
  return (
    <div className="space-y-1 py-1">
      {methods.map(({ method, severity, thresholds, thresholdSource }) => (
        <div
          key={`${method.symbol}:${method.line}`}
          role="note"
          aria-label={`Doctrine query estimate for ${method.symbol}`}
          className={cn(
            "border-l-2 px-3 py-2 text-xs whitespace-normal",
            severity === "error"
              ? "border-destructive bg-destructive/10"
              : severity === "warning"
                ? "border-warning bg-warning/10"
                : "border-primary/50 bg-primary/5",
          )}
        >
          <span className="font-medium">Doctrine · {queryBudgetLabel(method)}</span>
          <span className="ml-2 text-muted-foreground">{severity}</span>
          <p className="mt-0.5 text-muted-foreground">
            Static estimate per invocation of {method.symbol}.
            {thresholds ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="ml-2 cursor-help"
                      aria-label={`Query thresholds: warning from ${thresholds.warning}, error from ${thresholds.error}. ${thresholdSource?.kind === "extension" ? "Extension configuration" : thresholdSource?.kind === "override" ? "T3 area override" : "Default thresholds"}${thresholdSource?.path ? `: ${thresholdSource.path}` : ""}`}
                    />
                  }
                >
                  ⓘ
                </TooltipTrigger>
                <TooltipPopup>
                  Warning from {thresholds.warning}, error from {thresholds.error}.{" "}
                  {thresholdSource?.kind === "extension"
                    ? "Extension configuration"
                    : thresholdSource?.kind === "override"
                      ? "T3 area override"
                      : "Default thresholds"}
                  {thresholdSource?.path ? `: ${thresholdSource.path}` : ""}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </p>
          {thresholdSource?.kind === "unresolved" ? (
            <p className="mt-0.5 text-warning">
              Query thresholds could not be resolved. This warning does not classify the query
              count.{thresholdSource.path ? ` Configuration: ${thresholdSource.path}.` : ""}
            </p>
          ) : null}
          {method.unknown.length || method.cycles.length ? (
            <details className="mt-1">
              <summary className="w-fit cursor-pointer">Incomplete analysis</summary>
              {method.unknown.length ? <p>Unresolved: {method.unknown.join("; ")}</p> : null}
              {method.cycles.length ? <p>Recursive calls: {method.cycles.join("; ")}</p> : null}
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}
