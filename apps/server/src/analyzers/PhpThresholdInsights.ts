import {
  MonolithDoctrineQueryThresholdsSource,
  MonolithEffectiveDoctrineQueryThresholds,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const Report = Schema.Struct({
  thresholds: Schema.optional(MonolithEffectiveDoctrineQueryThresholds),
  source: MonolithDoctrineQueryThresholdsSource,
});
const decode = Schema.decodeUnknownSync(Report);
export function normalizePhpThresholdInsights(value: unknown) {
  const report = decode(value);
  if ((report.source.kind === "unresolved") === (report.thresholds !== undefined))
    throw new Error("Threshold provenance does not match its resolved values.");
  return {
    ...(report.thresholds === undefined ? {} : { doctrineQueryThresholds: report.thresholds }),
    doctrineQueryThresholdsSource: report.source,
  };
}
