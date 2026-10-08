import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MonolithArea, MonolithAnnotationSite } from "./monolith.ts";
const decodeArea = Schema.decodeUnknownSync(MonolithArea);
const decodeSite = Schema.decodeUnknownSync(MonolithAnnotationSite);
describe("comment marker contracts", () => {
  const area = { id: "api", name: "API", path: "artifact/api", kind: "php" };
  it("preserves explicit disabled defaults and custom reference markers", () => {
    expect(decodeArea({ ...area, commentMarkers: [] }).commentMarkers).toEqual([]);
    expect(
      decodeArea({ ...area, commentMarkers: [{ marker: "[DEV COMMENT]", severity: "info" }] })
        .commentMarkers,
    ).toEqual([{ marker: "[DEV COMMENT]", severity: "info" }]);
  });
  it("rejects multiline markers and unbounded rule work", () => {
    expect(() =>
      decodeArea({ ...area, commentMarkers: [{ marker: "bad\nmarker", severity: "info" }] }),
    ).toThrow();
    expect(() =>
      decodeArea({
        ...area,
        commentMarkers: Array.from({ length: 33 }, () => ({ marker: "todo", severity: "info" })),
      }),
    ).toThrow();
  });
  it("rejects navigable source references outside the repository", () => {
    expect(() =>
      decodeSite({
        symbol: "A",
        targetSymbol: "B",
        kind: "type",
        path: "../outside.php",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
        annotations: [],
      }),
    ).toThrow();
  });
});
