import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

const discovery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:monolith:analyzers",
  tag: WS_METHODS.projectsMonolithAnalyzers,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
const checkRevision = Atom.family((_key: string) => Atom.make(0));

export const monolithAnalyzerEnvironment = {
  discovery,
  checkRevision,
  checkFile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:check-file",
    tag: WS_METHODS.projectsMonolithCheckFile,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.cwd}:${input.path}`,
    },
  }),
  generateReferences: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:generate-references",
    tag: WS_METHODS.projectsMonolithGenerateReferences,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.cwd}:${input.areaId}`,
    },
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        registry.refresh(discovery({ environmentId, input: { cwd: input.cwd } }));
        const version = checkRevision(`${environmentId}:${input.cwd}`);
        registry.set(version, registry.get(version) + 1);
      }),
  }),
};
