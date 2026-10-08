// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";
import { syncFileAnalyzerGutter } from "./fileAnalyzerGutter";
import { FileAnalyzerAnnotation } from "./FileAnalyzerAnnotation";

function diagnostic(
  line: number,
  severity: MonolithAnalyzerDiagnostic["severity"],
): MonolithAnalyzerDiagnostic {
  return {
    tool: "mago",
    operation: "analyze",
    path: "src/Demo.php",
    severity,
    ruleId: "test-rule",
    message: "Unexpected nullable call",
    line,
    column: 4,
  };
}
describe("file analyzer line gutter", () => {
  it("uses the strongest severity and preserves native line numbers and gutter clicks", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<div data-column-number="3" title="existing"><span data-line-number-content>3</span></div>';
    const row = shadow.querySelector<HTMLElement>("[data-column-number]")!;
    const click = vi.fn();
    row.addEventListener("click", click);
    syncFileAnalyzerGutter(host, [
      diagnostic(3, "warning"),
      diagnostic(3, "error"),
      diagnostic(3, "info"),
    ]);
    expect(row.getAttribute("data-t3-analyzer-severity")).toBe("error");
    expect(row.textContent).toBe("3");
    expect(row.title).toBe("existing");
    row.click();
    expect(click).toHaveBeenCalledOnce();
    expect(shadow.querySelectorAll("style")).toHaveLength(1);
    syncFileAnalyzerGutter(host, [diagnostic(3, "info")]);
    expect(row.getAttribute("data-t3-analyzer-severity")).toBe("info");
    expect(shadow.querySelectorAll("style")).toHaveLength(1);
  });
  it("removes stale markers on reused virtual rows and marks newly rendered rows", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div data-column-number="3"></div>';
    const row = shadow.querySelector("div")!;
    syncFileAnalyzerGutter(host, [diagnostic(3, "error"), diagnostic(90, "warning")]);
    row.setAttribute("data-column-number", "90");
    syncFileAnalyzerGutter(host, [diagnostic(3, "error"), diagnostic(90, "warning")]);
    expect(row.getAttribute("data-t3-analyzer-severity")).toBe("warning");
    shadow.innerHTML = '<div data-column-number="3"></div>';
    syncFileAnalyzerGutter(host, [diagnostic(3, "error")]);
    expect(shadow.querySelector("div")?.getAttribute("data-t3-analyzer-severity")).toBe("error");
    syncFileAnalyzerGutter(host, []);
    expect(shadow.querySelector("[data-t3-analyzer-severity]")).toBeNull();
    expect(shadow.querySelector("style")).toBeNull();
  });
  it("keeps errors and warnings expanded while only help has an icon disclosure", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <FileAnalyzerAnnotation
            diagnostics={[diagnostic(3, "error"), diagnostic(3, "warning"), diagnostic(3, "info")]}
          />,
        ),
      );
      const disclosure = container.querySelector("details")!;
      expect(disclosure.open).toBe(false);
      expect(container.querySelectorAll("details")).toHaveLength(1);
      expect(container.querySelectorAll(".font-medium")).toHaveLength(2);
      expect(container.querySelector(".border-destructive")?.textContent).toContain("test-rule");
      expect(container.querySelector(".border-warning")?.textContent).toContain("test-rule");
      expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
        "Information",
      );
      expect(container.querySelector("summary")?.textContent).not.toContain(
        "Unexpected nullable call",
      );
      expect(container.querySelector("summary")?.textContent).not.toContain("test-rule");
      disclosure.open = true;
      expect(disclosure.textContent).toContain("Unexpected nullable call");
      expect(disclosure.textContent).toContain("test-rule · L3:4");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

it("does not mark a gutter row for dependency-cruiser findings without line information", () => {
  const host = document.createElement("div");
  host.innerHTML = '<div data-column-number="1">1</div>';
  syncFileAnalyzerGutter(host, [
    {
      tool: "depcruise",
      operation: "check",
      path: "app/source.ts",
      severity: "error",
      ruleId: "architecture",
      message: "Forbidden dependency",
    },
  ]);
  expect(host.querySelector("[data-t3-analyzer-severity]")).toBeNull();
});
