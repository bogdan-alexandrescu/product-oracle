"use client"; // MOCK-HOOK
/** // MOCK-HOOK
 * MOCK-HOOK (whole file): mk-qa4-review mock-up variants, never merged. The URL picks them:
 * ?qv1=a|b|c (sending edits for approval), ?qv2=a|b|c (what readers see of changes in review), // MOCK-HOOK
 * ?qv3=a|b|c (presenting with unapproved edits); state switches &open=1, &present=1, // MOCK-HOOK
 * &show=draft|published, &list=1. // MOCK-HOOK
 */ // MOCK-HOOK
import { useEffect, useState, type ReactNode } from "react"; // MOCK-HOOK
import { Button, Dialog } from "@/components/ds"; // MOCK-HOOK
import type { Schemas } from "@/lib/api/client"; // MOCK-HOOK
// MOCK-HOOK
type View = Schemas["OnePagerOut"]; // MOCK-HOOK
export type MkInReview = { line_id: string; before: string; after: string; by_name: string; kind: "change" | "proposal"; waiting_on: string[] }; // MOCK-HOOK
// MOCK-HOOK
export function useMk() { // MOCK-HOOK
  const [q, setQ] = useState(() => new URLSearchParams()); // MOCK-HOOK
  // eslint-disable-next-line react-hooks/set-state-in-effect -- MOCK-HOOK: reads the mock-up's URL switch once
  useEffect(() => setQ(new URLSearchParams(window.location.search)), []); // MOCK-HOOK
  return { // MOCK-HOOK
    qv1: q.get("qv1"), // MOCK-HOOK
    qv2: q.get("qv2"), // MOCK-HOOK
    qv3: q.get("qv3"), // MOCK-HOOK
    open: q.get("open") === "1", // MOCK-HOOK
    present: q.get("present") === "1", // MOCK-HOOK
    show: q.get("show") as "draft" | "published" | null, // MOCK-HOOK
    list: q.get("list") === "1", // MOCK-HOOK
  }; // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** Invented people an owner may add as reviewers. */ // MOCK-HOOK
export const MK_CANDIDATES = ["Lee Park", "Mina Shah", "Tom Becker", "Ana Lima", "Chris Doyle", "Noor Haddad"]; // MOCK-HOOK
export const MK_REQUIRED = "Rae Okafor"; // MOCK-HOOK
// MOCK-HOOK
function lineName(v: View, id: string): string { // MOCK-HOOK
  for (const b of v.blocks) if (b.lines.some((l) => l.id === id)) return b.title; // MOCK-HOOK
  return ""; // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
function Diff({ before, after }: { before: string; after: string }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="block">{/* MOCK-HOOK */}
      <s className="text-text-faint">{before}</s>{/* MOCK-HOOK */}
      <span className="mx-1 text-text-faint">→</span>{/* MOCK-HOOK */}
      <span className="font-semibold">{after}</span>{/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
function ReviewerPicker({ picked, setPicked, compact = false }: { picked: string[]; setPicked: (p: string[]) => void; compact?: boolean }) { // MOCK-HOOK
  const [adding, setAdding] = useState(false); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="space-y-2">{/* MOCK-HOOK */}
      <div className="flex flex-wrap items-center gap-2">{/* MOCK-HOOK */}
        <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px]">{/* MOCK-HOOK */}
          {MK_REQUIRED} <span className="text-text-faint">· required for this PRD</span>{/* MOCK-HOOK */}
        </span>{/* MOCK-HOOK */}
        {picked.map((p) => ( // MOCK-HOOK
          <span key={p} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px]">{/* MOCK-HOOK */}
            {p}{/* MOCK-HOOK */}
            <button type="button" aria-label={`Remove ${p}`} className="ml-1 text-text-faint" onClick={() => setPicked(picked.filter((x) => x !== p))}>×</button>{/* MOCK-HOOK */}
          </span> // MOCK-HOOK
        ))}{/* MOCK-HOOK */}
        {!adding && <Button onClick={() => setAdding(true)}>+ Add a reviewer</Button>}{/* MOCK-HOOK */}
      </div>{/* MOCK-HOOK */}
      {adding && ( // MOCK-HOOK
        <ul aria-label="People you can add" className={`rounded-md border border-line-strong bg-surface ${compact ? "max-h-40" : "max-h-56"} overflow-auto`}>{/* MOCK-HOOK */}
          {MK_CANDIDATES.filter((c) => !picked.includes(c)).map((c) => ( // MOCK-HOOK
            <li key={c}>{/* MOCK-HOOK */}
              <button type="button" className="w-full px-3 py-2 text-left text-[15px] hover:bg-[var(--simple-edited)]" onClick={() => { setPicked([...picked, c]); setAdding(false); }}>{/* MOCK-HOOK */}
                {c} <span className="text-text-faint">· {c.toLowerCase().replace(" ", ".")}@example.com</span>{/* MOCK-HOOK */}
              </button>{/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))}{/* MOCK-HOOK */}
        </ul> // MOCK-HOOK
      )}{/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV1 a: Send for approval asks first, names the reviewers and lets the owner add more. */ // MOCK-HOOK
export function Qv1SendDialog({ v, onClose, onSend, busy }: { v: View; onClose: () => void; onSend: (also: string[]) => void; busy: boolean }) { // MOCK-HOOK
  const [picked, setPicked] = useState<string[]>([]); // MOCK-HOOK
  const changes = v.notes.filter((n) => n.kind === "change"); // MOCK-HOOK
  return ( // MOCK-HOOK
    <Dialog // MOCK-HOOK
      title={`Send ${changes.length} ${changes.length === 1 ? "change" : "changes"} for approval`} // MOCK-HOOK
      onClose={onClose} // MOCK-HOOK
      phoneSheet // MOCK-HOOK
      actions={<Button variant="primary" disabled={busy} onClick={() => onSend(picked)}>Send for approval</Button>} // MOCK-HOOK
    >{/* MOCK-HOOK */}
      <div className="space-y-4 text-[15px]">{/* MOCK-HOOK */}
        <p>Each reviewer gets an Inbox note. Published v{v.version} stays live until they approve.</p>{/* MOCK-HOOK */}
        <ul className="space-y-2">{/* MOCK-HOOK */}
          {changes.map((n) => ( // MOCK-HOOK
            <li key={n.change_id} className="rounded-md border border-[var(--simple-rule)] px-3 py-2">{/* MOCK-HOOK */}
              <span className="text-sm text-text-faint">{lineName(v, n.line_id)}</span>{/* MOCK-HOOK */}
              <Diff before={n.before} after={n.after} />{/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))}{/* MOCK-HOOK */}
        </ul>{/* MOCK-HOOK */}
        <div>{/* MOCK-HOOK */}
          <p className="mb-2 font-semibold">Who approves</p>{/* MOCK-HOOK */}
          <ReviewerPicker picked={picked} setPicked={setPicked} />{/* MOCK-HOOK */}
        </div>{/* MOCK-HOOK */}
      </div>{/* MOCK-HOOK */}
    </Dialog> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV1 b: one Review menu in the header: ask for approval, or hold a review meeting. */ // MOCK-HOOK
export function Qv1ReviewMenu({ btnClass, changes, canStart, open, setOpen, onAsk, onMeeting }: { btnClass: string; changes: number; canStart: boolean; open: boolean; setOpen: (o: boolean) => void; onAsk: () => void; onMeeting: () => void }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="relative inline-flex">{/* MOCK-HOOK */}
      <button type="button" className={btnClass} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>{/* MOCK-HOOK */}
        Review ▾{/* MOCK-HOOK */}
      </button>{/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="menu" className="absolute top-full right-0 z-20 mt-1 w-[320px] max-md:fixed max-md:right-4 max-md:left-4 max-md:top-auto max-md:w-auto rounded-md border border-line-strong bg-surface p-1 shadow-md">{/* MOCK-HOOK */}
          <button role="menuitem" type="button" disabled={changes === 0} className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)] disabled:opacity-60" onClick={onAsk}>{/* MOCK-HOOK */}
            <span className="block font-semibold">Ask for approval</span>{/* MOCK-HOOK */}
            <span className="block text-sm text-text2">{changes > 0 ? `Send your ${changes} ${changes === 1 ? "change" : "changes"} to reviewers to approve` : "No changes to send yet"}</span>{/* MOCK-HOOK */}
          </button>{/* MOCK-HOOK */}
          <button role="menuitem" type="button" disabled={!canStart} className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)] disabled:opacity-60" onClick={onMeeting}>{/* MOCK-HOOK */}
            <span className="block font-semibold">Hold a review meeting</span>{/* MOCK-HOOK */}
            <span className="block text-sm text-text2">Go through the PRD with people, live, and decide together</span>{/* MOCK-HOOK */}
          </button>{/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )}{/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV1 b: the ask, inline under the draft bar (not a dialog). */ // MOCK-HOOK
export function Qv1InlineAsk({ v, onCancel, onSend, busy }: { v: View; onCancel: () => void; onSend: (also: string[]) => void; busy: boolean }) { // MOCK-HOOK
  const [picked, setPicked] = useState<string[]>([]); // MOCK-HOOK
  const n = v.notes.filter((x) => x.kind === "change").length; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div role="region" aria-label="Ask for approval" className="simple-noprint border-b border-[var(--simple-rule)] bg-surface px-4 py-3 text-[15px]">{/* MOCK-HOOK */}
      <p className="mb-2 font-semibold">Ask for approval of {n} {n === 1 ? "change" : "changes"}</p>{/* MOCK-HOOK */}
      <ReviewerPicker picked={picked} setPicked={setPicked} compact />{/* MOCK-HOOK */}
      <div className="mt-3 flex gap-2">{/* MOCK-HOOK */}
        <Button onClick={onCancel}>Cancel</Button>{/* MOCK-HOOK */}
        <Button variant="primary" disabled={busy} onClick={() => onSend(picked)}>Send</Button>{/* MOCK-HOOK */}
      </div>{/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV2: the readers' bar of changes in review, by proposal. */ // MOCK-HOOK
export function Qv2Bar({ v, variant, listOpen }: { v: View; variant: string; listOpen: boolean }) { // MOCK-HOOK
  const items = ((v as unknown as { mk_in_review?: MkInReview[] }).mk_in_review ?? []); // MOCK-HOOK
  const [open, setOpen] = useState(listOpen); // MOCK-HOOK
  // eslint-disable-next-line react-hooks/set-state-in-effect -- MOCK-HOOK: reads the mock-up's URL switch once
  useEffect(() => setOpen(listOpen), [listOpen]); // MOCK-HOOK
  const [follow, setFollow] = useState(false); // MOCK-HOOK
  const n = v.changes_in_review; // MOCK-HOOK
  const word = `${n} ${n === 1 ? "change" : "changes"}`; // MOCK-HOOK
  if (variant === "c") { // MOCK-HOOK
    return ( // MOCK-HOOK
      <div role="status" className="simple-noprint flex flex-wrap items-center gap-3 border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text2">{/* MOCK-HOOK */}
        <span>{word} to this PRD {n === 1 ? "is" : "are"} waiting for approval. You will see {n === 1 ? "it" : "them"} here once approved.</span>{/* MOCK-HOOK */}
        <Button aria-pressed={follow} onClick={() => setFollow(!follow)}>{follow ? "✓ We will tell you" : "Tell me when it is published"}</Button>{/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  if (variant === "b") { // MOCK-HOOK
    return ( // MOCK-HOOK
      <div role="status" className="simple-noprint border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text2">{/* MOCK-HOOK */}
        {word} in review, marked below with a dashed line · you read the published version{/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="simple-noprint border-b border-[var(--simple-rule)] text-base">{/* MOCK-HOOK */}
      <div role="status" className="flex flex-wrap items-center gap-3 px-4 py-2 text-text2">{/* MOCK-HOOK */}
        <span>{word} in review · you read the published version</span>{/* MOCK-HOOK */}
        <Button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide the changes" : `See the ${word}`}</Button>{/* MOCK-HOOK */}
      </div>{/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <ul aria-label="Changes in review" className="mx-auto max-w-[1180px] space-y-2 px-4 pb-3">{/* MOCK-HOOK */}
          {items.map((c) => ( // MOCK-HOOK
            <li key={c.line_id + c.kind} className="rounded-md border border-[var(--simple-rule)] bg-surface px-3 py-2 text-[15px]">{/* MOCK-HOOK */}
              <span className="text-sm text-text-faint">{lineName(v, c.line_id)} · {c.kind === "proposal" ? `proposed by ${c.by_name}` : `edited by ${c.by_name}`}{c.waiting_on.length ? ` · waiting on ${c.waiting_on.join(", ")}` : ""}</span>{/* MOCK-HOOK */}
              <Diff before={c.before} after={c.after} />{/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))}{/* MOCK-HOOK */}
        </ul> // MOCK-HOOK
      )}{/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV2 b: under a line with a change in review, a dashed mark; a tap shows the new wording. */ // MOCK-HOOK
export function Qv2LineMark({ v, lineId }: { v: View; lineId: string }) { // MOCK-HOOK
  const items = ((v as unknown as { mk_in_review?: MkInReview[] }).mk_in_review ?? []).filter((c) => c.line_id === lineId); // MOCK-HOOK
  const list = useMk().list; // MOCK-HOOK
  const [open, setOpen] = useState(false); // MOCK-HOOK
  // eslint-disable-next-line react-hooks/set-state-in-effect -- MOCK-HOOK: reads the mock-up's URL switch once
  useEffect(() => setOpen(list), [list]); // MOCK-HOOK
  if (!items.length) return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="simple-noprint mx-2 mt-1 mb-2 border-l-2 border-dashed border-line-strong pl-3">{/* MOCK-HOOK */}
      <button type="button" aria-expanded={open} className="text-sm text-text2 underline" onClick={() => setOpen(!open)}>{/* MOCK-HOOK */}
        {open ? "Hide the change" : `Change in review · see it`}{/* MOCK-HOOK */}
      </button>{/* MOCK-HOOK */}
      {open && items.map((c) => ( // MOCK-HOOK
        <p key={c.kind} className="mt-1 text-[15px]">{/* MOCK-HOOK */}
          <span className="text-sm text-text-faint">{c.kind === "proposal" ? `Proposed by ${c.by_name}` : `Edited by ${c.by_name}`}{c.waiting_on.length ? ` · waiting on ${c.waiting_on.join(", ")}` : ""}</span>{/* MOCK-HOOK */}
          <Diff before={c.before} after={c.after} />{/* MOCK-HOOK */}
        </p> // MOCK-HOOK
      ))}{/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV3 a: Present asks what to show. */ // MOCK-HOOK
export function Qv3PresentMenu({ btnClass, v, onPick, open, setOpen, children }: { btnClass: string; v: View; onPick: (show: "draft" | "published") => void; open: boolean; setOpen: (o: boolean) => void; children: ReactNode }) { // MOCK-HOOK
  const n = v.draft?.changes ?? 0; // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="relative inline-flex">{/* MOCK-HOOK */}
      <button type="button" className={btnClass} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>{children}</button>{/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="menu" className="absolute top-full left-0 z-20 mt-1 w-[330px] rounded-md border border-line-strong bg-surface p-1 shadow-md">{/* MOCK-HOOK */}
          <button role="menuitem" type="button" className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)]" onClick={() => onPick("published")}>{/* MOCK-HOOK */}
            <span className="block font-semibold">Published v{v.version}</span>{/* MOCK-HOOK */}
            <span className="block text-sm text-text2">What everyone has approved</span>{/* MOCK-HOOK */}
          </button>{/* MOCK-HOOK */}
          <button role="menuitem" type="button" className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)]" onClick={() => onPick("draft")}>{/* MOCK-HOOK */}
            <span className="block font-semibold">Working draft</span>{/* MOCK-HOOK */}
            <span className="block text-sm text-text2">With your {n} {n === 1 ? "change" : "changes"}, not yet approved</span>{/* MOCK-HOOK */}
          </button>{/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )}{/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV3: the label over a presented page that says what it is. */ // MOCK-HOOK
export function Qv3Label({ children }: { children: ReactNode }) { // MOCK-HOOK
  return <p data-testid="presenting-what" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px] font-semibold text-text2">{children}</p>; // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** QV3 c: the key to the colours, while presenting the draft with its marks. */ // MOCK-HOOK
export function Qv3Legend() { // MOCK-HOOK
  return ( // MOCK-HOOK
    <p aria-label="What the colours mean" className="flex flex-wrap items-center gap-4 text-[15px] text-text2">{/* MOCK-HOOK */}
      <span className="inline-flex items-center gap-2"><span className="inline-block h-4 w-6 rounded bg-[var(--simple-edited)]" />Edited, not yet approved</span>{/* MOCK-HOOK */}
      <span className="inline-flex items-center gap-2"><span className="inline-block h-4 w-6 rounded bg-[var(--simple-proposal)]" />A commenter proposed new words for this line</span>{/* MOCK-HOOK */}
    </p> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
