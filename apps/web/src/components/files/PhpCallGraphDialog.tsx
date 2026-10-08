import { useState } from "react";
import type { MonolithCheckFileResult } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { phpInsightSourceTarget } from "./phpInsightTargets";

type EntryTarget = NonNullable<MonolithCheckFileResult["entryChains"]>["targets"][number];
type Location = EntryTarget["directCallers"][number];
export type PhpGraphSelection = {
  readonly kind: "class" | "method";
  readonly symbol: string;
  readonly targets: readonly EntryTarget[];
};

function GraphLocation({
  location,
  onOpenFile,
}: {
  location: Location;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const target = phpInsightSourceTarget(location);
  const label = `${location.symbol}${location.serviceId ? ` (${location.serviceId})` : ""} · ${location.path}${location.line ? `:${location.line}` : ""}`;
  return target ? (
    <Button variant="link" size="micro" onClick={() => onOpenFile(target.path, target.line)}>
      {label}
    </Button>
  ) : (
    <span>{label}</span>
  );
}

export function PhpCallGraphDialog({
  selection,
  onClose,
  onOpenFile,
  incomplete,
}: {
  selection: PhpGraphSelection | null;
  incomplete: boolean;
  onClose: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const navigate = (path: string, line?: number) => {
    onClose();
    onOpenFile(path, line);
  };
  return (
    <Dialog
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>PHP call graph</DialogTitle>
          <DialogDescription>
            {selection?.symbol}.{" "}
            {selection?.kind === "class" ? "Method calls for this class; " : ""}
            choose a usage or chain step to open its file at the reported line.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4 text-xs">
            {incomplete ? (
              <p role="status" className="text-muted-foreground">
                The available call graph is incomplete. Some calls or service variants could not be
                resolved.
              </p>
            ) : null}
            <p className="text-muted-foreground">
              Based on the available static graph. Class instantiation, dynamic calls and missing
              paths may be unresolved; an empty list does not prove a symbol is unused.
            </p>
            {selection?.targets.map((target) => (
              <GraphMethodGroup
                key={`${selection.kind}:${target.id ?? `${target.symbol}:${target.serviceId ?? ""}`}`}
                target={target}
                initiallyOpen={selection.kind === "method"}
                onOpenFile={navigate}
              />
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function GraphMethodGroup({
  target,
  initiallyOpen,
  onOpenFile,
}: {
  target: EntryTarget;
  initiallyOpen: boolean;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [callerLimit, setCallerLimit] = useState(100);
  const [entryLimit, setEntryLimit] = useState(15);
  return (
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">
        {target.symbol}
        {target.serviceId ? ` (${target.serviceId})` : ""} · {target.directCallers.length} direct
        calls
      </summary>
      {expanded ? (
        <div className="mt-2 space-y-2">
          <h4 className="text-muted-foreground">Direct method usages</h4>
          {target.directCallers.length ? (
            <ul className="space-y-1">
              {target.directCallers.slice(0, callerLimit).map((caller) => (
                <li key={JSON.stringify(caller)}>
                  <GraphLocation location={caller} onOpenFile={onOpenFile} />
                </li>
              ))}
            </ul>
          ) : (
            <p>No direct calls found in the available graph.</p>
          )}
          {target.directCallers.length > callerLimit ? (
            <div>
              <p className="text-muted-foreground">
                Showing {callerLimit} of {target.directCallers.length} usages.
              </p>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setCallerLimit((current) => current + 100)}
              >
                Show more usages
              </Button>
            </div>
          ) : null}
          <h4 className="text-muted-foreground">Entry call chains</h4>
          {target.entries.slice(0, entryLimit).map((entry) => (
            <div key={JSON.stringify(entry)} className="rounded-md border border-border p-2">
              <p className="mb-1 text-muted-foreground">
                {entry.evidence === "call"
                  ? "Method call chain"
                  : "Service wiring; does not prove a method call"}
                {entry.complete ? "" : " · incomplete"}
              </p>
              <ol className="space-y-1" aria-label={`Call chain to ${target.symbol}`}>
                {entry.chain.map((step, index) => (
                  <li
                    key={JSON.stringify(entry.chain.slice(0, index + 1))}
                    className="flex items-start gap-1"
                  >
                    <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                      {index === 0 ? "●" : "↳"}
                    </span>
                    <GraphLocation location={step} onOpenFile={onOpenFile} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {target.entries.length > entryLimit ? (
            <div>
              <p className="text-muted-foreground">
                Showing {entryLimit} of {target.entries.length} entry chains.
              </p>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setEntryLimit((current) => current + 15)}
              >
                Show more chains
              </Button>
            </div>
          ) : null}
          {!target.entries.length ? <p>No entry chain found in the available graph.</p> : null}
          {target.unknown.length ? (
            <p className="text-muted-foreground">Unresolved: {target.unknown.join("; ")}</p>
          ) : null}
          {target.cycles?.length ? (
            <p className="text-muted-foreground">Recursive paths: {target.cycles.join("; ")}</p>
          ) : null}
          {target.truncated ? (
            <p className="text-muted-foreground">
              Additional paths were omitted by the graph limit.
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
