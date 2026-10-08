import { describe, expect, it } from "vite-plus/test";
import type { ProjectCloneSnapshot } from "@t3tools/contracts";
import { monolithCloneReady } from "./monolithCloneReadiness";

const clone = (destinationPath: string, phase: ProjectCloneSnapshot["phase"]) =>
  ({ destinationPath, phase }) as ProjectCloneSnapshot;
const ready = (clones: readonly ProjectCloneSnapshot[], cwd: string) =>
  monolithCloneReady({ tracked: true, streamReady: true, clones, cwd });

describe("monolith clone readiness", () => {
  it("waits for the initial clone snapshot rather than accepting an empty pending stream", () => {
    expect(
      monolithCloneReady({ tracked: true, streamReady: false, clones: [], cwd: "/repo" }),
    ).toBe(false);
    expect(ready([], "/repo")).toBe(true);
  });
  it("blocks unfinished checkouts and their subdirectories", () => {
    for (const phase of ["running", "failed", "cancelled"] as const) {
      expect(ready([clone("/repo/", phase)], "/repo")).toBe(false);
      expect(ready([clone("/repo", phase)], "/repo/apps/web")).toBe(false);
    }
  });
  it("allows finished clones and does not confuse adjacent folder prefixes", () => {
    expect(ready([clone("/repo", "done")], "/repo")).toBe(true);
    expect(ready([clone("/repo", "running")], "/repository")).toBe(true);
    expect(ready([clone("/other", "running")], "/repo")).toBe(true);
  });
  it("normalizes Windows directory separators and supports servers without clone tracking", () => {
    expect(ready([clone("C:\\repo\\", "running")], "C:/repo/apps")).toBe(false);
    expect(
      monolithCloneReady({ tracked: false, streamReady: false, clones: null, cwd: "/repo" }),
    ).toBe(true);
  });
});
