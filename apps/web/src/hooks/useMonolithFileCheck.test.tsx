import { EnvironmentId, type MonolithCheckFileResult } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { analyzerContentRevision } from "~/components/files/fileAnalyzerDiagnostics";

const doubles = vi.hoisted(() => ({
  supported: true,
  canRead: true,
  canRun: true,
  toolsRevision: 0,
  check: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "permission" ? doubles.canRun : doubles.toolsRevision),
}));
vi.mock("~/state/monolithAnalyzers", () => ({
  monolithAnalyzerEnvironment: {
    checkFile: { permissionAtom: () => "permission" },
    checkRevision: () => "version",
  },
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () => ({
    get: () => ({ environment: { capabilities: { monolithAnalyzers: doubles.supported } } }),
  }),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => doubles.canRead }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => doubles.check }));

import { useMonolithFileCheck } from "./useMonolithFileCheck";

const base = {
  environmentId: EnvironmentId.make("local"),
  cwd: "/repo",
  path: "app/File.php",
  contents: "<?php\nerror();",
  persisted: true,
  onStale: doubles.refresh,
};
let latest: ReturnType<typeof useMonolithFileCheck> | undefined;
let renderer: ReactTestRenderer | undefined;
let pending: ((response: { _tag: "Success"; value: MonolithCheckFileResult }) => void)[];

function Probe(props: Parameters<typeof useMonolithFileCheck>[0]) {
  const value = useMonolithFileCheck(props);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}
function success(contents: string, path = base.path) {
  return {
    _tag: "Success" as const,
    value: {
      areaId: "php:app",
      revision: analyzerContentRevision(contents),
      runs: [
        {
          tool: "mago" as const,
          operation: "analyze" as const,
          status: "findings" as const,
          diagnosticCount: 1,
        },
      ],
      diagnostics: [
        {
          path,
          line: 2,
          column: 1,
          severity: "error" as const,
          message: "Unknown service",
          ruleId: "unknown-service",
          tool: "mago" as const,
          operation: "analyze" as const,
        },
      ],
    },
  };
}
async function mount(props = base) {
  await act(async () => {
    renderer = create(<Probe {...props} />);
  });
}
async function update(props: Parameters<typeof useMonolithFileCheck>[0]) {
  await act(async () => {
    renderer?.update(<Probe {...props} />);
  });
}

beforeEach(() => {
  doubles.supported = doubles.canRead = doubles.canRun = true;
  doubles.toolsRevision = 0;
  doubles.check.mockReset();
  doubles.refresh.mockReset();
  pending = [];
  doubles.check.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  latest = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("automatic saved-file checks", () => {
  it("hides query budgets and entry chains immediately when the saved revision changes", async () => {
    await mount();
    const response = success(base.contents);
    await act(async () =>
      pending[0]?.({
        ...response,
        value: {
          ...response.value,
          queryBudget: {
            status: "complete",
            methods: [
              {
                symbol: "App::load",
                path: base.path,
                line: 2,
                lowerBound: 2,
                upperBound: 5,
                unknown: [],
                cycles: [],
              },
            ],
          },
          entryChains: {
            status: "incomplete",
            targets: [
              {
                symbol: "App::load",
                path: base.path,
                directCallers: [],
                entries: [],
                unknown: ["dynamic caller"],
                truncated: false,
              },
            ],
          },
        },
      }),
    );
    expect(latest?.result?.queryBudget?.methods[0]?.upperBound).toBe(5);
    expect(latest?.result?.entryChains?.status).toBe("incomplete");
    await update({ ...base, contents: "<?php\nchanged();" });
    expect(latest?.result).toBeNull();
    expect(latest?.status).toBe("checking");
  });
  it("waits for saved contents and hides findings as soon as the user edits", async () => {
    await mount({ ...base, persisted: false });
    expect(doubles.check).not.toHaveBeenCalled();
    await update(base);
    expect(doubles.check).toHaveBeenCalledOnce();
    await act(async () => pending[0]?.(success(base.contents)));
    expect(latest?.diagnostics).toHaveLength(1);
    await update({ ...base, contents: "<?php\nnewDraft();", persisted: false });
    expect(latest?.diagnostics).toEqual([]);
    expect(latest?.status).toBe("unsaved");
    expect(doubles.check).toHaveBeenCalledOnce();
  });

  it("ignores late results after changing the file and environment", async () => {
    await mount();
    const next = { ...base, environmentId: EnvironmentId.make("remote"), path: "app/Other.php" };
    await update(next);
    expect(doubles.check).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]?.(success(base.contents)));
    expect(latest?.diagnostics).toEqual([]);
    await act(async () => pending[1]?.(success(next.contents, next.path)));
    expect(latest?.diagnostics[0]?.path).toBe(next.path);
  });

  it("rejects a response for another saved revision and refreshes the source", async () => {
    await mount();
    await act(async () => pending[0]?.(success("<?php\nexternalChange();")));
    expect(latest?.status).toBe("stale");
    expect(latest?.diagnostics).toEqual([]);
    expect(doubles.refresh).toHaveBeenCalledOnce();
  });

  it.each(["canRead", "canRun", "supported"] as const)(
    "does not run without %s",
    async (permission) => {
      doubles[permission] = false;
      await mount();
      expect(doubles.check).not.toHaveBeenCalled();
    },
  );

  it("rechecks the current saved file when reference generation invalidates tool results", async () => {
    await mount();
    await act(async () => pending[0]?.(success(base.contents)));
    expect(latest?.diagnostics).toHaveLength(1);
    doubles.toolsRevision++;
    await update(base);
    expect(doubles.check).toHaveBeenCalledTimes(2);
    expect(latest?.diagnostics).toHaveLength(1);
    expect(latest?.status).toBe("checking");
    await act(async () => pending[1]?.(success(base.contents)));
    expect(latest?.diagnostics).toHaveLength(1);
  });

  it("does not recheck identical contents across no-op saves or callback changes", async () => {
    await mount();
    await act(async () => pending[0]?.(success(base.contents)));
    const result = latest?.result;
    await update({ ...base, persisted: false, onStale: () => {} });
    expect(latest?.result).toBe(result);
    expect(latest?.diagnostics).toHaveLength(1);
    await update({ ...base, onStale: () => {} });
    expect(doubles.check).toHaveBeenCalledTimes(1);
    expect(latest?.result).toBe(result);
    await update({ ...base, contents: "<?php\nchanged();" });
    expect(doubles.check).toHaveBeenCalledTimes(2);
    expect(latest?.result).toBeNull();
  });

  it("does not restart a pending check when the source refresh callback changes", async () => {
    await mount();
    const refresh = vi.fn();
    await update({ ...base, onStale: refresh });
    expect(doubles.check).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]?.(success("<?php\nexternal();")));
    expect(refresh).toHaveBeenCalledOnce();
    expect(doubles.refresh).not.toHaveBeenCalled();
  });

  it("drops in-flight results when process permission is revoked", async () => {
    await mount();
    doubles.canRun = false;
    await update(base);
    await act(async () => pending[0]?.(success(base.contents)));
    expect(latest?.diagnostics).toEqual([]);
    expect(latest?.canRun).toBe(false);
  });
});
