import type { PhpCommentAnnotation as Annotation } from "./phpCommentAnnotations";
import { cn } from "~/lib/utils";

export function PhpCommentAnnotation({
  comments,
  onOpenFile,
}: {
  readonly comments: readonly Annotation[];
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined;
}) {
  return (
    <div className="space-y-1 py-1">
      {comments.map(({ site }) =>
        site.annotations.map((annotation) => (
          <div
            key={JSON.stringify([site.targetSymbol, site.kind, site.column, annotation])}
            className={cn(
              "border-l-2 bg-muted/40 px-3 py-1.5 text-xs whitespace-pre-wrap",
              annotation.severity === "error"
                ? "border-destructive"
                : annotation.severity === "warning"
                  ? "border-warning"
                  : "border-info",
            )}
          >
            <div className="font-medium">
              {annotation.marker} · {site.targetSymbol}
            </div>
            <div>{annotation.message || annotation.marker}</div>
            <button
              type="button"
              className="mt-1 cursor-pointer text-muted-foreground underline"
              onClick={() => onOpenFile?.(annotation.path, annotation.line)}
              disabled={!onOpenFile}
            >
              Source: {annotation.path}:{annotation.line}
            </button>
          </div>
        )),
      )}
    </div>
  );
}
