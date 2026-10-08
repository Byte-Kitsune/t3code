import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ComponentProps } from "react";
import { FileAnalysisHeader } from "./FileAnalysisHeader";

type Check = ComponentProps<typeof FileAnalysisHeader>["check"];
const initial: Check = {
  supported: false,
  canRun: false,
  status: "idle",
  result: null,
  error: null,
  diagnostics: [],
};

describe("FileAnalysisHeader", () => {
  it.each([
    initial,
    { ...initial, supported: true, canRun: true, status: "checking" as const },
    {
      ...initial,
      supported: true,
      canRun: true,
      status: "checked" as const,
      result: {
        areaId: "api",
        revision: "1",
        diagnostics: [],
        runs: [
          {
            tool: "mago" as const,
            operation: "guard" as const,
            status: "unavailable" as const,
            diagnosticCount: 0,
            message: "Secret setup detail",
          },
        ],
      },
    },
  ])(
    "keeps two stable collapsed rows before and after analysis without mounting details",
    (check) => {
      const html = renderToStaticMarkup(
        <FileAnalysisHeader check={check} onOpenFile={() => {}} loading={check.result === null} />,
      );
      expect(
        [...html.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map((match) => match[1]),
      ).toEqual(["Mago checks", "Entry files and callers"]);
      expect(html.match(/<details/g)).toHaveLength(2);
      expect(html).not.toMatch(/<details[^>]*\bopen/);
      expect(html).not.toContain("Secret setup detail");
      expect(html).not.toContain("Loading file");
      expect(html).not.toContain("PHP file insights");
    },
  );
});
