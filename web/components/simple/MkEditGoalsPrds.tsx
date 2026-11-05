"use client"; // MOCK-HOOK
// MOCK-HOOK: mk-edit-goals-prds mock-up variants (throwaway branch, never merged). Every line here is a MOCK-HOOK.

import Link from "next/link"; // MOCK-HOOK
import { useRouter, useSearchParams } from "next/navigation"; // MOCK-HOOK
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"; // MOCK-HOOK

import { MK_ARCHIVED_GOALS, MK_ARCHIVED_PRDS, MK_GOAL_OWNERS, MK_PEOPLE } from "@/lib/api/mock/mk-edit-goals-prds"; // MOCK-HOOK
import { planSlices } from "@/lib/api/mock/simple-plan"; // MOCK-HOOK
import { useMe } from "@/lib/me"; // MOCK-HOOK

// MOCK-HOOK: ?eg=a|b|c picks Decision 1 (goals), ?ep=a|b|c Decision 2 (PRDs).
export function useMk(key: "eg" | "ep"): "a" | "b" | "c" | null { // MOCK-HOOK
  const v = useSearchParams().get(key); // MOCK-HOOK
  return v === "a" || v === "b" || v === "c" ? v : null; // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: a small client store, so an action's result shows on the page as it would.
type ArchivedGoal = { id: string; title: string; measure: string | null; target: string | null; due: string | null; owner: string; archived: string; features: number }; // MOCK-HOOK
type Store = { owners: Record<string, string>; archived: ArchivedGoal[]; prdArchived: { slug: string; title: string; archived: string }[]; prdGone: string[] }; // MOCK-HOOK
let store: Store = { owners: { ...MK_GOAL_OWNERS }, archived: MK_ARCHIVED_GOALS.map((g) => ({ ...g })), prdArchived: MK_ARCHIVED_PRDS.map((p) => ({ ...p })), prdGone: [] }; // MOCK-HOOK
const subs = new Set<() => void>(); // MOCK-HOOK
export function mkSet(f: (s: Store) => Store) { // MOCK-HOOK
  store = f(store); // MOCK-HOOK
  subs.forEach((s) => s()); // MOCK-HOOK
} // MOCK-HOOK
export function useMkStore(): Store { // MOCK-HOOK
  return useSyncExternalStore((s) => (subs.add(s), () => subs.delete(s)), () => store, () => store); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: who may act, through can() only: the decider changes (can accept a change, or the goal's own
// MOCK-HOOK: can_decide says so); an approver who is not the decider, or a commenter, proposes; a viewer reads.
export function useGoalAccess(canDecide?: boolean): "change" | "propose" | "read" { // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  return can("update_bucket_goal") && can("accept_simple_change", canDecide) ? "change" : can("create_simple_change") ? "propose" : "read"; // MOCK-HOOK
} // MOCK-HOOK
export function usePrdAccess(): "change" | "propose" | "read" { // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  return can("delete_document") ? "change" : can("create_comment") ? "propose" : "read"; // MOCK-HOOK
} // MOCK-HOOK

const BTN = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-[650] text-text hover:bg-surface2"; // MOCK-HOOK
const PRIMARY = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2"; // MOCK-HOOK
const DANGER = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-warn px-3 text-[14px] font-[650] text-white disabled:opacity-50"; // MOCK-HOOK
const INPUT = "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] text-text"; // MOCK-HOOK
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2"; // MOCK-HOOK

// MOCK-HOOK: the owner shown on a goal: plain words, a chip that opens a picker in proposal c.
export function GoalOwner({ title, picker, access }: { title: string; picker: boolean; access: "change" | "propose" | "read" }) { // MOCK-HOOK
  const s = useMkStore(); // MOCK-HOOK
  const [open, setOpen] = useState(false); // MOCK-HOOK
  const owner = s.owners[title]; // MOCK-HOOK
  if (!picker || access === "read") return <span data-testid="mk-goal-owner" className="text-[14px] text-text2">Owner: <b className="font-[650] text-text">{owner ?? "None yet"}</b></span>; // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="relative text-[14px] text-text2"> {/* MOCK-HOOK */}
      Owner:{" "} {/* MOCK-HOOK */}
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex h-6 items-center gap-1 rounded-full border border-line-strong bg-surface px-2 font-[650] text-text hover:bg-surface2"> {/* MOCK-HOOK */}
        {owner ?? "Pick an owner"} <span aria-hidden>▾</span> {/* MOCK-HOOK */}
      </button> {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="menu" className="absolute left-12 top-7 z-30 w-56 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg"> {/* MOCK-HOOK */}
          {MK_PEOPLE.map((p) => ( // MOCK-HOOK
            <button key={p} type="button" role="menuitemradio" aria-checked={p === owner} className={ITEM} onClick={() => { setOpen(false); if (access === "change") mkSet((x) => ({ ...x, owners: { ...x.owners, [title]: p } })); }}> {/* MOCK-HOOK */}
              <span className="w-4">{p === owner ? "✓" : ""}</span>{p} {/* MOCK-HOOK */}
            </button> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
          {access === "propose" && <p className="border-t border-line px-3 py-1.5 text-[13px] text-text2">Asks the decider</p>} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: the Owner field in the goal form (proposal a) and in the goal sheet (proposal b).
export function OwnerField({ value, onChange }: { value: string; onChange: (v: string) => void }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <label className="block min-w-0"> {/* MOCK-HOOK */}
      <span className="text-[13px] font-[650] text-text2">Owner</span> {/* MOCK-HOOK */}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}> {/* MOCK-HOOK */}
        {!value && <option value="">Pick an owner</option>} {/* MOCK-HOOK */}
        {MK_PEOPLE.map((p) => <option key={p} value={p}>{p}</option>)} {/* MOCK-HOOK */}
      </select> {/* MOCK-HOOK */}
    </label> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: proposal b, the goal sheet: every field of the goal, and Archive and Delete at its foot.
export function GoalSheet({ goal, order, total, access, onClose, onSave, onArchive, onDelete }: { goal: { title: string; measure: string | null; target: string | null; due: string }; order: number; total: number; access: "change" | "propose" | "read"; onClose: () => void; onSave: (f: { title: string; measure: string; target: string; due: string; owner: string }) => void; onArchive: () => void; onDelete: () => void }) { // MOCK-HOOK
  const s = useMkStore(); // MOCK-HOOK
  const [f, setF] = useState({ title: goal.title, measure: goal.measure ?? "", target: goal.target ?? "", due: goal.due, owner: s.owners[goal.title] ?? "" }); // MOCK-HOOK
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })); // MOCK-HOOK
  const ro = access === "read"; // MOCK-HOOK
  useEffect(() => { const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-backdrop="" className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}> {/* MOCK-HOOK */}
      <div role="dialog" aria-modal="true" aria-label={`Goal: ${goal.title}`} data-testid="mk-goal-sheet" className="flex h-full w-[460px] max-w-full flex-col border-l border-line bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}> {/* MOCK-HOOK */}
        <div className="flex items-center gap-2 border-b border-line px-5 py-3"> {/* MOCK-HOOK */}
          <h2 className="min-w-0 flex-1 text-[19px] font-[650]">Goal {order} of {total}</h2> {/* MOCK-HOOK */}
          <button type="button" aria-label="Close" className="h-8 w-8 rounded-lg text-[18px] hover:bg-surface2" onClick={onClose}>✕</button> {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
        <div className="grid flex-1 content-start gap-3 overflow-auto px-5 py-4"> {/* MOCK-HOOK */}
          <label className="block"><span className="text-[13px] font-[650] text-text2">Goal</span><textarea rows={2} readOnly={ro} value={f.title} onChange={set("title")} className={`${INPUT} h-auto py-1.5`} /></label> {/* MOCK-HOOK */}
          <label className="block"><span className="text-[13px] font-[650] text-text2">Measure</span><input readOnly={ro} value={f.measure} onChange={set("measure")} className={INPUT} /></label> {/* MOCK-HOOK */}
          <div className="grid grid-cols-2 gap-3"> {/* MOCK-HOOK */}
            <label className="block"><span className="text-[13px] font-[650] text-text2">Target</span><input readOnly={ro} value={f.target} onChange={set("target")} className={INPUT} /></label> {/* MOCK-HOOK */}
            <label className="block"><span className="text-[13px] font-[650] text-text2">By</span><input readOnly={ro} value={f.due} onChange={set("due")} className={INPUT} /></label> {/* MOCK-HOOK */}
          </div> {/* MOCK-HOOK */}
          {ro ? <label className="block"><span className="text-[13px] font-[650] text-text2">Owner</span><input readOnly value={f.owner} className={INPUT} /></label> : <OwnerField value={f.owner} onChange={(v) => setF((x) => ({ ...x, owner: v }))} />} {/* MOCK-HOOK */}
          <p className="text-[14px] text-text2">Order: goal {order} <span title="Change the order on Home, by dragging the goals." className="cursor-help rounded-full border border-line-strong px-1.5 text-[12px]">i</span></p> {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
        {!ro && ( // MOCK-HOOK
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3"> {/* MOCK-HOOK */}
            <button type="button" className={PRIMARY} onClick={() => onSave(f)}>{access === "propose" ? "Send for approval" : "Save goal"}</button> {/* MOCK-HOOK */}
            <button type="button" className={BTN} onClick={onClose}>Cancel</button> {/* MOCK-HOOK */}
            <span className="flex-1" /> {/* MOCK-HOOK */}
            <button type="button" className={BTN} onClick={onArchive}>{access === "propose" ? "Ask to archive" : "Archive"}</button> {/* MOCK-HOOK */}
            <button type="button" className={`${BTN} text-warn`} onClick={onDelete}>{access === "propose" ? "Ask to delete" : "Delete"}</button> {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: proposal a, the "Archived goals" fold at the end of the buckets, with Restore and Delete.
export function ArchivedGoalsFold({ access, onRestore, onDeleted, open: start = false }: { access: "change" | "propose" | "read"; onRestore: (g: ArchivedGoal) => void; onDeleted: (g: ArchivedGoal) => void; open?: boolean }) { // MOCK-HOOK
  const s = useMkStore(); // MOCK-HOOK
  const [del, setDel] = useState<ArchivedGoal | null>(null); // MOCK-HOOK
  if (!s.archived.length) return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <li data-testid="mk-archived-goals" className="rounded-[var(--simple-card-radius)] border border-line bg-surface sm:col-span-2"> {/* MOCK-HOOK */}
      <details open={start}> {/* MOCK-HOOK */}
        <summary className="cursor-pointer px-4 py-3 text-[17px] font-[650]">Archived goals <span className="font-normal text-text2">· {s.archived.length}</span></summary> {/* MOCK-HOOK */}
        <ul className="border-t border-line px-4"> {/* MOCK-HOOK */}
          {s.archived.map((g) => ( // MOCK-HOOK
            <li key={g.id} data-testid="mk-archived-goal" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-b-0"> {/* MOCK-HOOK */}
              <span className="min-w-0 font-[650]">{g.title}</span> {/* MOCK-HOOK */}
              <span className="text-[14px] text-text2">{g.owner} · archived {g.archived}</span> {/* MOCK-HOOK */}
              <span className="flex-1" /> {/* MOCK-HOOK */}
              {access !== "read" && <button type="button" className={BTN} onClick={() => onRestore(g)}>{access === "propose" ? "Ask to restore" : "Restore"}</button>} {/* MOCK-HOOK */}
              {access === "change" && <button type="button" className={`${BTN} text-warn`} onClick={() => setDel(g)}>Delete</button>} {/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </ul> {/* MOCK-HOOK */}
      </details> {/* MOCK-HOOK */}
      {del && ( // MOCK-HOOK
        <DeleteArchived goal={del} onClose={() => setDel(null)} onDeleted={onDeleted} /> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </li> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: Delete on an archived goal: one more confirm, then to Settings > Trash.
function DeleteArchived({ goal, onClose, onDeleted }: { goal: ArchivedGoal; onClose: () => void; onDeleted: (g: ArchivedGoal) => void }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <Confirm title={`Delete ${goal.title}?`} button="Delete goal" danger onClose={onClose} onYes={() => { mkSet((x) => ({ ...x, archived: x.archived.filter((a) => a.id !== goal.id) })); onClose(); onDeleted(goal); }}> {/* MOCK-HOOK */}
      <p>It goes to Settings &gt; Trash for 30 days.</p> {/* MOCK-HOOK */}
    </Confirm> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: proposal b, archived goals in place: greyed buckets with Restore and Delete, behind "Show archived".
export function ArchivedBuckets({ access, onRestore, onDeleted }: { access: "change" | "propose" | "read"; onRestore: (g: ArchivedGoal) => void; onDeleted: (g: ArchivedGoal) => void }) { // MOCK-HOOK
  const s = useMkStore(); // MOCK-HOOK
  const [del, setDel] = useState<ArchivedGoal | null>(null); // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      {s.archived.map((g) => ( // MOCK-HOOK
        <li key={g.id} data-testid="mk-archived-bucket" className="rounded-[var(--simple-card-radius)] border border-dashed border-line-strong bg-surface2/60 p-4 text-text2"> {/* MOCK-HOOK */}
          <div className="flex items-start gap-2"> {/* MOCK-HOOK */}
            <h3 className="min-w-0 flex-1 text-[21px] font-[650] leading-7">{g.title}</h3> {/* MOCK-HOOK */}
            <span className="mt-1 rounded-full bg-surface px-2 py-0.5 text-[13px] font-[650]">Archived {g.archived}</span> {/* MOCK-HOOK */}
          </div> {/* MOCK-HOOK */}
          <p className="mt-0.5 text-[15px]">{g.measure}: <b className="font-[650]">{g.target}</b> · Owner: {g.owner}</p> {/* MOCK-HOOK */}
          <p className="mt-1 text-[14px]">{g.features ? `${g.features} ${g.features === 1 ? "feature" : "features"} moved out when archived` : "Held no features"}</p> {/* MOCK-HOOK */}
          {access !== "read" && ( // MOCK-HOOK
            <div className="mt-3 flex gap-2"> {/* MOCK-HOOK */}
              <button type="button" className={BTN} onClick={() => onRestore(g)}>{access === "propose" ? "Ask to restore" : "Restore"}</button> {/* MOCK-HOOK */}
              {access === "change" && <button type="button" className={`${BTN} text-warn`} onClick={() => setDel(g)}>Delete</button>} {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
        </li> // MOCK-HOOK
      ))} {/* MOCK-HOOK */}
      {del && <DeleteArchived goal={del} onClose={() => setDel(null)} onDeleted={onDeleted} />} {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: a plain confirm, as the archive dialog looks.
export function Confirm({ title, button, danger, onClose, onYes, children, disabled }: { title: string; button: string; danger?: boolean; onClose: () => void; onYes: () => void; children: ReactNode; disabled?: boolean }) { // MOCK-HOOK
  const ref = useRef<HTMLDivElement>(null); // MOCK-HOOK
  useEffect(() => { const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-backdrop="" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}> {/* MOCK-HOOK */}
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} data-testid="mk-confirm" className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-auto rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 text-[15px] shadow-lg sm:rounded-[var(--simple-card-radius)]" onClick={(e) => e.stopPropagation()}> {/* MOCK-HOOK */}
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">{title}</h2> {/* MOCK-HOOK */}
        <div className="mt-2 grid gap-2">{children}</div> {/* MOCK-HOOK */}
        <div className="mt-4 flex items-center gap-2"> {/* MOCK-HOOK */}
          <button type="button" className={danger ? DANGER : PRIMARY} disabled={disabled} onClick={onYes}>{button}</button> {/* MOCK-HOOK */}
          <button type="button" className={BTN} onClick={onClose}>Cancel</button> {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: a small ⋯ menu.
export function MoreMenu({ label, items, testId, phone, plain }: { label: string; items: { label: string; onClick: () => void; warn?: boolean }[]; testId?: string; phone?: boolean; plain?: boolean }) { // MOCK-HOOK
  const [open, setOpen] = useState(false); // MOCK-HOOK
  const ref = useRef<HTMLSpanElement>(null); // MOCK-HOOK
  useEffect(() => { if (!open) return; const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false); document.addEventListener("mousedown", away); return () => document.removeEventListener("mousedown", away); }, [open]); // MOCK-HOOK
  if (!items.length) return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <span ref={ref} className="relative z-[2] inline-flex" data-testid={testId} data-mk-menu-open={open ? "" : undefined}> {/* MOCK-HOOK */}
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} className={plain ? `inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border text-[16px] text-text hover:border-line-strong hover:bg-surface2 ${open ? "border-line-strong bg-surface2" : "border-transparent"}` : `inline-flex ${phone ? "h-11 w-11" : "h-9 w-9"} items-center justify-center rounded-lg border border-line-strong bg-surface text-[18px] hover:bg-surface2 ${open ? "bg-surface2" : ""}`} onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}>⋯</button> {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="menu" className={`absolute ${phone ? "left-0" : "right-0"} top-10 z-30 w-60 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg`}> {/* MOCK-HOOK */}
          {items.map((it) => <button key={it.label} type="button" role="menuitem" className={`${ITEM} ${it.warn ? "text-warn" : ""}`} onClick={(e) => { e.preventDefault(); setOpen(false); it.onClick(); }}>{it.label}</button>)} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: the features a PRD put on the roadmap (the plan's, for Guided setup; a few for the others).
export function prdFeatures(slug: string): { code: string; name: string; ms: string }[] { // MOCK-HOOK
  const seen = new Map<string, { code: string; name: string; ms: string }>(); // MOCK-HOOK
  for (const s of planSlices()) if (!seen.has(s.feature_code)) seen.set(s.feature_code, { code: s.feature_code, name: s.name.replace(/, part \d+ of \d+$/, ""), ms: `${s.milestone} ${s.milestone_name}` }); // MOCK-HOOK
  const all = [...seen.values()]; // MOCK-HOOK
  return slug === "guided-setup" ? all : all.slice(0, (slug.length % 4) + 2); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: Decision 2's confirm: archive or delete a PRD, and what happens to its features on the roadmap.
export function PrdConfirm({ titles, slugs, verb, access, onClose, onDone }: { titles: string[]; slugs: string[]; verb: "archive" | "delete"; access: "change" | "propose"; onClose: () => void; onDone: (keep: boolean) => void }) { // MOCK-HOOK
  const feats = slugs.flatMap(prdFeatures); // MOCK-HOOK
  const ms = [...new Set(feats.map((f) => f.ms))].sort(); // MOCK-HOOK
  const [keep, setKeep] = useState<boolean | null>(null); // MOCK-HOOK
  const name = titles.length === 1 ? titles[0] : `${titles.length} PRDs`; // MOCK-HOOK
  const V = verb === "archive" ? "Archive" : "Delete"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <Confirm title={access === "propose" ? `Ask to ${verb} ${name}?` : `${V} ${name}?`} button={access === "propose" ? "Send to an owner" : `${V} ${titles.length === 1 ? "PRD" : `${titles.length} PRDs`}`} danger={verb === "delete" && access === "change"} disabled={feats.length > 0 && keep === null} onClose={onClose} onYes={() => onDone(!!keep)}> {/* MOCK-HOOK */}
      <p className="text-text2">{verb === "archive" ? "It leaves the One-pagers list and can be restored any time." : "It goes to Settings > Trash for 30 days."}</p> {/* MOCK-HOOK */}
      {feats.length > 0 ? ( // MOCK-HOOK
        <> {/* MOCK-HOOK */}
          <p className="font-[650]">{feats.length} {feats.length === 1 ? "feature is" : "features are"} on the roadmap, in {ms.join(", ")}:</p> {/* MOCK-HOOK */}
          <label className="flex items-start gap-2"><input type="radio" name="mk-keep" checked={keep === true} onChange={() => setKeep(true)} className="mt-1 h-4 w-4 accent-[var(--accent)]" /> <span>Keep them on the roadmap, with no PRD</span></label> {/* MOCK-HOOK */}
          <label className="flex items-start gap-2"><input type="radio" name="mk-keep" checked={keep === false} onChange={() => setKeep(false)} className="mt-1 h-4 w-4 accent-[var(--accent)]" /> <span>Take them off the roadmap too {verb === "delete" ? "(to Trash with it)" : "(back when restored)"} <span title={`${ms.length} ${ms.length === 1 ? "milestone gets" : "milestones get"} ${feats.length} fewer features; their dates are worked out again.`} aria-label="What taking them off does to the milestones" className="cursor-help rounded-full border border-line-strong px-1.5 text-[12px] text-text2">i</span></span></label> {/* MOCK-HOOK */}
        </> // MOCK-HOOK
      ) : <p>It has no features on the roadmap.</p>} {/* MOCK-HOOK */}
    </Confirm> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: the archived PRDs fold under the list (proposal a) and the "Show archived" rows (proposal b).
export function ArchivedPrds({ access, fold }: { access: "change" | "propose" | "read"; fold: boolean }) { // MOCK-HOOK
  const s = useMkStore(); // MOCK-HOOK
  const [shown, setShown] = useState(false); // MOCK-HOOK
  if (!s.prdArchived.length) return null; // MOCK-HOOK
  const rows = ( // MOCK-HOOK
    <ul className="flex flex-col"> {/* MOCK-HOOK */}
      {s.prdArchived.map((p) => ( // MOCK-HOOK
        <li key={p.slug} data-testid="mk-archived-prd" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 text-text2 last:border-b-0"> {/* MOCK-HOOK */}
          <Link href={`/simple/one-pagers/${p.slug}`} className="min-w-0 font-semibold hover:underline">{p.title}</Link> {/* MOCK-HOOK */}
          <span className="simple-small">Archived {p.archived}</span> {/* MOCK-HOOK */}
          <span className="flex-1" /> {/* MOCK-HOOK */}
          {access !== "read" && <button type="button" className={BTN} onClick={() => access === "change" && mkSet((x) => ({ ...x, prdArchived: x.prdArchived.filter((a) => a.slug !== p.slug) }))}>{access === "propose" ? "Ask to restore" : "Restore"}</button>} {/* MOCK-HOOK */}
        </li> // MOCK-HOOK
      ))} {/* MOCK-HOOK */}
    </ul> // MOCK-HOOK
  ); // MOCK-HOOK
  if (fold) return <details data-testid="mk-archived-prds" className="mt-2 border-t border-line pt-2"><summary className="cursor-pointer py-1 font-[650]">Archived <span className="font-normal text-text2">· {s.prdArchived.length}</span></summary>{rows}</details>; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="mt-2 border-t border-line pt-2"> {/* MOCK-HOOK */}
      <label className="flex items-center gap-2 py-1 text-[15px]"><input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" /> Show archived ({s.prdArchived.length})</label> {/* MOCK-HOOK */}
      {shown && rows} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: today, as the archived lists say it.
export const MK_TODAY = "Nov 5"; // MOCK-HOOK

// MOCK-HOOK: the last PRD change's note, shown above the list or the one-pager.
let prdNote: string | null = null; // MOCK-HOOK
export function setPrdNote(n: string | null) { prdNote = n; mkSet((x) => ({ ...x })); } // MOCK-HOOK
export function PrdNote() { // MOCK-HOOK
  useMkStore(); // MOCK-HOOK
  if (!prdNote) return null; // MOCK-HOOK
  return <div role="status" data-testid="mk-prd-note" className="simple-noprint z-30 mb-3 flex items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5 text-[15px] text-text shadow-md"><span className="min-w-0 flex-1">{prdNote}</span>{!prdNote.startsWith("Sent") && <button type="button" className="flex-none font-[650] text-accent-ink underline" onClick={() => setPrdNote(null)}>Undo</button>}</div>; // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: what an archive or delete says once done.
export function prdDoneWords(titles: string[], slugs: string[], verb: "archive" | "delete", keep: boolean, access: "change" | "propose"): string { // MOCK-HOOK
  const name = titles.length === 1 ? titles[0] : `${titles.length} PRDs`; // MOCK-HOOK
  const n = slugs.flatMap(prdFeatures).length; // MOCK-HOOK
  if (access === "propose") return `Sent to an owner: ${verb} ${name}.`; // MOCK-HOOK
  const feats = n ? (keep ? ` Its ${n} features stay on the roadmap with no PRD.` : ` Its ${n} features are off the roadmap.`) : ""; // MOCK-HOOK
  return verb === "archive" ? `Archived ${name}.${feats}` : `Deleted ${name}: it is in Settings > Trash for 30 days.${feats}`; // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: the one-pager header's ⋯ menu (proposals a and b) and the archived banner.
export function OnePagerMk({ slug, title, phone }: { slug: string; title: string; phone: boolean }) { // MOCK-HOOK
  const ep = useMk("ep"); // MOCK-HOOK
  const access = usePrdAccess(); // MOCK-HOOK
  const [verb, setVerb] = useState<"archive" | "delete" | null>(null); // MOCK-HOOK
  const router = useRouter(); // MOCK-HOOK
  if (!(ep === "a" || ep === "b") || access === "read") return null; // MOCK-HOOK
  const p = access === "propose"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      <MoreMenu label={`More for ${title}`} testId="mk-prd-menu" phone={phone} items={[{ label: p ? "Ask to archive" : "Archive PRD", onClick: () => setVerb("archive") }, { label: p ? "Ask to delete" : "Delete PRD", warn: true, onClick: () => setVerb("delete") }]} /> {/* MOCK-HOOK */}
      {verb && <PrdConfirm titles={[title]} slugs={[slug]} verb={verb} access={access} onClose={() => setVerb(null)} onDone={(keep) => { setVerb(null); setPrdNote(prdDoneWords([title], [slug], verb, keep, access)); if (!p && verb === "archive") mkSet((x) => ({ ...x, prdArchived: [{ slug, title, archived: MK_TODAY }, ...x.prdArchived] })); if (!p && verb === "delete") { mkSet((x) => ({ ...x, prdGone: [...x.prdGone, slug] })); router.push(`/simple/one-pagers?ep=${ep}`); } }} />} {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
export function OnePagerArchivedBanner({ slug }: { slug: string }) { // MOCK-HOOK
  const s = useMkStore(); // MOCK-HOOK
  const access = usePrdAccess(); // MOCK-HOOK
  const a = s.prdArchived.find((x) => x.slug === slug); // MOCK-HOOK
  if (!useMk("ep") || !a) return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div role="status" data-testid="mk-prd-archived" className="simple-noprint flex flex-wrap items-center gap-3 border-b border-line bg-surface2 px-4 py-2 text-base"> {/* MOCK-HOOK */}
      <strong>Archived {a.archived}</strong><span className="text-text2">· not on the One-pagers list</span> {/* MOCK-HOOK */}
      {access !== "read" && <button type="button" className={BTN} onClick={() => { if (access === "change") { mkSet((x) => ({ ...x, prdArchived: x.prdArchived.filter((y) => y.slug !== slug) })); setPrdNote(`Restored ${a.title}.`); } else setPrdNote(`Sent to an owner: restore ${a.title}.`); }}>{access === "propose" ? "Ask to restore" : "Restore"}</button>} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
