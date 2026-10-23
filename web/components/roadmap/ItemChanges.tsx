"use client";

import { Chip, InspectorSection } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { horizonLabel } from "./item-row";
import { changeChips, changeLine, type ItemChange } from "./useItemsDiff";

/** At most two change chips, then "+N" (E3 Change column). */
export function ChangeChips({ change }: { change?: ItemChange }) {
  if (!change) return null;
  const chips = changeChips(change);
  if (!chips.length) return <span className="text-text2">—</span>;
  return (
    <span data-testid="item-change" data-change={change.change} className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {chips.slice(0, 2).map((c) => (
        <Chip key={c.label} kind={c.kind}>
          {c.label}
        </Chip>
      ))}
      {chips.length > 2 && <Chip kind="line">+{chips.length - 2}</Chip>}
    </span>
  );
}

/** The inspector's "What changed since …" (E3): one line per field, then the notes. */
export function WhatChanged({ change, since, titles }: { change: ItemChange; since: string; titles: ReadonlyMap<string, string> }) {
  return (
    <InspectorSection label={`What changed since ${since}`} testId="item-what-changed">
      <ul className="flex flex-col gap-1 text-[15px]">
        {change.change === "added" && <li>New since {since}</li>}
        {change.change === "dropped" && <li>Dropped since {since}</li>}
        {change.change === "unchanged" && !change.notes.length && <li>No change</li>}
        {change.fields.map((f) => (
          <li key={f.field}>{changeLine(f, titles)}</li>
        ))}
        {change.notes.map((f) => (
          <li key={`note-${f.field}`} className="text-text2">
            {changeLine(f, titles)}
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

/** The inspector's History (E3): "Draft v1 · Next", "Roadmap v1 · Now · approved", "Draft v3 · dropped", newest last. */
export function ItemHistory({ history }: { history: Schemas["RoadmapItemHistoryOut"] | null | undefined }) {
  if (!history?.entries.length) return null;
  return (
    <InspectorSection label="History" testId="item-history">
      <ol className="flex flex-col gap-1 text-[15px]">
        {history.entries.map((e) => (
          <li key={e.ref}>
            {e.present ? `${e.label} · ${horizonLabel(e.horizon ?? "")}${e.approved ? " · approved" : ""}` : `${e.label} · dropped`}
          </li>
        ))}
      </ol>
    </InspectorSection>
  );
}
