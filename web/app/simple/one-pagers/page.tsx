"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { NewPrdButton, NewPrdSheet, StartedRows, useCanStartPrd, useStartedPrds } from "@/components/simple/NewPrd";
import { PrdStatus } from "@/components/simple/PrdStatus";
import { dmy } from "@/components/simple/PrdTimeline";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone, dayIn } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";
import { RebuildSign } from "@/components/RebuildSign";
import { ArchivedPrds, MK_TODAY, MoreMenu, mkSet, PrdConfirm, PrdNote, prdDoneWords, setPrdNote, useMk, useMkStore, usePrdAccess } from "@/components/simple/MkEditGoalsPrds"; // MOCK-HOOK
import { MK_MORE_PRDS } from "@/lib/api/mock/mk-edit-goals-prds"; // MOCK-HOOK

/** One-pagers (#723 S1): the PRDs I may read (the API lists only those), each opening its one-pager. */
export default function OnePagers() {
  const q = useQuery("simple|one-pagers", () => unwrap(api.GET("/v1/simple/one-pagers")));
  const zone = useCompanyZone();
  const canStartPrd = useCanStartPrd();
  const [newPrd, setNewPrd] = useState(false);
  const closeNewPrd = useCallback(() => setNewPrd(false), []);
  const started = useStartedPrds(canStartPrd);
  const mine = started.data ?? [];
  // qa-simple-prd-p3-30: newest first, by when each last changed (and the list says so).
  const ep = useMk("ep"); // MOCK-HOOK
  const mk = useMkStore(); // MOCK-HOOK
  const access = usePrdAccess(); // MOCK-HOOK
  const [ask, setAsk] = useState<{ slugs: string[]; titles: string[]; verb: "archive" | "delete" } | null>(null); // MOCK-HOOK
  const [picked, setPicked] = useState<string[] | null>(null); // MOCK-HOOK
  const mkHidden = new Set([...mk.prdGone, ...mk.prdArchived.map((x) => x.slug)]); // MOCK-HOOK
  const all = q.data && ep && q.data.length ? [...q.data, ...MK_MORE_PRDS.map((x) => ({ ...q.data![0], ...x, id: x.slug, status: x.status as (typeof q.data)[0]["status"] }))] : q.data; // MOCK-HOOK
  const rows = all ? [...all].filter((d) => !mkHidden.has(d.slug)).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)) : null; // MOCK-HOOK
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
            {ep === "c" && access !== "read" && rows && rows.length > 0 && (picked ? <button type="button" className="simple-small font-semibold underline" onClick={() => setPicked(null)}>Done</button> : <button type="button" data-testid="mk-select" className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-[15px] font-semibold hover:bg-surface2" onClick={() => setPicked([])}>Select</button>)} {/* MOCK-HOOK */}
            {canStartPrd && <NewPrdButton primary onOpen={() => setNewPrd(true)} />}
          </span>
        }
      >
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
          <>
          <PrdNote /> {/* MOCK-HOOK */}
          {picked && ( // MOCK-HOOK
            <div data-testid="mk-select-bar" className="sticky top-2 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-[15px]"> {/* MOCK-HOOK */}
              <strong className="mr-auto">{picked.length ? `${picked.length} selected` : "Pick PRDs"}</strong> {/* MOCK-HOOK */}
              <button type="button" disabled={!picked.length} className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 font-semibold disabled:opacity-50" onClick={() => setAsk({ slugs: picked, titles: picked.map((x) => rows.find((r) => r.slug === x)?.title ?? x), verb: "archive" })}>{access === "propose" ? "Ask to archive" : "Archive"}</button> {/* MOCK-HOOK */}
              <button type="button" disabled={!picked.length} className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 font-semibold text-warn disabled:opacity-50" onClick={() => setAsk({ slugs: picked, titles: picked.map((x) => rows.find((r) => r.slug === x)?.title ?? x), verb: "delete" })}>{access === "propose" ? "Ask to delete" : "Delete"}</button> {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
          <ul className="flex flex-col">
            <StartedRows started={mine} />
            {rows.map((d) => (
              <li key={d.id} data-testid="one-pager-row" className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0 hover:bg-bg/50">
                {picked && <input type="checkbox" aria-label={`Select ${d.title}`} checked={picked.includes(d.slug)} onChange={(e) => setPicked((x) => (e.target.checked ? [...(x ?? []), d.slug] : (x ?? []).filter((y) => y !== d.slug)))} className="relative z-[2] h-5 w-5 accent-[var(--accent)]" />} {/* MOCK-HOOK */}
                <Link href={`/simple/one-pagers/${d.slug}`} className="min-w-0 font-semibold break-words after:absolute after:inset-0 after:content-[''] hover:underline">
                  {d.title}
                </Link>
                <PrdStatus d={d} />
                <span className="relative z-[1]">
                  <RebuildSign slug={d.slug} compact />
                </span>
                <span className="simple-small ml-auto">Updated {dmy(dayIn(d.updated_at, zone))}</span>
                {ep === "a" && access !== "read" && <MoreMenu label={`More for ${d.title}`} testId="mk-row-menu" items={[{ label: access === "propose" ? "Ask to archive" : "Archive PRD", onClick: () => setAsk({ slugs: [d.slug], titles: [d.title], verb: "archive" }) }, { label: access === "propose" ? "Ask to delete" : "Delete PRD", warn: true, onClick: () => setAsk({ slugs: [d.slug], titles: [d.title], verb: "delete" }) }]} />} {/* MOCK-HOOK */}
              </li>
            ))}
          </ul>
          {ep && <ArchivedPrds access={access} fold={ep !== "b"} />} {/* MOCK-HOOK */}
          </>
        )}
      </SimpleSection>
      {ask && access !== "read" && ( // MOCK-HOOK
        <PrdConfirm {...ask} access={access} onClose={() => setAsk(null)} onDone={(keep) => { setAsk(null); setPicked(null); setPrdNote(prdDoneWords(ask.titles, ask.slugs, ask.verb, keep, access)); if (access === "change") mkSet((x) => (ask.verb === "archive" ? { ...x, prdArchived: [...ask.slugs.map((sl, i) => ({ slug: sl, title: ask.titles[i], archived: MK_TODAY })), ...x.prdArchived] } : { ...x, prdGone: [...x.prdGone, ...ask.slugs] })); }} /> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      {newPrd && <NewPrdSheet onClose={closeNewPrd} onStarted={() => void started.reload()} />}
    </SimplePage>
  );
}
