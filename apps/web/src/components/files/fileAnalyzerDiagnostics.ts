import type { PhpQueryAnnotation } from "./phpQueryAnnotations";
import type { PhpCommentAnnotation } from "./phpCommentAnnotations";
import { sha256 } from "@noble/hashes/sha2";
import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";
import type { LineAnnotation } from "@pierre/diffs";
import type {
  FileCommentAnnotationGroup,
  FileCommentLineAnnotation,
} from "./fileCommentAnnotations";

export function analyzerContentRevision(contents: string): string {
  return [...sha256(new TextEncoder().encode(contents))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function fileAnalyzerDiagnostics(
  diagnostics: readonly MonolithAnalyzerDiagnostic[],
  path: string,
  contents: string,
): readonly MonolithAnalyzerDiagnostic[] {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const lineCount = contents.split(/\r\n|\r|\n/).length;
  // Do not clamp a finding from another file or an older source onto an unrelated row.
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.path.replaceAll("\\", "/").replace(/^\.\//, "") === normalizedPath &&
      (diagnostic.line === undefined ||
        (Number.isInteger(diagnostic.line) &&
          diagnostic.line >= 1 &&
          diagnostic.line <= lineCount)),
  );
}

export interface FileAnalyzerAnnotationGroup extends FileCommentAnnotationGroup {
  diagnostics?: readonly MonolithAnalyzerDiagnostic[];
  queries?: readonly PhpQueryAnnotation[];
  devComments?: readonly PhpCommentAnnotation[];
}

export function mergeFileAnalyzerAnnotations(
  comments: readonly FileCommentLineAnnotation[],
  diagnostics: readonly MonolithAnalyzerDiagnostic[],
  queries: readonly PhpQueryAnnotation[] = [],
  devComments: readonly PhpCommentAnnotation[] = [],
): LineAnnotation<FileAnalyzerAnnotationGroup>[] {
  const byLine = new Map<number, LineAnnotation<FileAnalyzerAnnotationGroup>>();
  for (const comment of comments) byLine.set(comment.lineNumber, { ...comment });
  for (const diagnostic of diagnostics) {
    if (diagnostic.line === undefined || !Number.isInteger(diagnostic.line) || diagnostic.line < 1)
      continue;
    const current = byLine.get(diagnostic.line);
    byLine.set(diagnostic.line, {
      lineNumber: diagnostic.line,
      metadata: {
        ...current?.metadata,
        entries: current?.metadata.entries ?? [],
        diagnostics: [...(current?.metadata.diagnostics ?? []), diagnostic],
      },
    });
  }
  for (const query of queries) {
    const current = byLine.get(query.lineNumber);
    byLine.set(query.lineNumber, {
      lineNumber: query.lineNumber,
      metadata: {
        ...current?.metadata,
        entries: current?.metadata.entries ?? [],
        queries: [...(current?.metadata.queries ?? []), query],
      },
    });
  }
  for (const comment of devComments) {
    const current = byLine.get(comment.lineNumber);
    byLine.set(comment.lineNumber, {
      lineNumber: comment.lineNumber,
      metadata: {
        ...current?.metadata,
        entries: current?.metadata.entries ?? [],
        devComments: [...(current?.metadata.devComments ?? []), comment],
      },
    });
  }
  return [...byLine.values()].sort((left, right) => left.lineNumber - right.lineNumber);
}
