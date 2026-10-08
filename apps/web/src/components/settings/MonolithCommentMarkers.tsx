import type { MonolithCommentMarker } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DEFAULT_COMMENT_MARKERS } from "./MonolithAreasPanel.logic";

const LEVELS = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
  { value: "reference", label: "Reference" },
] as const;

export function MonolithCommentMarkers({
  markers,
  disabled,
  areaLabel,
  onChange,
}: {
  readonly markers: readonly MonolithCommentMarker[] | undefined;
  readonly disabled: boolean;
  readonly areaLabel: string;
  readonly onChange: (markers: readonly MonolithCommentMarker[] | undefined) => void;
}) {
  const rules = markers ?? DEFAULT_COMMENT_MARKERS;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">Comment hints · {rules.length} markers</summary>
      <div className="mt-2 space-y-2">
        <p className="text-muted-foreground">
          Highlight direct usages and implemented declarations with comments attached to PHP
          symbols. An empty list disables comment hints for this area.
        </p>
        {rules.map((rule, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Editable marker text is not a stable identity; rows have no reorder control.
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-2">
            <Input
              size="sm"
              font="mono"
              disabled={disabled}
              maxLength={128}
              value={rule.marker}
              aria-label={`${areaLabel} comment marker ${index + 1}`}
              onChange={(event) => {
                const marker = event.currentTarget.value;
                onChange(
                  rules.map((entry, position) =>
                    position === index ? { ...entry, marker } : entry,
                  ),
                );
              }}
            />
            <Select
              value={rule.severity}
              items={LEVELS}
              disabled={disabled}
              onValueChange={(severity) => {
                if (
                  severity === "info" ||
                  severity === "warning" ||
                  severity === "error" ||
                  severity === "reference"
                )
                  onChange(
                    rules.map((entry, position) =>
                      position === index ? { ...entry, severity } : entry,
                    ),
                  );
              }}
            >
              <SelectTrigger size="sm" aria-label={`${areaLabel} comment level ${index + 1}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {LEVELS.map((level) => (
                  <SelectItem key={level.value} value={level.value}>
                    {level.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={disabled}
              aria-label={`${areaLabel} remove comment marker ${index + 1}`}
              onClick={() => onChange(rules.filter((_, position) => position !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || rules.length >= 32}
            onClick={() => onChange([...rules, { marker: "", severity: "info" }])}
          >
            Add marker
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || markers === undefined}
            onClick={() => onChange(undefined)}
          >
            Use default markers
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || rules.length === 0}
            onClick={() => onChange([])}
          >
            Disable comment hints
          </Button>
        </div>
      </div>
    </details>
  );
}
