import { describe, expect, it } from "vitest";
import { AuthFilesystemWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("monolith RPC permissions", () => {
  it("allows discovery and non-initializing reads without filesystem write access", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectsMonolithDiscover, { cwd: "/repo" })).toEqual(
      [],
    );
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsMonolithGet, { cwd: "/repo", initialize: false }),
    ).toEqual([]);
  });
  it("requires write access for explicit first-open initialization", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsMonolithInitialize, { cwd: "/repo" }),
    ).toEqual([AuthFilesystemWriteScope]);
  });
  it("requires filesystem write access to change shared areas", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectsMonolithSave, {})).toEqual([
      AuthFilesystemWriteScope,
    ]);
  });
});
