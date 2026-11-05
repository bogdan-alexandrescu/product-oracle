"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { NewPrdButton, NewPrdSheet, StartedRows, useCanStartPrd, useStartedPrds } from "@/components/simple/NewPrd";
import { PrdMenu, restorePrd } from "@/components/simple/PrdMenu";
import { PrdStatus } from "@/components/simple/PrdStatus";
import { dmy } from "@/components/simple/PrdTimeline";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useCompanyZone, dayIn } from "@/lib/dates";
import { errorMessage, useQuery } from "@/lib/use-query";
import { RebuildSign } from "@/components/RebuildSign";

/** One-pagers (#723 S1): the PRDs I may read (the API lists only those), each opening its one-pager. */
export default function OnePagers() {
  const q = useQuery("simple|one-pagers", () => unwrap(api.GET("/v1/simple/one-pagers")));
  const zone = useCompanyZone();
  const canStartPrd = useCanStartPrd();
  const [newPrd, setNewPrd] = useState(false);
  const closeNewPrd = useCallback(() => setNewPrd(false), []);
  const started = useStartedPrds(canStartPrd);
  const mine = started.data ?? [];
  // EP2 a (ep2-a-result): what a delete did, with Undo, at the top of the list.
  const [note, setNote] = useState<{ text: string; entry?: Schemas["TrashEntryOut"] } | null>(null);
  const reload = q.reload;
  const undo = useCallback(
    async (entry: Schemas["TrashEntryOut"]) => {
      try {
        await restorePrd(entry);
        setNote({ text: `Restored ${entry.root.title}.` });
      } catch (e) {
        setNote({ text: errorMessage(e) });
      }
      await reload();
    },
    [reload],
  );
  // qa-simple-prd-p3-30: newest first, by when each last changed (and the list says so).
  const rows = q.data ? [...q.data].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)) : null;
  return (
    // qa4-simple-prd-25: a help line, saying what a person can do here.
    <SimplePage title="One-pagers" lead="Open a PRD to read it on one page, change its wording or start a review.">
      <SimpleSection
        title="PRDs"
        testId="simple-one-pagers"
        action={
          // NP1: New PRD beside "Newest first", opening the guided sheet.
          <span className="flex flex-wrap items-center gap-3">
            {rows && rows.length + mine.length > 1 ? <span className="simple-small" data-testid="one-pagers-order">Newest first</span> : null}
            {canStartPrd && <NewPrdButton primary onOpen={() => setNewPrd(true)} />}
          </span>
        }
      >
        {note && (
          <div role="status" data-testid="one-pagers-note" className="mb-2 flex items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5 text-[15px] text-text">
            <span className="min-w-0 flex-1">{note.text}</span>
            {note.entry && (
              <button type="button" className="flex-none font-[650] text-accent-ink underline" onClick={() => note.entry && void undo(note.entry)}>
                Undo
              </button>
            )}
          </div>
        )}
        {q.error ? (
          <p className="simple-small">{q.error}</p>
        ) : !rows ? (
          <Loading />
        ) : rows.length === 0 && mine.length === 0 ? (
          // qa-simple-prd-41: what a one-pager comes from, and where to start one.
          <SimpleEmpty testId="simple-one-pagers-empty">
            No PRDs yet. A one-pager is made from a PRD: start one in{" "}
            <Link href="/documents" className="font-semibold text-accent-ink underline">Detailed › PRDs</Link>, and its one-pager shows here.
          </SimpleEmpty>
        ) : (
          // qa-simple-prd-42: the status sits beside its title, rows are ruled, each says when it changed.
          // qa-simple-prd-p3-29: the whole row opens the one-pager, as its hover says: the title's
          // link stretches over the row (one link still, its name the title).
          <ul className="flex flex-col">
            <StartedRows started={mine} />
            {rows.map((d) => (
              <li key={d.id} data-testid="one-pager-row" className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0 hover:bg-bg/50">
                <Link href={`/simple/one-pagers/${d.slug}`} className="min-w-0 font-semibold break-words after:absolute after:inset-0 after:content-[''] hover:underline">
                  {d.title}
                </Link>
                <PrdStatus d={d} />
                <span className="relative z-[1]">
                  <RebuildSign slug={d.slug} compact />
                </span>
                <span className="simple-small ml-auto">Updated {dmy(dayIn(d.updated_at, zone))}</span>
                <PrdMenu
                  doc={d}
                  onDeleted={(entry) => {
                    setNote({ text: `Deleted ${d.title}. It is in Settings > Trash for 30 days.`, entry });
                    void reload();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>
      {newPrd && <NewPrdSheet onClose={closeNewPrd} onStarted={() => void started.reload()} />}
    </SimplePage>
  );
}
