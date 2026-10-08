import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { DetachedFileViewer } from "~/components/files/DetachedFileViewer";

export const Route = createFileRoute("/detached-files")({
  validateSearch: (search: Record<string, unknown>) => ({
    environmentId: EnvironmentId.make(
      typeof search.environmentId === "string" && search.environmentId.trim().length > 0
        ? search.environmentId.trim()
        : "detached-missing-environment",
    ),
    threadId: ThreadId.make(
      typeof search.threadId === "string" && search.threadId.trim().length > 0
        ? search.threadId.trim()
        : "detached-missing-thread",
    ),
  }),
  component: DetachedFilesRoute,
});

function DetachedFilesRoute() {
  const search = Route.useSearch();
  return <DetachedFileViewer {...search} />;
}
