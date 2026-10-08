import type { MonolithAnnotationSite } from "@t3tools/contracts";

const encoder = new TextEncoder();
const lineCache = new Map<string, string[]>();
function sourceLines(contents: string): string[] {
  const cached = lineCache.get(contents);
  if (cached) return cached;
  const lines = contents.split(/\r\n|\r|\n/);
  if (lineCache.size >= 2) lineCache.delete(lineCache.keys().next().value!);
  lineCache.set(contents, lines);
  return lines;
}

export type PhpCommentAnnotation = {
  readonly lineNumber: number;
  readonly site: MonolithAnnotationSite;
};

export function buildPhpCommentAnnotations(
  path: string,
  contents: string,
  sites: readonly MonolithAnnotationSite[],
): readonly PhpCommentAnnotation[] {
  const lines = sourceLines(contents);
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return sites
    .filter(
      (site) =>
        site.path === normalized &&
        site.annotations.length > 0 &&
        site.line >= 1 &&
        site.line <= lines.length &&
        site.endLine >= site.line &&
        site.endLine <= lines.length,
    )
    .map((site) => ({ lineNumber: site.line - 1, site }));
}

const ATTRIBUTE = "data-t3-comment-severity";
const STYLE = "data-t3-comment-style";
const rank = { reference: 0, info: 1, warning: 2, error: 3 } as const;

/** Mago columns are UTF-8 bytes; Pierre token offsets are UTF-16 code units. */
export function byteColumnToUtf16(line: string, column: number): number | null {
  let bytes = 1;
  let offset = 0;
  for (const character of line) {
    if (bytes === column) return offset;
    bytes += encoder.encode(character).length;
    offset += character.length;
    if (bytes > column) return null;
  }
  return bytes === column ? offset : null;
}

/** Decorate existing tokens without replacing editable DOM or native event handlers. */
export function syncPhpCommentHighlights(
  container: HTMLElement,
  contents: string,
  annotations: readonly PhpCommentAnnotation[],
): void {
  const surface = container.shadowRoot ?? container;
  for (const token of surface.querySelectorAll(`[${ATTRIBUTE}]`)) token.removeAttribute(ATTRIBUTE);
  if (!annotations.length) {
    surface.querySelector(`[${STYLE}]`)?.remove();
    return;
  }
  if (!surface.querySelector(`[${STYLE}]`)) {
    const style = container.ownerDocument.createElement("style");
    style.setAttribute(STYLE, "");
    style.textContent = `
[data-t3-comment-severity] { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
[data-t3-comment-severity="info"], [data-t3-comment-severity="reference"] { text-decoration-color: var(--diffs-modified-base); background-color: color-mix(in srgb, var(--diffs-modified-base) 12%, transparent); }
[data-t3-comment-severity="warning"] { text-decoration-color: light-dark(var(--diffs-warning-light),var(--diffs-warning-dark)); background-color: color-mix(in srgb, light-dark(var(--diffs-warning-light),var(--diffs-warning-dark)) 12%, transparent); }
[data-t3-comment-severity="error"] { text-decoration-color: var(--diffs-deletion-base); background-color: color-mix(in srgb, var(--diffs-deletion-base) 12%, transparent); }
`;
    surface.append(style);
  }
  const lines = sourceLines(contents);
  const byLine = new Map<number, PhpCommentAnnotation[]>();
  for (const annotation of annotations)
    for (let line = annotation.site.line; line <= annotation.site.endLine; line++) {
      const current = byLine.get(line) ?? [];
      current.push(annotation);
      byLine.set(line, current);
    }
  for (const row of surface.querySelectorAll<HTMLElement>("[data-line]")) {
    const lineNumber = Number(row.getAttribute("data-line"));
    const sites = byLine.get(lineNumber);
    const text = lines[lineNumber - 1];
    if (!sites || text === undefined) continue;
    for (const token of row.querySelectorAll<HTMLElement>("[data-char]")) {
      const start = Number(token.getAttribute("data-char"));
      const end = start + (token.textContent?.length ?? 0);
      let severity: keyof typeof rank | null = null;
      for (const { site } of sites) {
        const from = lineNumber === site.line ? byteColumnToUtf16(text, site.column) : 0;
        const to =
          lineNumber === site.endLine ? byteColumnToUtf16(text, site.endColumn) : text.length;
        if (from === null || to === null || start >= to || end <= from) continue;
        for (const annotation of site.annotations)
          if (severity === null || rank[annotation.severity] > rank[severity])
            severity = annotation.severity;
      }
      if (severity) token.setAttribute(ATTRIBUTE, severity);
    }
  }
}
