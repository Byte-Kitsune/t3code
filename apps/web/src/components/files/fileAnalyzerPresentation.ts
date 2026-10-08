import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";

const ESLINT_STYLE_RULES = new Set([
  "indent",
  "quotes",
  "semi",
  "comma-dangle",
  "comma-spacing",
  "comma-style",
  "brace-style",
  "object-curly-spacing",
  "array-bracket-spacing",
  "key-spacing",
  "keyword-spacing",
  "space-infix-ops",
  "space-before-blocks",
  "space-before-function-paren",
  "no-trailing-spaces",
  "eol-last",
  "linebreak-style",
  "max-len",
  "padding-line-between-statements",
]);

/** Presentation only: original severity and evidence remain available to checks and reviews. */
export function isFormattingAnalyzerDiagnostic(finding: MonolithAnalyzerDiagnostic): boolean {
  return (
    finding.operation === "format" ||
    (finding.tool === "biome" &&
      (finding.ruleId === "format" || finding.ruleId.startsWith("format/"))) ||
    (finding.tool === "eslint" &&
      (finding.ruleId === "prettier/prettier" ||
        finding.ruleId.startsWith("@stylistic/") ||
        ESLINT_STYLE_RULES.has(finding.ruleId)))
  );
}

export function isGutterOnlyAnalyzerDiagnostic(finding: MonolithAnalyzerDiagnostic): boolean {
  return (
    finding.line !== undefined &&
    Number.isInteger(finding.line) &&
    finding.line >= 1 &&
    (finding.severity === "info" || isFormattingAnalyzerDiagnostic(finding))
  );
}
