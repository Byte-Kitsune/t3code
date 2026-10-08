import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MonolithArea, MonolithCheckFileResult } from "./monolith.ts";

const decodeResult = Schema.decodeSync(MonolithCheckFileResult);
const decodeArea = Schema.decodeUnknownSync(MonolithArea);

describe("shared PHP insights contracts", () => {
  it("round-trips per-area query thresholds and rejects unordered or fractional boundaries", () => {
    const area = { id: "api", name: "API", path: "artifact/api", kind: "php" };
    expect(
      decodeArea({ ...area, doctrineQueryThresholds: { warning: 5, error: 20 } })
        .doctrineQueryThresholds,
    ).toEqual({ warning: 5, error: 20 });
    for (const doctrineQueryThresholds of [
      { warning: -1, error: 50 },
      { warning: 10.5, error: 50 },
      { warning: 50, error: 50 },
      { warning: 60, error: 50 },
    ])
      expect(() => decodeArea({ ...area, doctrineQueryThresholds })).toThrow();
  });
  it("keeps unknown query upper bounds and incomplete call chains across transport", () => {
    const result = decodeResult({
      areaId: "api",
      diagnostics: [],
      runs: [],
      revision: "saved-source",
      queryBudget: {
        status: "incomplete",
        methods: [
          {
            symbol: "App\\Service::run",
            path: "artifact/api/src/Service.php",
            line: 4,
            lowerBound: 2,
            upperBound: null,
            unknown: ["dynamic call"],
            cycles: [],
          },
        ],
      },
      entryChains: {
        status: "incomplete",
        targets: [
          {
            symbol: "App\\Service::run",
            path: "artifact/api/src/Service.php",
            directCallers: [],
            entries: [],
            unknown: ["missing container reference"],
            truncated: false,
          },
        ],
      },
    });
    expect(result.queryBudget?.methods[0]?.upperBound).toBeNull();
    expect(result.entryChains?.status).toBe("incomplete");
  });

  it("accepts older servers without insight fields", () => {
    expect(
      decodeResult({
        areaId: null,
        diagnostics: [],
        runs: [],
        revision: "saved-source",
      }).queryBudget,
    ).toBeUndefined();
  });

  it("rejects entry scopes outside the area and limits configuration work", () => {
    const decode = decodeArea;
    const area = { id: "api", name: "API", path: "artifact/api", kind: "php" };
    expect(() => decode({ ...area, entrypointPaths: ["../other"] })).toThrow();
    expect(() =>
      decode({ ...area, entrypointPaths: Array.from({ length: 101 }, () => "src") }),
    ).toThrow();
    expect(
      decode({ ...area, entrypointPaths: ["app/Http", "src/Command"] }).entrypointPaths,
    ).toEqual(["app/Http", "src/Command"]);
  });
});
