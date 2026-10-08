import { describe, expect, it } from "vite-plus/test";
import type {
  MonolithCheckFileResult,
  MonolithConfig,
  MonolithReviewFile,
  MonolithReviewRun,
} from "@t3tools/contracts";
import { buildMonolithReviewPackages } from "./monolithReviewPackages.ts";

const config: MonolithConfig = {
  version: 1,
  initialized: true,
  reviewPrompt: "Global security review",
  areas: [
    { id: "api", name: "API", path: "api", kind: "php", reviewPrompt: "Review the API contract" },
    { id: "ui", name: "UI", path: "ui", kind: "react" },
  ],
};
const checks: MonolithCheckFileResult = {
  areaId: "api",
  revision: "source-hash",
  runs: [{ tool: "mago", operation: "analyze", status: "findings", diagnosticCount: 1 }],
  diagnostics: [
    {
      path: "api/Handler.php",
      line: 250,
      severity: "warning",
      message: "Known error outside the changed hunk",
      ruleId: "example",
      tool: "mago",
      operation: "analyze",
    },
  ],
};
const file: MonolithReviewFile = {
  path: "api/Handler.php",
  status: "modified",
  patch: "@@ -1 +1 @@\n-before\n+after",
  patchHash: "patch-hash",
  patchTruncated: false,
  fileHash: "source-hash",
  checkStatus: "completed",
  checks,
};
function run(files: MonolithReviewFile[] = [file]): MonolithReviewRun {
  return {
    runId: "run",
    cwd: "/repo",
    status: "completed",
    baseRef: "main",
    baseCommit: "base-sha",
    mergeBase: "merge-sha",
    headCommit: "head-sha",
    worktreeIdentity: "workspace-hash",
    includeWorkingTree: true,
    revision: "review-hash",
    createdAt: "2026-10-08T12:00:00Z",
    updatedAt: "2026-10-08T12:00:01Z",
    groups: [
      { areaId: "api", name: "API", path: "api", kind: "php", files },
      {
        areaId: "ui",
        name: "UI",
        path: "ui",
        kind: "react",
        files: [
          { ...file, path: "ui/Client.tsx", checks: { ...checks, areaId: "ui", diagnostics: [] } },
        ],
      },
    ],
    coverage: {
      totalFiles: files.length + 1,
      checkedFiles: files.length + 1,
      omittedFiles: 0,
      truncatedPatches: 0,
    },
  };
}

describe("captured PR AI packages", () => {
  it("keeps revision provenance, positions outside hunks, area overrides and cross-area contract context", () => {
    const groups = buildMonolithReviewPackages(run(), config);
    expect(groups[0]?.aiPackage?.prompt).toBe("Review the API contract");
    expect(groups[1]?.aiPackage?.prompt).toBe("Global security review");
    const packet = groups[0]!.aiPackage!;
    expect(packet.complete).toBe(true);
    for (const evidence of [
      "base-sha",
      "merge-sha",
      "head-sha",
      "workspace-hash",
      "review-hash",
      "source-hash",
      '"line":250',
      "ui/Client.tsx",
      "Cross-area pass",
      "untrusted review data",
    ])
      expect(packet.text).toContain(evidence);
  });
  it("retains failed checks and unknown PHP coverage without calling them clean", () => {
    const source = run([
      {
        ...file,
        checks: {
          ...checks,
          runs: [{ tool: "mago", operation: "guard", status: "failed", diagnosticCount: 0 }],
          queryBudget: {
            status: "incomplete",
            message: "Missing binding",
            methods: [
              {
                path: file.path,
                symbol: "Handler::run",
                lowerBound: 0,
                upperBound: null,
                unknown: ["dynamic call"],
                cycles: [],
              },
            ],
          },
          entryChains: {
            status: "complete",
            targets: [
              {
                symbol: "Handler::run",
                path: file.path,
                directCallers: [],
                entries: [],
                unknown: ["unknown entry"],
                truncated: true,
              },
            ],
          },
        },
      },
    ]);
    const packet = buildMonolithReviewPackages(source, config)[0]!.aiPackage!;
    expect(packet.complete).toBe(false);
    expect(packet.omissions.join("\n")).toMatch(/guard failed/);
    expect(packet.omissions.join("\n")).toContain("Doctrine queries incomplete");
    expect(packet.omissions.join("\n")).toContain("do not treat them as zero");
    expect(packet.omissions.join("\n")).toContain("does not establish unused code");
    expect(packet.text).toContain('"upperBound":null');
  });
  it("bounds all package text and reports omitted evidence while keeping full run data unchanged", () => {
    const initial = run(
      Array.from({ length: 100 }, (_, index) => ({
        ...file,
        path: `api/File${index}.php`,
        patch: "x".repeat(10000),
      })),
    );
    const source: MonolithReviewRun = {
      ...initial,
      groups: [
        ...initial.groups,
        ...Array.from({ length: 8 }, (_, index) => ({
          ...initial.groups[0]!,
          areaId: `extra${index}`,
          name: `Area ${index}`,
        })),
      ],
    };
    const before = JSON.stringify(source);
    const groups = buildMonolithReviewPackages(source, config);
    expect(
      groups.reduce((total, group) => total + Buffer.byteLength(group.aiPackage!.text), 0),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(groups.every((group) => Buffer.byteLength(group.aiPackage!.text) <= 128 * 1024)).toBe(
      true,
    );
    expect(groups[0]!.aiPackage!.omissions.join("\n")).toContain(
      "file evidence records were omitted",
    );
    expect(groups.at(-1)!.aiPackage!.complete).toBe(false);
    expect(JSON.stringify(source)).toBe(before);
  });
  it("marks truncated, missing, skipped, and stale evidence as partial", () => {
    const { checks: _checks, ...withoutChecks } = file;
    const initial = run([
      {
        ...withoutChecks,
        checkStatus: "skipped",
        checksTruncated: true,
        patchTruncated: true,
        message: "Tools not installed",
      },
    ]);
    const source: MonolithReviewRun = {
      ...initial,
      status: "stale",
      coverage: { ...initial.coverage, omittedFiles: 20 },
    };
    const packet = buildMonolithReviewPackages(source, config)[0]!.aiPackage!;
    expect(packet.complete).toBe(false);
    expect(packet.omissions.join("\n")).toContain("20 changed files");
    expect(packet.omissions.join("\n")).toContain("Tools not installed");
    expect(packet.omissions.join("\n")).toContain("retention limit");
    expect(packet.omissions.join("\n")).toContain("source changed");
  });
});
