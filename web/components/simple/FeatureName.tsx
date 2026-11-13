"use client";
// A feature as Simple's Goal map, Priorities and PRDs name it: its code, then its name (the
// feature panel's own Named); one with no Ground Truth code is flagged, never refused.

import { Named } from "@/app/simple/roadmap/_fields";

/** The flag a feature with no Ground Truth code carries (docs/ground-truth.md). */
export function NotInGt() {
  return (
    <span className="simple-tag ml-1.5 whitespace-nowrap" data-testid="not-in-gt">
      Not in the Ground Truth
    </span>
  );
}

/** "F-12 Alert rules engine"; a name with no code gets the "Not in the Ground Truth" flag. */
export function FeatureName({ item }: { item: { code?: string | null; title: string } }) {
  return (
    <>
      <Named item={{ code: item.code ?? "", title: item.title }} />
      {!item.code && <NotInGt />}
    </>
  );
}
