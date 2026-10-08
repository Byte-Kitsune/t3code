import { useState, type ComponentProps } from "react";
import { FileAnalyzerStatus } from "./FileAnalyzerStatus";
import { PhpFileInsights } from "./PhpFileInsights";

export function FileAnalysisFooter({
  check,
  php,
  onOpenFile,
  onOpenSymbol,
}: ComponentProps<typeof PhpFileInsights> & { readonly php: boolean }) {
  const [insightsOpen, setInsightsOpen] = useState(false);
  return (
    <div className="shrink-0" aria-label="File analysis details">
      <FileAnalyzerStatus check={check} />
      {php ? (
        <details
          className="border-t border-border/60 text-xs text-muted-foreground"
          onToggle={(event) => setInsightsOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer px-3 py-1.5">PHP insights</summary>
          {insightsOpen ? (
            <PhpFileInsights
              check={check}
              onOpenFile={onOpenFile}
              {...(onOpenSymbol ? { onOpenSymbol } : {})}
            />
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
