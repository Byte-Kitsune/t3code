import type { ProjectCloneSnapshot } from "@t3tools/contracts";

const normalizeDirectory = (directory: string) =>
  directory.replaceAll("\\", "/").replace(/\/+$/, "");

/** An empty subscription before its first snapshot does not establish clone completion. */
export function monolithCloneReady(input: {
  readonly tracked: boolean;
  readonly streamReady: boolean;
  readonly clones: readonly ProjectCloneSnapshot[] | null;
  readonly cwd: string | null;
}): boolean {
  if (!input.tracked) return true;
  if (!input.streamReady) return false;
  if (input.cwd === null) return true;
  const cwd = normalizeDirectory(input.cwd);
  return !input.clones?.some((clone) => {
    const destination = normalizeDirectory(clone.destinationPath);
    return clone.phase !== "done" && (cwd === destination || cwd.startsWith(`${destination}/`));
  });
}
