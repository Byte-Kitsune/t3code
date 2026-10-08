// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type MonolithReviewRun } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const doubles = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  setPrompt: vi.fn(),
  openFile: vi.fn(),
  allowed: true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => doubles.allowed }));
vi.mock("../hooks/useMonolithAreas", () => ({
  useMonolithAreas: () => ({ config: { defaultBaseBranch: "origin/develop" }, supported: true }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: () => ({ prompt: "My existing instructions" }),
      setPrompt: doubles.setPrompt,
    }),
  },
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: doubles.openFile }) },
}));
vi.mock("../state/monolithReview", async () => {
  const { create } = await import("zustand");
  return {
    isMonolithReviewActive: (run: MonolithReviewRun | undefined) =>
      run?.status === "queued" || run?.status === "running",
    monolithReviewEnvironment: {
      start: { permissionAtom: () => "permission", name: "start" },
      get: { name: "get" },
      cancel: { name: "cancel" },
    },
    useMonolithReviewStore: create<{
      runs: Record<string, MonolithReviewRun>;
      setRun: (key: string, run: MonolithReviewRun, expectedRunId?: string) => void;
    }>((set) => ({
      runs: {},
      setRun: (key, run, expectedRunId) =>
        set((state) =>
          expectedRunId !== undefined && state.runs[key]?.runId !== expectedRunId
            ? state
            : { runs: { ...state.runs, [key]: run } },
        ),
    })),
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: "start" | "get" | "cancel" }) => doubles[command.name],
}));
import { MonolithPrReviewPanel } from "./MonolithPrReviewPanel";
import { useMonolithReviewStore } from "../state/monolithReview";

const environmentId = EnvironmentId.make("local");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
const run: MonolithReviewRun = {
  runId: "review",
  cwd: "/repo",
  status: "completed",
  baseRef: "origin/develop",
  baseCommit: "base",
  mergeBase: "merge",
  headCommit: "head",
  worktreeIdentity: "identity",
  includeWorkingTree: false,
  revision: "revision",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:01Z",
  groups: [
    {
      areaId: "api",
      name: "API",
      path: "api",
      kind: "php",
      files: [
        {
          path: "api/Foo.php",
          status: "modified",
          patch: "+hello",
          patchHash: "patch",
          patchTruncated: false,
          checkStatus: "completed",
        },
      ],
      aiPackage: { prompt: "Review", text: "Review API snapshot", omissions: [], complete: true },
    },
  ],
  coverage: { totalFiles: 1, checkedFiles: 1, omittedFiles: 0, truncatedPatches: 0 },
};
let renderer: ReactTestRenderer | undefined;
function button(text: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.join("") === text)!;
}
async function mount() {
  await act(async () => {
    renderer = create(
      <MonolithPrReviewPanel
        environmentId={environmentId}
        cwd="/repo"
        threadRef={threadRef}
        composerDraftTarget={threadRef}
        workspaceMutationId={null}
      />,
    );
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  doubles.allowed = true;
  for (const mock of [
    doubles.start,
    doubles.get,
    doubles.cancel,
    doubles.setPrompt,
    doubles.openFile,
  ])
    mock.mockReset();
  doubles.start.mockResolvedValue({ _tag: "Success", value: { ...run, status: "running" } });
  doubles.get.mockResolvedValue({ _tag: "Success", value: run });
  useMonolithReviewStore.setState({ runs: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PR review workflow", () => {
  it("loads full terminal details even after publishing progress retires the poll effect", async () => {
    let finish: ((result: { _tag: "Success"; value: MonolithReviewRun }) => void) | undefined;
    const compact = { ...run, groups: [] };
    doubles.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    useMonolithReviewStore.setState({ runs: { "local:/repo": { ...run, status: "running" } } });
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Another completed status result retires the active poll while its response
    // is in flight, exactly as a terminal progress publication does.
    await act(async () => {
      useMonolithReviewStore.setState({ runs: { "local:/repo": compact } });
    });
    expect(button("Add review to chat")).toBeUndefined();
    await act(async () => {
      finish!({ _tag: "Success", value: compact });
    });
    expect(doubles.get).toHaveBeenCalledTimes(2);
    expect(doubles.get).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", runId: "review", includeDetails: true },
    });
    expect(button("Add review to chat")).toBeDefined();
  });
  it("does not fetch or overwrite an obsolete run after a new review replaces it", async () => {
    let finish: ((result: { _tag: "Success"; value: MonolithReviewRun }) => void) | undefined;
    doubles.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    useMonolithReviewStore.setState({ runs: { "local:/repo": { ...run, status: "running" } } });
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      useMonolithReviewStore.setState({
        runs: { "local:/repo": { ...run, runId: "replacement" } },
      });
    });
    await act(async () => {
      finish!({ _tag: "Success", value: { ...run, groups: [] } });
    });
    expect(doubles.get).toHaveBeenCalledOnce();
    expect(useMonolithReviewStore.getState().runs["local:/repo"]?.runId).toBe("replacement");
  });
  it("renders patches, findings and package text only when their disclosure is opened", async () => {
    const detailedRun: MonolithReviewRun = {
      ...run,
      groups: [
        {
          ...run.groups[0]!,
          files: [
            {
              ...run.groups[0]!.files[0]!,
              checks: {
                areaId: "api",
                revision: "revision",
                diagnostics: [],
                runs: [
                  {
                    tool: "mago",
                    operation: "analyze",
                    status: "failed",
                    diagnosticCount: 0,
                    message: "Captured check failed",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    useMonolithReviewStore.setState({ runs: { "local:/repo": detailedRun } });
    await mount();
    expect(renderer!.root.findAllByType("pre")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Captured check failed");
    const disclosures = renderer!.root.findAllByType("details");
    await act(async () => {
      disclosures[1]!.props.onToggle({ currentTarget: { open: true } });
    });
    expect(renderer!.root.findAllByType("pre")[0]!.children.join("")).toBe("+hello");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Captured check failed");
    await act(async () => {
      disclosures[0]!.props.onToggle({ currentTarget: { open: true } });
    });
    expect(renderer!.root.findAllByType("pre").map((node) => node.children.join(""))).toContain(
      "Review API snapshot",
    );
    await act(async () => {
      disclosures[1]!.props.onToggle({ currentTarget: { open: false } });
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Captured check failed");
    expect(renderer!.root.findAllByType("summary")).toHaveLength(2);
  });
  it("uses a per-run branch override and explicitly includes saved working-tree changes", async () => {
    await mount();
    await act(async () => {
      const fields = renderer!.root.findAllByType("input");
      fields
        .find((field) => field.props.type !== "checkbox")!
        .props.onChange({ currentTarget: { value: "origin/release" } });
      fields
        .find((field) => field.props.type === "checkbox")!
        .props.onChange({ currentTarget: { checked: true } });
    });
    await act(async () => {
      button("Start PR review").props.onClick();
    });
    expect(doubles.start).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", baseRef: "origin/release", includeWorkingTree: true },
    });
  });
  it("keeps progress polling lightweight and does not reschedule it after each response", async () => {
    doubles.get.mockResolvedValue({
      _tag: "Success",
      value: { ...run, status: "running", groups: [] },
    });
    await mount();
    await act(async () => {
      button("Start PR review").props.onClick();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(doubles.get).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", runId: "review", includeDetails: false },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499);
    });
    expect(doubles.get).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(doubles.get).toHaveBeenCalledTimes(2);
    expect(doubles.start).toHaveBeenCalledOnce();
  });
  it("starts with the saved comparison branch, polls without repeating checks, and preserves the chat draft", async () => {
    await mount();
    await act(async () => {
      button("Start PR review").props.onClick();
    });
    expect(doubles.start).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", baseRef: "origin/develop", includeWorkingTree: false },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(doubles.start).toHaveBeenCalledOnce();
    expect(doubles.get).toHaveBeenCalledTimes(2);
    await act(async () => {
      button("Add review to chat").props.onClick();
    });
    expect(doubles.get).toHaveBeenCalledTimes(3);
    expect(doubles.setPrompt).toHaveBeenCalledWith(
      threadRef,
      "My existing instructions\n\nReview API snapshot",
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain("Nothing has been sent");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(doubles.get).toHaveBeenCalledTimes(3);
  });
  it("revalidates packages and refuses to add findings after repository drift", async () => {
    useMonolithReviewStore.setState({ runs: { "local:/repo": run } });
    doubles.get.mockResolvedValue({
      _tag: "Success",
      value: { ...run, status: "stale", message: "Repository changed" },
    });
    await mount();
    await act(async () => {
      button("Add review to chat").props.onClick();
    });
    expect(doubles.setPrompt).not.toHaveBeenCalled();
    expect(button("Add review to chat").props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Repository changed");
  });
  it("cancels a background review and does not start tools without permission", async () => {
    useMonolithReviewStore.setState({ runs: { "local:/repo": { ...run, status: "running" } } });
    doubles.cancel.mockResolvedValue({ _tag: "Success", value: { ...run, status: "cancelled" } });
    await mount();
    await act(async () => {
      button("Cancel").props.onClick();
    });
    expect(doubles.cancel).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", runId: "review" },
    });
    doubles.allowed = false;
    await act(async () => {
      renderer!.update(
        <MonolithPrReviewPanel
          environmentId={environmentId}
          cwd="/repo"
          threadRef={threadRef}
          composerDraftTarget={threadRef}
          workspaceMutationId={null}
        />,
      );
    });
    expect(button("Start PR review").props.disabled).toBe(true);
    expect(doubles.start).not.toHaveBeenCalled();
  });
});
