// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import type { MonolithAnnotationSite } from "@t3tools/contracts";
import {
  buildPhpCommentAnnotations,
  byteColumnToUtf16,
  syncPhpCommentHighlights,
} from "./phpCommentAnnotations";
const site: MonolithAnnotationSite = {
  symbol: "Caller::run",
  targetSymbol: "Old::run",
  kind: "call",
  path: "src/Test.php",
  line: 2,
  column: 6,
  endLine: 2,
  endColumn: 9,
  annotations: [
    {
      marker: "@deprecated",
      severity: "warning",
      message: "Use New::run",
      path: "src/Old.php",
      line: 3,
      column: 1,
    },
  ],
};
describe("PHP comment use sites", () => {
  it("places use hints above their source row and excludes other/stale source locations", () => {
    expect(
      buildPhpCommentAnnotations("src/Test.php", "<?php\n  $a->run();", [site]).map(
        (x) => x.lineNumber,
      ),
    ).toEqual([1]);
    expect(buildPhpCommentAnnotations("src/Test.php", "<?php", [site])).toEqual([]);
    expect(buildPhpCommentAnnotations("src/Other.php", "<?php\n  $a->run();", [site])).toEqual([]);
  });
  it("converts exact UTF8 byte boundaries to UTF16 without splitting unicode", () => {
    expect(byteColumnToUtf16("ä😀x", 1)).toBe(0);
    expect(byteColumnToUtf16("ä😀x", 3)).toBe(1);
    expect(byteColumnToUtf16("ä😀x", 7)).toBe(3);
    expect(byteColumnToUtf16("ä😀x", 2)).toBeNull();
  });
  it("highlights only matching native tokens and cleans reused rows without changing content", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<div data-line="2"><span data-char="0">ä </span><span data-char="2">run</span><span data-char="5">();</span></div>';
    const before = shadow.querySelector("div")!.textContent;
    const unicodeSite = { ...site, column: 4, endColumn: 7 };
    const hints = buildPhpCommentAnnotations("src/Test.php", "<?php\nä run();", [unicodeSite]);
    syncPhpCommentHighlights(host, "<?php\nä run();", hints);
    expect(shadow.querySelector('[data-char="2"]')!.getAttribute("data-t3-comment-severity")).toBe(
      "warning",
    );
    expect(shadow.querySelectorAll("[data-t3-comment-severity]")).toHaveLength(1);
    expect(shadow.querySelector("div")!.textContent).toBe(before);
    syncPhpCommentHighlights(host, "<?php\nä run();", []);
    expect(shadow.querySelector("[data-t3-comment-severity]")).toBeNull();
    expect(shadow.querySelector("style")).toBeNull();
  });
});
