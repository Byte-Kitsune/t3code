import { PhpQueryAnnotation } from "./PhpQueryAnnotation";
import { PhpCommentAnnotation } from "./PhpCommentAnnotation";
import type { PhpQueryAnnotation as QueryAnnotation } from "./phpQueryAnnotations";
import type { PhpCommentAnnotation as CommentAnnotation } from "./phpCommentAnnotations";
import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";
import {
  mergeFileAnalyzerAnnotations,
  type FileAnalyzerAnnotationGroup,
} from "./fileAnalyzerDiagnostics";
import { FileAnalyzerAnnotation } from "./FileAnalyzerAnnotation";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/**
 * Highlighted source for files that cannot be edited: captured attachments,
 * host files outside the workspace and truncated reads. Same surface theme,
 * word-wrap preference and virtualization as the editable workspace file.
 */
export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly queries?: readonly QueryAnnotation[];
  readonly devComments?: readonly CommentAnnotation[];
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined;
  readonly diagnostics?: readonly MonolithAnalyzerDiagnostic[];
  readonly onTokenClick?: FileOptions<FileAnalyzerAnnotationGroup, undefined>["onTokenClick"];
  readonly onPostRender?: FileOptions<FileAnalyzerAnnotationGroup, undefined>["onPostRender"];
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File<FileAnalyzerAnnotationGroup>
          lineAnnotations={mergeFileAnalyzerAnnotations(
            [],
            props.diagnostics ?? [],
            props.queries,
            props.devComments,
          )}
          renderAnnotation={(annotation) => (
            <>
              <FileAnalyzerAnnotation diagnostics={annotation.metadata.diagnostics ?? []} />
              <PhpQueryAnnotation methods={annotation.metadata.queries ?? []} />
              <PhpCommentAnnotation
                comments={annotation.metadata.devComments ?? []}
                onOpenFile={props.onOpenFile}
              />
            </>
          )}
          file={{
            name: props.name,
            contents: props.text,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            ...(props.onTokenClick ? { onTokenClick: props.onTokenClick } : {}),
            ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
