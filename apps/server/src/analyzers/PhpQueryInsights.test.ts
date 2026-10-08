import { describe, expect, it } from "vite-plus/test";
import { decodePhpQueryInsights } from "./PhpQueryInsights.ts";

const method = {
  symbol: "App\\Service::run",
  path: "artifact/api/src/Service.php",
  line: 12,
  column: 1,
  lowerBound: 0,
  upperBound: 0,
  unknown: [],
  cycles: [],
};
const path = method.path;
const decode = (report: unknown) => decodePhpQueryInsights(JSON.stringify(report), path);

describe("Doctrine query insights sidecars", () => {
  it("retains successful zero and below-threshold estimates per method", () => {
    expect(decode({ status: "complete", methods: [method] }).methods[0]!.upperBound).toBe(0);
    expect(
      decode({ status: "complete", methods: [{ ...method, lowerBound: 2, upperBound: 5 }] })
        .methods[0],
    ).toMatchObject({ lowerBound: 2, upperBound: 5 });
  });
  it("keeps lower bounds, unbounded branches and recursion explicit", () => {
    expect(
      decode({
        status: "incomplete",
        methods: [
          {
            ...method,
            lowerBound: 2,
            upperBound: null,
            unknown: ["dynamic call"],
            cycles: ["App\\Service::run"],
          },
        ],
      }),
    ).toMatchObject({ status: "incomplete", methods: [{ lowerBound: 2, upperBound: null }] });
  });
  it("rejects contradictory completeness, duplicate symbols and foreign file paths", () => {
    expect(() =>
      decode({ status: "complete", methods: [{ ...method, upperBound: null }] }),
    ).toThrow();
    expect(() => decode({ status: "incomplete", methods: [method] })).toThrow();
    expect(() => decode({ status: "complete", methods: [method, method] })).toThrow();
    expect(() =>
      decode({ status: "complete", methods: [{ ...method, path: "../outside.php" }] }),
    ).toThrow();
  });
  it("never turns missing evidence, invalid numbers or a failed run into zero queries", () => {
    expect(
      decode({ status: "unavailable", methods: [], message: "Install the extension" }),
    ).toMatchObject({ status: "unavailable" });
    expect(() => decode({ status: "complete" })).toThrow();
    expect(() => decode({ status: "failed", methods: [method] })).toThrow();
    expect(() =>
      decode({ status: "complete", methods: [{ ...method, lowerBound: 4, upperBound: 2 }] }),
    ).toThrow();
    expect(() =>
      decode({
        status: "complete",
        methods: [{ ...method, lowerBound: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toThrow();
    expect(() => decodePhpQueryInsights("{", path)).toThrow();
  });
});
