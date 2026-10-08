import type { EnvironmentId } from "@t3tools/contracts";

const TOPIC = "t3code:workspace-file-saved";
interface SavedWorkspace {
  environmentId: EnvironmentId;
  cwd: string;
}
function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  return (
    typeof value === "object" &&
    value !== null &&
    "environmentId" in value &&
    typeof value.environmentId === "string" &&
    "cwd" in value &&
    typeof value.cwd === "string"
  );
}

/** Only successful writes publish this; unchanged autosaves never invalidate a diff. */
export function notifyWorkspaceFileSaved(workspace: SavedWorkspace): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOPIC, { detail: workspace }));
  if (typeof BroadcastChannel === "undefined") return;
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(TOPIC);
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped and has no targetOrigin argument.
    channel.postMessage(workspace);
  } catch {
    // Some browser policies disable cross-window channels. Local delivery still works.
  } finally {
    try {
      channel?.close();
    } catch {
      /* Closing a restricted channel must not fail a saved write. */
    }
  }
}

export function subscribeWorkspaceFileSaved(
  listener: (workspace: SavedWorkspace) => void,
): () => void {
  const local = (event: Event) => {
    if (event instanceof CustomEvent && isSavedWorkspace(event.detail)) listener(event.detail);
  };
  window.addEventListener(TOPIC, local);
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(TOPIC);
  } catch {
    /* Local delivery and Git status events remain available. */
  }
  if (channel)
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (isSavedWorkspace(event.data)) listener(event.data);
    });
  return () => {
    window.removeEventListener(TOPIC, local);
    try {
      channel?.close();
    } catch {
      /* Browser policies can restrict cleanup too. */
    }
  };
}
