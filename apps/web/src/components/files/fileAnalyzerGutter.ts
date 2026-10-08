import { isGutterOnlyAnalyzerDiagnostic } from "./fileAnalyzerPresentation";
import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";

const SEVERITY_ATTRIBUTE = "data-t3-analyzer-severity";
const STYLE_ATTRIBUTE = "data-t3-analyzer-gutter-style";
const STYLES = `
[data-column-number][data-t3-analyzer-severity] { position: relative; }
[data-t3-analyzer-marker] { position: absolute; left: 2px; top: 0; width: 10px;
  font-size: 10px; text-align: center; pointer-events: auto;
  color: var(--diffs-modified-base);
}
[data-column-number][data-t3-analyzer-severity="error"] [data-t3-analyzer-marker] { color: var(--diffs-deletion-base); }
[data-column-number][data-t3-analyzer-severity="warning"] [data-t3-analyzer-marker] { color: light-dark(var(--diffs-warning-light),var(--diffs-warning-dark)); }
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
  for (const marker of surface.querySelectorAll("[data-t3-analyzer-marker]")) marker.remove();
  const messagesByLine = new Map<number, string[]>();
  const severityByLine = new Map<number, MonolithAnalyzerDiagnostic["severity"]>();
  for (const finding of diagnostics) {
    if (finding.line === undefined || !Number.isInteger(finding.line) || finding.line < 1) continue;
    const severity = isGutterOnlyAnalyzerDiagnostic(finding) ? "info" : finding.severity;
    const messages = messagesByLine.get(finding.line) ?? [];
    messages.push(`${finding.tool} · ${finding.ruleId}: ${finding.message}`);
    messagesByLine.set(finding.line, messages);
    const current = severityByLine.get(finding.line);
    if (!current || severityOrder[severity] > severityOrder[current])
      severityByLine.set(finding.line, severity);
  }
  if (!severityByLine.size) {
    surface.querySelector(`[${STYLE_ATTRIBUTE}]`)?.remove();
    return;
  }
  const existingStyle = surface.querySelector(`[${STYLE_ATTRIBUTE}]`);
  if (existingStyle) {
    if (existingStyle.textContent !== STYLES) existingStyle.textContent = STYLES;
  } else {
    const style = container.ownerDocument.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "");
    style.textContent = STYLES;
    surface.append(style);
  }
  for (const row of surface.querySelectorAll("[data-column-number]")) {
    const severity = severityByLine.get(Number(row.getAttribute("data-column-number")));
    if (severity) {
      row.setAttribute(SEVERITY_ATTRIBUTE, severity);
      const marker = container.ownerDocument.createElement("span");
      marker.setAttribute("data-t3-analyzer-marker", "");
      marker.setAttribute("role", "img");
      marker.title = messagesByLine.get(Number(row.getAttribute("data-column-number")))!.join("\n");
      marker.setAttribute("aria-label", marker.title);
      marker.textContent = severity === "info" ? "ⓘ" : severity === "warning" ? "▲" : "●";
      row.append(marker);
    }
  }
}
