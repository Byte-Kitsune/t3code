import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MonolithConfig } from "./monolith.ts";
import { MonolithReviewGetInput, MonolithReviewStartInput } from "./monolithReview.ts";

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(MonolithConfig));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(MonolithConfig));
const decodeGet = Schema.decodeUnknownSync(MonolithReviewGetInput);
const decodeStart = Schema.decodeUnknownSync(MonolithReviewStartInput);

describe("monolith PR review configuration", () => {
  it("supports metadata-only background polling without changing legacy requests", () => {
    expect(decodeGet({ cwd: "/repo", runId: "review" })).toEqual({ cwd: "/repo", runId: "review" });
    expect(decodeGet({ cwd: "/repo", runId: "review", includeDetails: false }).includeDetails).toBe(
      false,
    );
  });
  it("round trips repository and area prompts without changing the config version", () => {
    const config = {
      version: 1 as const,
      initialized: true as const,
      defaultBaseBranch: "origin/main",
      reviewPrompt: "Review changed code for security and correctness.",
      areas: [
        {
          id: "api",
          name: "API",
          path: "artifact/api",
          kind: "php" as const,
          reviewPrompt: "Check Symfony services and Doctrine query budgets.",
        },
      ],
    };
    expect(decodeConfig(encodeConfig(config))).toEqual(config);
    expect(
      decodeConfig('{"version":1,"initialized":true,"areas":[]}').reviewPrompt,
    ).toBeUndefined();
  });

  it("bounds persisted prompts and permits explicit empty overrides", () => {
    expect(
      decodeConfig('{"version":1,"initialized":true,"areas":[],"reviewPrompt":""}').reviewPrompt,
    ).toBe("");
    expect(() =>
      decodeConfig(
        JSON.stringify({
          version: 1,
          initialized: true,
          areas: [],
          reviewPrompt: "x".repeat(16_385),
        }),
      ),
    ).toThrow();
  });

  it("allows configured branch defaults while rejecting empty or unbounded explicit refs", () => {
    expect(decodeStart({ cwd: "/repo" })).toEqual({ cwd: "/repo" });
    expect(
      decodeStart({ cwd: "/repo", baseRef: "origin/main", includeWorkingTree: true })
        .includeWorkingTree,
    ).toBe(true);
    expect(() => decodeStart({ cwd: "/repo", baseRef: " " })).toThrow();
    expect(() => decodeStart({ cwd: "/repo", baseRef: "x".repeat(201) })).toThrow();
  });
});
