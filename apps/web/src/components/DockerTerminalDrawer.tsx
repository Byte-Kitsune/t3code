import { useEffect, useEffectEvent, useMemo, useState } from "react";
import * as Schema from "effect/Schema";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import { useMonolithAreas } from "~/hooks/useMonolithAreas";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { terminalEnvironment } from "~/state/terminal";
import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  TerminalViewport,
  NormalThreadTerminalDrawer,
  type ThreadTerminalDrawerProps,
} from "./ThreadTerminalDrawer";
import {
  dockerTerminalTargets,
  rememberDockerTerminal,
  type DockerTerminalTarget,
} from "./dockerTerminalTargets";

const RECENT = Schema.Array(Schema.String).check(Schema.isMaxLength(64));

function DockerTerminalPane({
  target,
  logsId,
  ...props
}: ThreadTerminalDrawerProps & {
  readonly target: DockerTerminalTarget;
  readonly logsId: string | null;
}) {
  const [ids] = useState(() => ({ shell: `docker-${randomUUID()}` }));
  const logs = logsId !== null;
  const logTerminalId = logsId ? `${ids.shell}-logs-${logsId}` : null;
  const close = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const release = useEffectEvent((terminalId: string) => {
    void close({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadId, terminalId, deleteHistory: true },
    });
  });
  useEffect(
    () => () => {
      release(ids.shell);
    },
    [ids],
  );
  useEffect(
    () => () => {
      if (logTerminalId) release(logTerminalId);
    },
    [logTerminalId],
  );
  const common = {
    advancedTypography: false,
    threadRef: props.threadRef,
    threadId: props.threadId,
    cwd: props.cwd,
    ...(props.worktreePath !== undefined ? { worktreePath: props.worktreePath } : {}),
    onSessionExited: () => {},
    focusRequestId: props.focusRequestId,
    visible: props.visible ?? true,
    resizeEpoch: logs ? 1 : 0,
    drawerHeight: props.height,
    keybindings: props.keybindings,
  };
  return (
    <div
      className="flex min-h-0 flex-1"
      style={props.mode === "panel" ? undefined : { height: props.height }}
    >
      <div className="min-w-0 flex-1">
        <TerminalViewport
          {...common}
          terminalId={ids.shell}
          terminalLabel={target.label}
          compose={{ areaId: target.areaId, mode: "shell" }}
          autoFocus
          onAddTerminalContext={props.onAddTerminalContext}
        />
      </div>
      {logs ? (
        <div className="flex min-w-0 flex-1 flex-col border-l">
          <div className="border-b px-3 py-1 text-xs text-muted-foreground">
            Live logs · {target.service} · last 200 lines
          </div>
          <div className="min-h-0 flex-1">
            <TerminalViewport
              {...common}
              terminalId={logTerminalId!}
              terminalLabel={`${target.service} logs`}
              compose={{ areaId: target.areaId, mode: "logs" }}
              readOnly
              autoFocus={false}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function DockerTerminalDrawer(props: ThreadTerminalDrawerProps) {
  const projectKey = `${props.threadRef.environmentId}:${props.worktreePath ?? props.cwd}`;
  const areas = useMonolithAreas(props.threadRef.environmentId, props.worktreePath ?? props.cwd, {
    initialize: false,
  });
  const [recent, setRecent] = useLocalStorage<readonly string[], readonly string[]>(
    `t3:docker-terminal-recent:${projectKey}`,
    [],
    RECENT,
  );
  const targets = useMemo(
    () => dockerTerminalTargets(areas.config?.areas ?? [], recent),
    [areas.config, recent],
  );
  const [selection, setSelection] = useState<{ projectKey: string; key: string } | null>(null);
  const [logsId, setLogsId] = useState<string | null>(null);
  const logs = logsId !== null;
  const target =
    selection?.projectKey === projectKey
      ? targets.find((item) => item.key === selection.key)
      : undefined;
  const canOperate = useEnvironmentScope(props.threadRef.environmentId, AuthTerminalOperateScope);
  const select = (key: string) => {
    setSelection(key === "normal" ? null : { projectKey, key });
    if (key !== "normal") setRecent((value) => rememberDockerTerminal(value, key));
  };
  if (!targets.length) return <NormalThreadTerminalDrawer {...props} />;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-col"
      style={props.mode === "panel" ? { height: "100%" } : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 border-y bg-muted/30 px-2 py-1">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          <Button
            size="xs"
            variant={!target ? "secondary" : "ghost"}
            onClick={() => select("normal")}
          >
            Terminal
          </Button>
          {targets.map((item) => (
            <Button
              key={item.key}
              size="xs"
              variant={target?.key === item.key ? "secondary" : "ghost"}
              disabled={!canOperate}
              onClick={() => select(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {targets.length > 4 ? (
          <select
            aria-label="Docker Compose terminal target"
            className="max-w-48 rounded border bg-background px-2 py-1 text-xs"
            value={target?.key ?? "normal"}
            disabled={!canOperate}
            onChange={(event) => select(event.target.value)}
          >
            <option value="normal">Terminal</option>
            {targets.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        ) : null}
        {target ? (
          <Button
            size="xs"
            variant={logs ? "secondary" : "ghost"}
            disabled={!canOperate}
            onClick={() => setLogsId((value) => (value === null ? randomUUID().slice(0, 8) : null))}
          >
            Live logs
          </Button>
        ) : null}
      </div>
      {target && props.visible !== false && canOperate ? (
        <DockerTerminalPane
          key={`${projectKey}:${props.threadId}:${target.key}`}
          {...props}
          target={target}
          logsId={logsId}
        />
      ) : target && !canOperate ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          Terminal permission is required to open this Docker service.
        </p>
      ) : (
        <NormalThreadTerminalDrawer {...props} />
      )}
    </div>
  );
}
