"use client";
// MOCK-HOOK: the whole file is mk-runplan mock-up code (never merged). RP1 = how a run's new
// features get ranked (?rp1=a|b|c|d); RP2 = where a not-yet-approved PRD's dated items show in
// Simple (?rp2=a|b|c|d). State switches: &open=1, &phase=mid, &done=1, &step=1, &sel=<key>.

import { useSearchParams } from "next/navigation"; // MOCK-HOOK
import { useState, type CSSProperties, type ReactNode } from "react"; // MOCK-HOOK

import { Button, Chip, Icon, Notice, Panel } from "@/components/ds"; // MOCK-HOOK
import type { Schemas } from "@/lib/api/client"; // MOCK-HOOK
import { MK_DRAFT_ITEMS, MK_MERGED_ORDER, MK_NEW_FEATURES, MK_PRD, MK_PRD_RP1, MK_RANGE, type MkDraftItem, type MkNewFeature } from "@/lib/api/mock/mk-runplan"; // MOCK-HOOK

type RankedFeature = Schemas["RankedFeature"]; // MOCK-HOOK

export type Mk = { rp1: string | null; rp2: string | null; open: boolean; mid: boolean; done: boolean; step: number | null; sel: string | null }; // MOCK-HOOK

/** The mock-up switches from the URL. */
export function useMk(): Mk { // MOCK-HOOK
  const q = useSearchParams(); // MOCK-HOOK
  const step = q.get("step"); // MOCK-HOOK
  return { rp1: q.get("rp1"), rp2: q.get("rp2"), open: q.get("open") === "1", mid: q.get("phase") === "mid", done: q.get("done") === "1", step: step ? Number(step) : null, sel: q.get("sel") }; // MOCK-HOOK
} // MOCK-HOOK

export const isNew = (key: string) => key.startsWith("N-"); // MOCK-HOOK

/** A new feature as a row of the order, scored from the run's feature set. */
function asRow(n: MkNewFeature, rank: number | null, method: RankedFeature["explanation"]["method"]): RankedFeature { // MOCK-HOOK
  return { // MOCK-HOOK
    rank: rank ?? 0, score_rank: rank ?? 0, entity_id: "", key: n.key, title: n.title, status: "proposed", score: rank == null ? null : n.score, serves_goal: true, flags: [], depends_on: n.depends ? [n.depends] : [], dependents: [], // MOCK-HOOK
    explanation: { // MOCK-HOOK
      method, formula: "goal weight × contribution × confidence ÷ effort", inputs: {}, // MOCK-HOOK
      confidence: { value: rank == null ? 0 : n.confidence, source: "default", explain: rank == null ? "Not scored: not in the baseline yet." : `From the run's feature set: ${n.why}`, evidence: [] }, // MOCK-HOOK
      goals: [{ goal: n.goal, title: n.goalTitle, weight: 3, contribution: 2 } as never], missing: [], steps: rank == null ? [] : [`score from the run's feature set = ${n.score}`], order: [], // MOCK-HOOK
    }, // MOCK-HOOK
    run_explanation: rank == null ? null : `New in this PRD. ${n.why}`, // MOCK-HOOK
  }; // MOCK-HOOK
} // MOCK-HOOK

/** True when the order shows the new features ranked among the baseline's. */
export function mergedShown(mk: Mk): boolean { // MOCK-HOOK
  return mk.rp1 === "a" || (mk.done && (mk.rp1 === "b" || mk.rp1 === "c" || mk.rp1 === "d")); // MOCK-HOOK
} // MOCK-HOOK

/** The rows of the run's order for each proposal: merged, or the baseline's only. */
export function mkRows(rows: RankedFeature[] | undefined, mk: Mk, method: RankedFeature["explanation"]["method"]): RankedFeature[] | undefined { // MOCK-HOOK
  if (!rows || !mk.rp1) return rows; // MOCK-HOOK
  if (!mergedShown(mk)) return rows; // MOCK-HOOK
  const byKey = new Map(rows.map((r) => [r.key, r])); // MOCK-HOOK
  return MK_MERGED_ORDER.filter((k) => !(mk.rp1 === "b" && k === "N-6")).map((k, i) => { // MOCK-HOOK: b left one out
    const n = MK_NEW_FEATURES.find((x) => x.key === k); // MOCK-HOOK
    return n ? asRow(n, i + 1, method) : { ...(byKey.get(k) ?? rows[0]!), rank: i + 1 }; // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK

/** The "New in this PRD" chip on a merged row. */
export function NewChip({ k }: { k: string }) { // MOCK-HOOK
  if (!isNew(k)) return null; // MOCK-HOOK
  return <Chip kind="acc" title="Not in the baseline yet: proposed by this PRD's run">New in this PRD</Chip>; // MOCK-HOOK
} // MOCK-HOOK

const N = MK_NEW_FEATURES.length; // MOCK-HOOK

/**
 * The order stop's band additions: RP1 b's "accept first" gate, a's and c's results.
 * Returns whether Approve order is held.
 */
export function mkApproveHeld(mk: Mk): string | null { // MOCK-HOOK
  if (mk.rp1 === "b" && !mk.done) return `Accept or leave out this PRD's ${N} new features first.`; // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK

export function MkOrderNotes({ mk }: { mk: Mk }) { // MOCK-HOOK
  const [picked, setPicked] = useState<Set<string>>(() => new Set(mk.mid ? ["N-1", "N-2", "N-3", "N-4", "N-5"] : MK_NEW_FEATURES.map((n) => n.key))); // MOCK-HOOK
  if (mk.rp1 === "a") // MOCK-HOOK
    return ( // MOCK-HOOK
      <Notice tone={mk.done ? "pass" : "info"}> {/* MOCK-HOOK */}
        {mk.done // MOCK-HOOK
          ? `Order approved. The ${N} new features joined the baseline as proposed, at the ranks you approved.` // MOCK-HOOK
          : `This order ranks the ${N} features ${MK_PRD_RP1.title} adds, scored from the run's feature set. Approving the order adds them to the baseline as proposed.`} {/* MOCK-HOOK */}
      </Notice> // MOCK-HOOK
    ); // MOCK-HOOK
  if (mk.rp1 === "b" && mk.done) return <Notice tone="pass">{`5 new features accepted into the baseline and ranked below. Address labels and notes was left out.`}</Notice>; // MOCK-HOOK
  if (mk.rp1 === "b") // MOCK-HOOK
    return ( // MOCK-HOOK
      <section aria-label="New features to accept" className="rounded-panel border border-warn bg-warn-bg px-4 py-3"> {/* MOCK-HOOK */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5"> {/* MOCK-HOOK */}
          <Icon name="alert" size={16} className="text-warn" /> {/* MOCK-HOOK */}
          <span className="min-w-0 font-semibold">{`${MK_PRD_RP1.title} adds ${N} features the baseline does not have. Accept them to rank them in this order.`}</span> {/* MOCK-HOOK */}
          <span className="flex-1" /> {/* MOCK-HOOK */}
          {!mk.open && <Button variant="primary" icon="check">{`Review ${N} new features`}</Button>} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
        {mk.open && ( // MOCK-HOOK
          <div className="mt-3 rounded-panel border border-line bg-surface"> {/* MOCK-HOOK */}
            <ul className="divide-y divide-line"> {/* MOCK-HOOK */}
              {MK_NEW_FEATURES.map((n) => ( // MOCK-HOOK
                <li key={n.key} className="flex items-start gap-3 px-3 py-2"> {/* MOCK-HOOK */}
                  <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" aria-label={`Accept ${n.title}`} checked={picked.has(n.key)} onChange={() => setPicked((s) => { const t = new Set(s); if (t.has(n.key)) t.delete(n.key); else t.add(n.key); return t; })} /> {/* MOCK-HOOK */}
                  <span className="min-w-0 flex-1"> {/* MOCK-HOOK */}
                    <span className="block font-medium break-words">{n.title}</span> {/* MOCK-HOOK */}
                    <span className="block text-sm text-text2">{`${n.goalTitle} · ${n.reach} · ${n.why}`}</span> {/* MOCK-HOOK */}
                  </span> {/* MOCK-HOOK */}
                  {!picked.has(n.key) && <Chip kind="na">Left out</Chip>} {/* MOCK-HOOK */}
                </li> // MOCK-HOOK
              ))} {/* MOCK-HOOK */}
            </ul> {/* MOCK-HOOK */}
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5"> {/* MOCK-HOOK */}
              <Button variant="primary" icon="check">{`Accept ${picked.size} and rank them`}</Button> {/* MOCK-HOOK */}
              <Button>Cancel</Button> {/* MOCK-HOOK */}
              <span className="text-sm text-text2">{`Accepted features join the baseline as proposed; the run re-scores the order with them.${picked.size < N ? ` ${N - picked.size} left out stay in the PRD only.` : ""}`}</span> {/* MOCK-HOOK */}
            </div> {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
      </section> // MOCK-HOOK
    ); // MOCK-HOOK
  if (mk.rp1 === "c" && mk.done) return <Notice tone="pass">{`${N} new features ranked into this order. They stay proposed in the baseline until the PRD is approved.`}</Notice>; // MOCK-HOOK
  if (mk.rp1 === "d" && mk.done) return <Notice tone="info">{`${MK_PRD_RP1.title} was approved on Nov 20: its ${N} features joined the baseline, and this new order ranks them.`}</Notice>; // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK

/** RP1 c's "Proposed by this PRD" group and d's plain "Not ranked yet" group, under the order. */
export function MkProposedGroup({ mk }: { mk: Mk }) { // MOCK-HOOK
  if ((mk.rp1 !== "c" && mk.rp1 !== "d") || mk.done) return null; // MOCK-HOOK
  const c = mk.rp1 === "c"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <Panel // MOCK-HOOK
      title={c ? "Proposed by this PRD" : "Not ranked yet"} // MOCK-HOOK
      count={<span className="tnum text-text2">{N}</span>} // MOCK-HOOK
      tools={c && !mk.open ? <Button variant="primary" icon="flag">Rank them</Button> : undefined} // MOCK-HOOK
    > {/* MOCK-HOOK */}
      <p className="border-b border-line px-4 py-2.5 text-sm text-text2"> {/* MOCK-HOOK */}
        {c // MOCK-HOOK
          ? `New in ${MK_PRD_RP1.title}: not in the baseline, so the order above leaves them out. Rank them to score them from the run's feature set and place them in this order.` // MOCK-HOOK
          : `New in ${MK_PRD_RP1.title}. They are ranked once the PRD is approved and they join the baseline; until then this order ranks the baseline's features only.`} {/* MOCK-HOOK */}
      </p> {/* MOCK-HOOK */}
      {c && mk.open && ( // MOCK-HOOK
        <div className="border-b border-line bg-accent-soft px-4 py-3"> {/* MOCK-HOOK */}
          <p className="font-semibold">{mk.mid ? `Scoring ${N} features from the run's feature set…` : `Rank ${N} new features into this order?`}</p> {/* MOCK-HOOK */}
          <p className="mt-1 text-sm text-text2">They get a score and a rank here; in the baseline they stay proposed until the PRD is approved. The order must be approved again.</p> {/* MOCK-HOOK */}
          <div className="mt-2 flex gap-2"> {/* MOCK-HOOK */}
            <Button variant="primary" icon="flag" disabled={mk.mid}>{mk.mid ? "Ranking…" : "Rank them"}</Button> {/* MOCK-HOOK */}
            <Button disabled={mk.mid}>Cancel</Button> {/* MOCK-HOOK */}
          </div> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      <ul className="divide-y divide-line"> {/* MOCK-HOOK */}
        {MK_NEW_FEATURES.map((n) => ( // MOCK-HOOK
          <li key={n.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2"> {/* MOCK-HOOK */}
            <span className="w-11 text-text2">—</span> {/* MOCK-HOOK */}
            <span className="min-w-0 flex-1 font-medium break-words">{n.title}</span> {/* MOCK-HOOK */}
            <Chip kind="line">{n.goalTitle}</Chip> {/* MOCK-HOOK */}
            <span className="w-32 text-sm text-text2">{c ? "Not scored" : "After approval"}</span> {/* MOCK-HOOK */}
          </li> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </ul> {/* MOCK-HOOK */}
    </Panel> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// ---- RP2: the run's draft roadmap (dated items, not approved) in Simple ---- // MOCK-HOOK

const t0 = Date.parse(MK_RANGE.start); // MOCK-HOOK
const t1 = Date.parse(MK_RANGE.end); // MOCK-HOOK
const at = (d: string) => ((Date.parse(d) - t0) / (t1 - t0)) * 100; // MOCK-HOOK
const MONTHS = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"]; // MOCK-HOOK
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); // MOCK-HOOK

/** The hatch every draft bar wears. */
export const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 28%, transparent) 0 6px, transparent 6px 12px)", border: "1.5px dashed var(--accent)" }; // MOCK-HOOK

/** A small timeline of the draft's items: hatched bars over the months. */
export function MkDraftBars({ items = MK_DRAFT_ITEMS, solid = false, picked, label }: { items?: MkDraftItem[]; solid?: boolean; picked?: string | null; label?: string }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <div aria-label={label ?? "Draft dates"} className="min-w-0"> {/* MOCK-HOOK */}
      <div className="grid grid-cols-7 border-b border-line text-[13px] text-text2"> {/* MOCK-HOOK */}
        {MONTHS.map((m) => <span key={m} className="border-l border-line px-1.5 py-1 first:border-l-0">{m}</span>)} {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
      <div className="relative py-1"> {/* MOCK-HOOK */}
        {items.map((i) => ( // MOCK-HOOK
          <div key={i.key} className="relative h-9"> {/* MOCK-HOOK */}
            <div // MOCK-HOOK
              data-item={i.key} // MOCK-HOOK
              title={`${i.title}: ${day(i.start)} – ${day(i.end)}${solid ? "" : " (draft, not approved)"}`} // MOCK-HOOK
              className={`absolute top-1 flex h-7 items-center overflow-hidden rounded px-2 text-[13px] font-medium whitespace-nowrap ${solid ? "bg-accent text-on-accent" : "text-text"} ${picked === i.key ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`} // MOCK-HOOK
              style={{ left: `${at(i.start)}%`, width: `${at(i.end) - at(i.start)}%`, ...(solid ? {} : HATCH) }} // MOCK-HOOK
            > {/* MOCK-HOOK */}
              <span className="truncate">{i.title}</span> {/* MOCK-HOOK */}
            </div> {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** The legend chip for a draft: a hatched swatch and its words. */
export function DraftKey({ children }: { children: ReactNode }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="inline-flex items-center gap-1.5 text-[15px] text-text2"> {/* MOCK-HOOK */}
      <span aria-hidden className="inline-block h-3.5 w-6 rounded-sm" style={HATCH} /> {/* MOCK-HOOK */}
      {children} {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** A draft item's card when its bar is picked. */
function DraftCard({ item, where }: { item: MkDraftItem; where: "roadmap" | "one-pager" }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <div role="dialog" aria-label={item.title} className="simple-card mt-3 max-w-[460px] border-accent"> {/* MOCK-HOOK */}
      <div className="flex items-center gap-2"><strong className="text-lg">{item.title}</strong><span className="rounded-full border border-accent px-2 text-sm text-accent-ink">Draft</span></div> {/* MOCK-HOOK */}
      <p className="mt-1 text-base">{`${day(item.start)} – ${day(item.end)} · ${item.owner}`}</p> {/* MOCK-HOOK */}
      <p className="mt-1 simple-small">{`Dates from ${MK_PRD.title}'s run (engineering dates). Not approved: ${where === "roadmap" ? "it joins the roadmap" : "it goes on the roadmap"} when the PRD is approved.`}</p> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** RP2 on the Simple roadmap page (a: draft layer; b/c: nothing; d: said plainly). */
export function MkRoadmapDraft({ mk, phone }: { mk: Mk; phone: boolean }) { // MOCK-HOOK
  if (mk.rp2 === "d") // MOCK-HOOK
    return mk.done ? ( // MOCK-HOOK
      <p className="simple-small" role="status">{`${MK_PRD.title} was approved: its ${MK_DRAFT_ITEMS.length} items are on the roadmap.`}</p> // MOCK-HOOK
    ) : ( // MOCK-HOOK
      <p className="simple-small flex flex-wrap items-center gap-2" role="note"><Icon name="clock" size={16} />{`${MK_PRD.title} is not approved yet: its ${MK_DRAFT_ITEMS.length} dated items show here once it is.`}</p> // MOCK-HOOK
    ); // MOCK-HOOK
  if (mk.rp2 !== "a") return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <section aria-label="Draft plans" className="simple-card"> {/* MOCK-HOOK */}
      {mk.done && <p className="simple-small mb-2" role="status">{`Showing ${MK_PRD.title} only: its ${MK_DRAFT_ITEMS.length} items are a draft, hatched until the PRD is approved. Nothing of it is on the approved roadmap yet.`}</p>} {/* MOCK-HOOK */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2"> {/* MOCK-HOOK */}
        <h2 className="simple-h2">{`${MK_PRD.title} · draft`}</h2> {/* MOCK-HOOK */}
        <DraftKey>Not approved yet</DraftKey> {/* MOCK-HOOK */}
        <span className="flex-1" /> {/* MOCK-HOOK */}
        <label className="inline-flex items-center gap-2 text-base"><input type="checkbox" defaultChecked className="size-4 accent-[var(--accent)]" />Show drafts</label> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
      {phone ? ( // MOCK-HOOK
        <ul className="mt-2 divide-y divide-line"> {/* MOCK-HOOK */}
          {MK_DRAFT_ITEMS.map((i) => ( // MOCK-HOOK
            <li key={i.key} className="flex items-center gap-2 py-2"><span aria-hidden className="h-5 w-2 flex-none rounded-sm" style={HATCH} /><span className="min-w-0 flex-1"><strong className="block">{i.title}</strong><span className="simple-small">{`${day(i.start)} – ${day(i.end)}`}</span></span></li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </ul> // MOCK-HOOK
      ) : ( // MOCK-HOOK
        <div className="mt-2"><MkDraftBars picked={mk.open ? "R-3" : null} label="Draft plans timeline" /></div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      {mk.open && <DraftCard item={MK_DRAFT_ITEMS[2]!} where="roadmap" />} {/* MOCK-HOOK */}
    </section> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** RP2 in the PRD's one-pager timeline (b: hatched there; d: said plainly; a/c: the page as today). */
export function MkOnePagerDraft({ mk, phone }: { mk: Mk; phone: boolean }) { // MOCK-HOOK
  if (mk.rp2 === "d") // MOCK-HOOK
    return <p className="text-base text-text-faint">{`No roadmap items yet. The run dated ${MK_DRAFT_ITEMS.length} items; they show here once this PRD is approved.`}</p>; // MOCK-HOOK
  if (mk.rp2 !== "b") return null; // MOCK-HOOK
  const picked = mk.open ? MK_DRAFT_ITEMS[0]! : null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="space-y-2"> {/* MOCK-HOOK */}
      <div className="flex flex-wrap items-center gap-3"><DraftKey>Draft dates: not approved</DraftKey><span className="simple-small">{`From the run, ${day(MK_DRAFT_ITEMS[0]!.start)} – ${day(MK_DRAFT_ITEMS.at(-1)!.end)}`}</span></div> {/* MOCK-HOOK */}
      {phone ? ( // MOCK-HOOK
        <ol className="border-l-2 border-dashed border-accent pl-4"> {/* MOCK-HOOK */}
          {MK_DRAFT_ITEMS.map((i) => ( // MOCK-HOOK
            <li key={i.key} className="relative py-2"><span aria-hidden className="absolute top-3.5 -left-[23px] size-3 rounded-full border-2 border-accent bg-[var(--simple-paper)]" /><strong className="block text-base">{i.title}</strong><span className="simple-small">{`${day(i.start)} – ${day(i.end)} · draft`}</span></li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </ol> // MOCK-HOOK
      ) : ( // MOCK-HOOK
        <MkDraftBars picked={picked?.key ?? null} label="Timeline strip" /> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      {picked && <DraftCard item={picked} where="one-pager" />} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** RP2 in the review meeting's Roadmap step (c: as a draft to approve; d: said plainly). */
export function MkMeetingDraft({ mk, canChange }: { mk: Mk; canChange: boolean }) { // MOCK-HOOK
  if (mk.rp2 === "d") // MOCK-HOOK
    return <p className="simple-small">{`No roadmap items for this PRD yet. Its run dated ${MK_DRAFT_ITEMS.length} items; they join the roadmap when the PRD is approved.`}</p>; // MOCK-HOOK
  if (mk.rp2 !== "c") return null; // MOCK-HOOK
  if (mk.done) // MOCK-HOOK
    return ( // MOCK-HOOK
      <div className="space-y-2"> {/* MOCK-HOOK */}
        <p role="status" className="simple-small">{`Dates approved in this meeting: ${MK_DRAFT_ITEMS.length} items are on the roadmap.`}</p> {/* MOCK-HOOK */}
        <MkDraftBars solid label="Roadmap items" items={MK_DRAFT_ITEMS.map((i) => (i.key === "R-6" ? { ...i, start: "2027-05-03", end: "2027-06-01", horizon: "later" } : i))} /> {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  const items = mk.mid ? MK_DRAFT_ITEMS.map((i) => (i.key === "R-6" ? { ...i, start: "2027-05-03", end: "2027-06-01", horizon: "later" as const } : i)) : MK_DRAFT_ITEMS; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="space-y-3"> {/* MOCK-HOOK */}
      <div className="flex flex-wrap items-center gap-3"><DraftKey>Draft from the run: not approved</DraftKey>{mk.mid && <span role="status" className="simple-small">Moved Turn a cart into a quote to May (draft)</span>}</div> {/* MOCK-HOOK */}
      <MkDraftBars items={items} picked={mk.mid ? "R-6" : null} label="Draft roadmap" /> {/* MOCK-HOOK */}
      <ul className="divide-y divide-line"> {/* MOCK-HOOK */}
        {items.map((i) => ( // MOCK-HOOK
          <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2"> {/* MOCK-HOOK */}
            <span><strong>{i.title}</strong>{` · ${i.horizon[0]!.toUpperCase()}${i.horizon.slice(1)} · ${day(i.start)} – ${day(i.end)} · `}<span className="text-accent-ink">Draft</span></span> {/* MOCK-HOOK */}
            {canChange && <span className="flex gap-2"><Button>Change dates</Button><Button className="text-crit">Leave out</Button></span>} {/* MOCK-HOOK */}
          </li> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </ul> {/* MOCK-HOOK */}
      {canChange && !mk.open && <Button variant="primary" icon="check">{`Approve these ${MK_DRAFT_ITEMS.length} dates`}</Button>} {/* MOCK-HOOK */}
      {mk.open && ( // MOCK-HOOK
        <div role="dialog" aria-label="Approve dates" className="rounded-md border border-accent bg-accent-soft p-3"> {/* MOCK-HOOK */}
          <p className="font-semibold">{`Put ${MK_DRAFT_ITEMS.length} items on the roadmap with these dates?`}</p> {/* MOCK-HOOK */}
          <p className="simple-small">Everyone sees them on the roadmap at once. The PRD itself still needs its own approval.</p> {/* MOCK-HOOK */}
          <div className="mt-2 flex gap-2"><Button variant="primary" icon="check">Approve dates</Button><Button>Cancel</Button></div> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
