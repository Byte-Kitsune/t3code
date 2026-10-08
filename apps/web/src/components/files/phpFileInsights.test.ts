import type { MonolithCheckFileResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { phpInsightSourceTarget, queryBudgetLabel } from "./phpFileInsights";

type Method = NonNullable<MonolithCheckFileResult["queryBudget"]>["methods"][number];
const method = (lowerBound: number, upperBound: number | null): Method => ({
  symbol: "App\\Repository::find",
  path: "artifact/api/src/Repository.php",
  line: 7,
  lowerBound,
  upperBound,
  unknown: [],
  cycles: [],
});

describe("PHP file insight presentation", () => {
  it("distinguishes a proven zero from an unknown budget", () => {
    expect(queryBudgetLabel(method(0, 0))).toBe("0 queries");
    expect(queryBudgetLabel(method(0, null))).toBe("Unknown query count");
  });
  it("preserves exact, conditional and unbounded estimates without summing methods", () => {
    expect([method(1, 1), method(2, 5), method(2, null)].map(queryBudgetLabel)).toEqual([
      "1 query",
      "2–5 queries",
      "At least 2 queries; upper bound unknown",
    ]);
  });
  it("normalizes in-workspace exported locations and preserves source line navigation", () => {
    expect(
      phpInsightSourceTarget({ path: ".\\artifact\\api\\src\\Controller.php", line: 17 }),
    ).toEqual({ path: "artifact/api/src/Controller.php", line: 17 });
  });
  it.each([
    "/etc/source.php",
    "C:\\source.php",
    "../source.php",
    "api/../../source.php",
    "",
    "api//source.php",
  ])("does not navigate external or malformed source %s", (path) => {
    expect(phpInsightSourceTarget({ path, line: 1 })).toBeNull();
  });
  it.each([0, -1, 1.5, Number.NaN])("does not reveal invalid source line %s", (line) => {
    expect(phpInsightSourceTarget({ path: "api/File.php", line })).toEqual({
      path: "api/File.php",
      line: undefined,
    });
  });
});
