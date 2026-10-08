import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MonolithReviewRun } from "@t3tools/contracts";
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (options: unknown) => options,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
import { useMonolithReviewStore } from "./monolithReview";
const run: MonolithReviewRun = {
  runId: "one",
  cwd: "/repo",
  status: "running",
  baseRef: "main",
  baseCommit: "",
  mergeBase: "",
  headCommit: "",
  worktreeIdentity: "",
  includeWorkingTree: false,
  revision: "",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:01Z",
  groups: [],
  coverage: { totalFiles: 1, checkedFiles: 0, omittedFiles: 0, truncatedPatches: 0 },
};
beforeEach(() => useMonolithReviewStore.setState({ runs: {} }));
describe("review request races", () => {
  it("keeps a newer review when an old status request finishes later", () => {
    const store = useMonolithReviewStore.getState();
    store.setRun("project", run);
    store.setRun("project", { ...run, runId: "two" });
    store.setRun("project", { ...run, status: "completed" }, "one");
    expect(useMonolithReviewStore.getState().runs.project?.runId).toBe("two");
  });
  it("does not reopen completed progress after an overlapping poll resolves", () => {
    const store = useMonolithReviewStore.getState();
    store.setRun("project", { ...run, status: "completed" });
    store.setRun("project", run, "one");
    expect(useMonolithReviewStore.getState().runs.project?.status).toBe("completed");
  });
});
