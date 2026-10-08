import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { monolithAnalyzerEnvironment } from "~/state/monolithAnalyzers";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";

export function MonolithIndexStatus({
  environmentId,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const allowed = useAtomValue(monolithAnalyzerEnvironment.index.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    allowed ? monolithAnalyzerEnvironment.indexStatus({ environmentId, input: { cwd } }) : null,
  );
  const index = useAtomCommand(monolithAnalyzerEnvironment.index, { reportFailure: false });
  if (!status.data?.areas.length) return null;
  const running = status.data.areas.filter((area) => area.status === "indexing").length;
  const ready = status.data.areas.filter((area) => area.status === "ready").length;
  return (
    <details className="border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        Project index ·{" "}
        {running ? `${running} areas indexing` : `${ready}/${status.data.areas.length} areas ready`}
      </summary>
      <div className="max-h-32 space-y-1 overflow-auto py-1">
        {status.data.areas.map((area) => (
          <p key={area.areaId}>
            {area.areaId}: {area.status} · {area.fileCount} files
            {area.message ? ` — ${area.message}` : ""}
          </p>
        ))}
        <button
          type="button"
          className="cursor-pointer underline"
          disabled={!allowed || running > 0}
          onClick={() => {
            void index({ environmentId, input: { cwd, force: true } });
          }}
        >
          Rebuild project index
        </button>
      </div>
    </details>
  );
}
