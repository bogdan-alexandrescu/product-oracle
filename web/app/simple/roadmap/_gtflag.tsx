"use client";

import { NOT_IN_GT, NotInGt } from "@/components/simple/FeatureName";
import { named, namedText } from "@/lib/codes";

import type { Item } from "./_lib";

/** QA Nov 12 #1: an item's words, its code before its name (F-06 Weekly alert digest), through lib/codes. */
export const itemName = (i: Pick<Item, "title" | "code">) => namedText(named(i.title, i.code));

/** docs/ground-truth.md: an item with no Ground Truth code is flagged, never hidden (QA Nov 12 #2), by the one shared flag. */
export { NOT_IN_GT, NotInGt };
