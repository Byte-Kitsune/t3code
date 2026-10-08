import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

const get = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:monolith:get",
  tag: WS_METHODS.projectsMonolithGet,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const initializationScheduler = createAtomCommandScheduler();

export const monolithEnvironment = {
  initialize: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:initialize",
    tag: WS_METHODS.projectsMonolithInitialize,
    scheduler: initializationScheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.cwd}`,
    },
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        registry.refresh(get({ environmentId, input: { cwd: input.cwd, initialize: false } }));
      }),
  }),
  get,
  discover: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:discover",
    tag: WS_METHODS.projectsMonolithDiscover,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:monolith:save",
    tag: WS_METHODS.projectsMonolithSave,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.cwd}`,
    },
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        registry.refresh(get({ environmentId, input: { cwd: input.cwd, initialize: false } }));
      }),
  }),
};
