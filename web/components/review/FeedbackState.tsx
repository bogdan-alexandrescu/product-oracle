"use client";

import { Chip, type ChipKind } from "@/components/ds";
import type { FeedbackItem } from "@/lib/api/client";

const KIND: Record<FeedbackItem["state"], ChipKind> = {
  open: "acc",
  staged: "now",
  declined: "na",
  done: "pass",
};

/**
 * C1e: where a feedback item stands: Open, Accepted · staged for draft N+1, Declined, or
 * Addressed in vN (Superseded for an item a later verdict replaced).
 */
export function FeedbackStateChip({ item }: { item: FeedbackItem }) {
  const state = item.state ?? "open";
  const label =
    state === "staged"
      ? `Accepted · staged for draft ${item.staged_for_version ?? "next"}`
      : state === "declined"
        ? "Declined"
        : state === "done"
          ? item.status === "superseded"
            ? "Superseded"
            : item.addressed_in_version != null
              ? `Addressed in v${item.addressed_in_version}`
              : "Addressed"
          : "Open";
  return (
    <span data-testid="feedback-state" data-state={state} className="inline-flex">
      <Chip kind={KIND[state]}>{label}</Chip>
    </span>
  );
}
