import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";

const SEVERITY_ATTRIBUTE = "data-t3-analyzer-severity";
const STYLE_ATTRIBUTE = "data-t3-analyzer-gutter-style";
const STYLES = `
[data-column-number][data-t3-analyzer-severity] { position: relative; }
[data-column-number][data-t3-analyzer-severity]::before {
  content: '●'; position: absolute; left: 2px; top: 0; width: 10px;
  font-size: 10px; text-align: center; pointer-events: none;
  color: var(--diffs-modified-base);
}
[data-column-number][data-t3-analyzer-severity="error"]::before { color: var(--diffs-deletion-base); }
[data-column-number][data-t3-analyzer-severity="warning"]::before { content: '▲'; color: light-dark(var(--diffs-warning-light),var(--diffs-warning-dark)); }
`;
const severityOrder = { error: 3, warning: 2, info: 1 } as const;

/** Refresh after each Pierre render: virtualized rows may be replaced or reused. */
export function syncFileAnalyzerGutter(
  container: HTMLElement,
  diagnostics: readonly MonolithAnalyzerDiagnostic[],
): void {
  const surface = container.shadowRoot ?? container;
  for (const row of surface.querySelectorAll(`[${SEVERITY_ATTRIBUTE}]`))
    row.removeAttribute(SEVERITY_ATTRIBUTE);
  const severityByLine = new Map<number, MonolithAnalyzerDiagnostic["severity"]>();
  for (const finding of diagnostics) {
    if (finding.line === undefined || !Number.isInteger(finding.line) || finding.line < 1) continue;
    const current = severityByLine.get(finding.line);
    if (!current || severityOrder[finding.severity] > severityOrder[current])
      severityByLine.set(finding.line, finding.severity);
  }
  if (!severityByLine.size) {
    surface.querySelector(`[${STYLE_ATTRIBUTE}]`)?.remove();
    return;
  }
  if (!surface.querySelector(`[${STYLE_ATTRIBUTE}]`)) {
    const style = container.ownerDocument.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "");
    style.textContent = STYLES;
    surface.append(style);
  }
  for (const row of surface.querySelectorAll("[data-column-number]")) {
    const severity = severityByLine.get(Number(row.getAttribute("data-column-number")));
    if (severity) row.setAttribute(SEVERITY_ATTRIBUTE, severity);
  }
}
