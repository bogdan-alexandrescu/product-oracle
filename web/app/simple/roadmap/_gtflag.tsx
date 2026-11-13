"use client";

import { Chip } from "@/components/ds";
import { named, namedText } from "@/lib/codes";

import type { Item } from "./_lib";

/** QA Nov 12 #1: an item's words, its code before its name (F-06 Weekly alert digest), through lib/codes. */
export const itemName = (i: Pick<Item, "title" | "code">) => namedText(named(i.title, i.code));

/** docs/ground-truth.md: an item with no Ground Truth code is flagged, never hidden (QA Nov 12 #2). */
export const NOT_IN_GT = "Not in the Ground Truth";

/** The row mark for an item with no code, as the Detailed Ground Truth flags name it. */
export function NotInGt({ item, className = "" }: { item: Pick<Item, "code">; className?: string }) {
  if (item.code) return null;
  return (
    <Chip kind="warn" className={`shrink-0 ${className}`} data-testid="not-in-gt">
      {NOT_IN_GT}
    </Chip>
  );
}
