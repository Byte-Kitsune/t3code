import { monolithCloneReady } from "./monolithCloneReadiness";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type MonolithArea,
  type MonolithConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useServerConfigs } from "../state/entities";
import { sourceControlEnvironment } from "../state/sourceControl";
import { monolithEnvironment } from "../state/monolith";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

const EMPTY_AREAS: readonly MonolithArea[] = [];

export function useMonolithAreas(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  options?: { readonly initialize?: boolean },
) {
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.monolithAreas === true;
  const tracksClones =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.projectCloneTracking === true;
  const cloneQuery = useEnvironmentQuery(
    supported && tracksClones && environmentId !== null
      ? sourceControlEnvironment.projectClones({ environmentId, input: {} })
      : null,
  );
  const cloneReady = monolithCloneReady({
    tracked: tracksClones,
    streamReady: cloneQuery.isSuccess,
    clones: cloneQuery.data,
    cwd,
  });
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const savePermission = useAtomValue(monolithEnvironment.save.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    supported && cloneReady && canRead && environmentId !== null && cwd !== null
      ? monolithEnvironment.get({ environmentId, input: { cwd, initialize: false } })
      : null,
  );
  const initializeCommand = useAtomCommand(monolithEnvironment.initialize, {
    reportFailure: false,
  });
  const initializedKey = useRef<string | null>(null);
  const saveCommand = useAtomCommand(monolithEnvironment.save, { reportFailure: false });
  const discoverCommand = useAtomCommand(monolithEnvironment.discover, { reportFailure: false });
  const operationVersion = useRef(0);
  const destinationKey = `${environmentId ?? ""}:${cwd ?? ""}`;
  const [operation, setOperation] = useState<{
    key: string;
    saving: boolean;
    error: string | null;
  } | null>(null);
  const saving = operation?.key === destinationKey && operation.saving;
  const operationError = operation?.key === destinationKey ? operation.error : null;
  const canEdit = supported && cloneReady && canRead && canWrite && savePermission;

  useEffect(() => {
    if (
      !supported ||
      !cloneReady ||
      !canRead ||
      !canWrite ||
      environmentId === null ||
      cwd === null ||
      options?.initialize === false ||
      query.data?.source !== "discovered"
    )
      return;
    const key = `${environmentId}:${cwd}`;
    if (initializedKey.current === key) return;
    initializedKey.current = key;
    const version = operationVersion.current;
    let active = true;
    void initializeCommand({ environmentId, input: { cwd } }).then((result) => {
      if (!active || operationVersion.current !== version) return;
      if (result._tag === "Failure")
        setOperation((current) =>
          current !== null && current.key !== key
            ? current
            : {
                key,
                saving: false,
                error: "Could not create t3.monolith.json. Retry by saving the project areas.",
              },
        );
    });
    return () => {
      active = false;
    };
  }, [
    canRead,
    cloneReady,
    canWrite,
    cwd,
    environmentId,
    initializeCommand,
    options?.initialize,
    query.data?.source,
    supported,
  ]);

  const save = async (config: MonolithConfig): Promise<boolean> => {
    if (environmentId === null || cwd === null || !canEdit) return false;
    const key = `${environmentId}:${cwd}`;
    operationVersion.current++;
    setOperation({ key, saving: true, error: null });
    try {
      const result = await saveCommand({ environmentId, input: { cwd, config } });
      if (result._tag === "Failure") {
        setOperation((current) =>
          current?.key === key
            ? {
                ...current,
                error: "Could not save project areas. Check the configuration and folder paths.",
              }
            : current,
        );
        return false;
      }
      return true;
    } finally {
      setOperation((current) => (current?.key === key ? { ...current, saving: false } : current));
    }
  };

  const discover = useCallback(async (): Promise<readonly MonolithArea[]> => {
    if (environmentId === null || cwd === null || !supported || !canRead || !cloneReady)
      return EMPTY_AREAS;
    const key = `${environmentId}:${cwd}`;
    operationVersion.current++;
    setOperation({ key, saving: false, error: null });
    const result = await discoverCommand({ environmentId, input: { cwd, initialize: false } });
    if (result._tag === "Failure") {
      setOperation((current) =>
        current?.key === key
          ? {
              ...current,
              error: "Could not scan project areas. Check that the project folder is available.",
            }
          : current,
      );
      return EMPTY_AREAS;
    }
    return result.value;
  }, [canRead, cloneReady, cwd, discoverCommand, environmentId, supported]);

  return {
    config: query.data?.config ?? null,
    configPath: query.data?.configPath ?? null,
    areas: query.data?.config.areas ?? EMPTY_AREAS,
    persisted: query.data?.source === "config",
    loading: query.isPending || (supported && !cloneReady),
    error: operationError ?? query.error ?? cloneQuery.error,
    saving,
    canEdit,
    supported,
    save,
    discover,
  };
}
