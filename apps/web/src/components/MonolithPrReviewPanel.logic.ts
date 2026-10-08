import type { MonolithReviewRun } from "@t3tools/contracts";

export function appendMonolithReviewPrompt(existing: string, packageText: string): string {
  return existing.trim() ? `${existing}\n\n${packageText}` : packageText;
}

export function canUseMonolithReviewPackage(run: MonolithReviewRun): boolean {
  return run.status === "completed";
}
