// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { PhpQueryAnnotation } from "./PhpQueryAnnotation";
import { buildPhpQueryAnnotations } from "./phpQueryAnnotations";

describe("inline Doctrine query boxes", () => {
  it("shows threshold provenance and replaces guessed count colors with an unresolved-configuration warning", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const input = {
      path: "src/Query.php",
      lineCount: 20,
      methods: [
        {
          symbol: "App\\Query::load",
          path: "src/Query.php",
          line: 8,
          lowerBound: 40,
          upperBound: 40,
          unknown: [],
          cycles: [],
        },
      ],
    };
    try {
      await act(async () =>
        root.render(
          <PhpQueryAnnotation
            methods={buildPhpQueryAnnotations({
              ...input,
              thresholds: { warning: 10, error: 25 },
              thresholdSource: { kind: "extension", path: ".mago/extension.php" },
            })}
          />,
        ),
      );
      expect(host.querySelector("button")?.getAttribute("aria-label")).toContain(
        "Query thresholds: warning from 10, error from 25. Extension configuration: .mago/extension.php",
      );
      expect(host.querySelector('[role="note"]')?.textContent).toContain("error");
      await act(async () =>
        root.render(
          <PhpQueryAnnotation
            methods={buildPhpQueryAnnotations({
              ...input,
              thresholdSource: { kind: "unresolved", path: ".mago/extension.php" },
            })}
          />,
        ),
      );
      expect(host.querySelector('[role="note"]')?.textContent).toContain("warning");
      expect(host.querySelector('[role="note"]')?.textContent).toContain(
        "does not classify the query count",
      );
      expect(host.querySelector("button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
  it("shows estimates directly while uncertainty details expand independently", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <PhpQueryAnnotation
            methods={buildPhpQueryAnnotations({
              path: "src/Query.php",
              lineCount: 20,
              methods: [
                {
                  symbol: "App\\Query::load",
                  path: "src/Query.php",
                  line: 8,
                  lowerBound: 2,
                  upperBound: null,
                  unknown: ["dynamic receiver"],
                  cycles: [],
                },
              ],
            })}
          />,
        ),
      );
      const note = host.querySelector('[role="note"]')!;
      expect(note.textContent).toContain("At least 2 queries; upper bound unknown");
      expect(note.textContent).toContain("warning");
      const details = note.querySelector("details")!;
      expect(details.open).toBe(false);
      expect(note.querySelector("summary")?.textContent).toBe("Incomplete analysis");
      details.open = true;
      expect(details.textContent).toContain("dynamic receiver");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
