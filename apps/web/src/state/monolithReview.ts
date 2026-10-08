import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type MonolithReviewRun } from "@t3tools/contracts";
import { create } from "zustand";
import { connectionAtomRuntime } from "../connection/runtime";

export function isMonolithReviewActive(run: MonolithReviewRun | null | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}

export const monolithReviewEnvironment = {
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:review-start",
    tag: WS_METHODS.projectsMonolithReviewStart,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.cwd}`,
    },
  }),
  get: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:review-get",
    tag: WS_METHODS.projectsMonolithReviewGet,
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:review-cancel",
    tag: WS_METHODS.projectsMonolithReviewCancel,
  }),
};

interface ReviewState {
  runs: Readonly<Record<string, MonolithReviewRun>>;
  setRun: (key: string, run: MonolithReviewRun, expectedRunId?: string) => void;
}

// Keep a running review when the user temporarily returns to the diff or another thread.
export const useMonolithReviewStore = create<ReviewState>((set) => ({
  runs: {},
  setRun: (key, run, expectedRunId) =>
    set((state) => {
      const current = state.runs[key];
      if (expectedRunId !== undefined && current?.runId !== expectedRunId) return state;
      if (
        current?.runId === run.runId &&
        (current.updatedAt > run.updatedAt ||
          (!isMonolithReviewActive(current) && isMonolithReviewActive(run)))
      )
        return state;
      return { runs: { ...state.runs, [key]: run } };
    }),
}));
