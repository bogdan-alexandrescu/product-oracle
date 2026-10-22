"use client";

import { SegmentedControl } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { versionOf, type Compare } from "./useItemsDiff";

/** "1 new · 1 dropped · 1 moved · 1 changed": the counted changes, the empty ones left out. */
export function changeSummary(summary: Record<string, number>): string {
  const parts = (
    [
      ["added", "new"],
      ["dropped", "dropped"],
      ["moved", "moved"],
      ["changed", "changed"],
    ] as const
  )
    .filter(([k]) => (summary[k] ?? 0) > 0)
    .map(([k, word]) => `${summary[k]} ${word}`);
  return parts.length ? parts.join(" · ") : "no changes";
}

/** The base's name in "Since v1" and "What changed since v1". */
export function baseName(diff: Schemas["ItemsDiffOut"], compare: Compare): string {
  const n = diff.base ? versionOf(diff.base.ref) : "";
  return compare === "approved" ? `approved v${n}` : `v${n}`;
}

/**
 * Above a roadmap version's items (E3): what the table is compared with, the previous
 * version or the approved plan, and what changed since. An option with nothing to compare
 * with is disabled, with a tip saying why.
 */
export function CompareBar({
  diff,
  compare,
  onCompare,
}: {
  diff: Schemas["ItemsDiffOut"];
  compare: Compare;
  onCompare: (c: Compare) => void;
}) {
  const { previous, approved } = diff.options;
  return (
    <div data-testid="items-compare" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-semibold text-text2">Compared with</span>
        <SegmentedControl<Compare>
          label="Compared with"
          size="sm"
          value={compare}
          onChange={onCompare}
          items={[
            previous
              ? { value: "previous", label: `v${versionOf(previous.ref)}`, testId: "compare-previous" }
              : { value: "previous", label: "Previous version", testId: "compare-previous", disabled: true, title: "No earlier version with items" },
            approved
              ? { value: "approved", label: `Approved v${versionOf(approved.ref)}`, testId: "compare-approved" }
              : { value: "approved", label: "Approved plan", testId: "compare-approved", disabled: true, title: "No other approved version yet" },
          ]}
        />
      </div>
      {diff.base && diff.summary && (
        <p data-testid="items-compare-summary" className="tnum text-sm text-text2">
          Since {baseName(diff, compare)}: {changeSummary(diff.summary)}
        </p>
      )}
    </div>
  );
}
