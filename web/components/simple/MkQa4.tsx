"use client";
/**
 * MOCK-HOOK (whole file): mk-qa4-review mock-up variants, never merged. The URL picks them:
 * ?qv1=a|b|c (sending edits for approval), ?qv2=a|b|c (what readers see of changes in review),
 * ?qv3=a|b|c (presenting with unapproved edits); state switches &open=1, &present=1,
 * &show=draft|published, &list=1.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Dialog } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

type View = Schemas["OnePagerOut"];
export type MkInReview = { line_id: string; before: string; after: string; by_name: string; kind: "change" | "proposal"; waiting_on: string[] };

export function useMk() {
  const [q, setQ] = useState(() => new URLSearchParams());
  useEffect(() => setQ(new URLSearchParams(window.location.search)), []);
  return {
    qv1: q.get("qv1"),
    qv2: q.get("qv2"),
    qv3: q.get("qv3"),
    open: q.get("open") === "1",
    present: q.get("present") === "1",
    show: q.get("show") as "draft" | "published" | null,
    list: q.get("list") === "1",
  };
}

/** Invented people an owner may add as reviewers. */
export const MK_CANDIDATES = ["Lee Park", "Mina Shah", "Tom Becker", "Ana Lima", "Chris Doyle", "Noor Haddad"];
export const MK_REQUIRED = "Rae Okafor";

function lineName(v: View, id: string): string {
  for (const b of v.blocks) if (b.lines.some((l) => l.id === id)) return b.title;
  return "";
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <span className="block">
      <s className="text-text-faint">{before}</s>
      <span className="mx-1 text-text-faint">→</span>
      <span className="font-semibold">{after}</span>
    </span>
  );
}

function ReviewerPicker({ picked, setPicked, compact = false }: { picked: string[]; setPicked: (p: string[]) => void; compact?: boolean }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px]">
          {MK_REQUIRED} <span className="text-text-faint">· required for this PRD</span>
        </span>
        {picked.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px]">
            {p}
            <button type="button" aria-label={`Remove ${p}`} className="ml-1 text-text-faint" onClick={() => setPicked(picked.filter((x) => x !== p))}>×</button>
          </span>
        ))}
        {!adding && <Button onClick={() => setAdding(true)}>+ Add a reviewer</Button>}
      </div>
      {adding && (
        <ul aria-label="People you can add" className={`rounded-md border border-line-strong bg-surface ${compact ? "max-h-40" : "max-h-56"} overflow-auto`}>
          {MK_CANDIDATES.filter((c) => !picked.includes(c)).map((c) => (
            <li key={c}>
              <button type="button" className="w-full px-3 py-2 text-left text-[15px] hover:bg-[var(--simple-edited)]" onClick={() => { setPicked([...picked, c]); setAdding(false); }}>
                {c} <span className="text-text-faint">· {c.toLowerCase().replace(" ", ".")}@example.com</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** QV1 a: Send for approval asks first, names the reviewers and lets the owner add more. */
export function Qv1SendDialog({ v, onClose, onSend, busy }: { v: View; onClose: () => void; onSend: (also: string[]) => void; busy: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const changes = v.notes.filter((n) => n.kind === "change");
  return (
    <Dialog
      title={`Send ${changes.length} ${changes.length === 1 ? "change" : "changes"} for approval`}
      onClose={onClose}
      phoneSheet
      actions={<Button variant="primary" disabled={busy} onClick={() => onSend(picked)}>Send for approval</Button>}
    >
      <div className="space-y-4 text-[15px]">
        <p>Each reviewer gets an Inbox note. Published v{v.version} stays live until they approve.</p>
        <ul className="space-y-2">
          {changes.map((n) => (
            <li key={n.change_id} className="rounded-md border border-[var(--simple-rule)] px-3 py-2">
              <span className="text-sm text-text-faint">{lineName(v, n.line_id)}</span>
              <Diff before={n.before} after={n.after} />
            </li>
          ))}
        </ul>
        <div>
          <p className="mb-2 font-semibold">Who approves</p>
          <ReviewerPicker picked={picked} setPicked={setPicked} />
        </div>
      </div>
    </Dialog>
  );
}

/** QV1 b: one Review menu in the header: ask for approval, or hold a review meeting. */
export function Qv1ReviewMenu({ btnClass, changes, canStart, open, setOpen, onAsk, onMeeting }: { btnClass: string; changes: number; canStart: boolean; open: boolean; setOpen: (o: boolean) => void; onAsk: () => void; onMeeting: () => void }) {
  return (
    <span className="relative inline-flex">
      <button type="button" className={btnClass} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        Review ▾
      </button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-20 mt-1 w-[320px] max-md:fixed max-md:right-4 max-md:left-4 max-md:top-auto max-md:w-auto rounded-md border border-line-strong bg-surface p-1 shadow-md">
          <button role="menuitem" type="button" disabled={changes === 0} className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)] disabled:opacity-60" onClick={onAsk}>
            <span className="block font-semibold">Ask for approval</span>
            <span className="block text-sm text-text2">{changes > 0 ? `Send your ${changes} ${changes === 1 ? "change" : "changes"} to reviewers to approve` : "No changes to send yet"}</span>
          </button>
          <button role="menuitem" type="button" disabled={!canStart} className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)] disabled:opacity-60" onClick={onMeeting}>
            <span className="block font-semibold">Hold a review meeting</span>
            <span className="block text-sm text-text2">Go through the PRD with people, live, and decide together</span>
          </button>
        </div>
      )}
    </span>
  );
}

/** QV1 b: the ask, inline under the draft bar (not a dialog). */
export function Qv1InlineAsk({ v, onCancel, onSend, busy }: { v: View; onCancel: () => void; onSend: (also: string[]) => void; busy: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const n = v.notes.filter((x) => x.kind === "change").length;
  return (
    <div role="region" aria-label="Ask for approval" className="simple-noprint border-b border-[var(--simple-rule)] bg-surface px-4 py-3 text-[15px]">
      <p className="mb-2 font-semibold">Ask for approval of {n} {n === 1 ? "change" : "changes"}</p>
      <ReviewerPicker picked={picked} setPicked={setPicked} compact />
      <div className="mt-3 flex gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => onSend(picked)}>Send</Button>
      </div>
    </div>
  );
}

/** QV2: the readers' bar of changes in review, by proposal. */
export function Qv2Bar({ v, variant, listOpen }: { v: View; variant: string; listOpen: boolean }) {
  const items = ((v as unknown as { mk_in_review?: MkInReview[] }).mk_in_review ?? []);
  const [open, setOpen] = useState(listOpen);
  useEffect(() => setOpen(listOpen), [listOpen]);
  const [follow, setFollow] = useState(false);
  const n = v.changes_in_review;
  const word = `${n} ${n === 1 ? "change" : "changes"}`;
  if (variant === "c") {
    return (
      <div role="status" className="simple-noprint flex flex-wrap items-center gap-3 border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text2">
        <span>{word} to this PRD {n === 1 ? "is" : "are"} waiting for approval. You will see {n === 1 ? "it" : "them"} here once approved.</span>
        <Button aria-pressed={follow} onClick={() => setFollow(!follow)}>{follow ? "✓ We will tell you" : "Tell me when it is published"}</Button>
      </div>
    );
  }
  if (variant === "b") {
    return (
      <div role="status" className="simple-noprint border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text2">
        {word} in review, marked below with a dashed line · you read the published version
      </div>
    );
  }
  return (
    <div className="simple-noprint border-b border-[var(--simple-rule)] text-base">
      <div role="status" className="flex flex-wrap items-center gap-3 px-4 py-2 text-text2">
        <span>{word} in review · you read the published version</span>
        <Button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide the changes" : `See the ${word}`}</Button>
      </div>
      {open && (
        <ul aria-label="Changes in review" className="mx-auto max-w-[1180px] space-y-2 px-4 pb-3">
          {items.map((c) => (
            <li key={c.line_id + c.kind} className="rounded-md border border-[var(--simple-rule)] bg-surface px-3 py-2 text-[15px]">
              <span className="text-sm text-text-faint">{lineName(v, c.line_id)} · {c.kind === "proposal" ? `proposed by ${c.by_name}` : `edited by ${c.by_name}`}{c.waiting_on.length ? ` · waiting on ${c.waiting_on.join(", ")}` : ""}</span>
              <Diff before={c.before} after={c.after} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** QV2 b: under a line with a change in review, a dashed mark; a tap shows the new wording. */
export function Qv2LineMark({ v, lineId }: { v: View; lineId: string }) {
  const items = ((v as unknown as { mk_in_review?: MkInReview[] }).mk_in_review ?? []).filter((c) => c.line_id === lineId);
  const list = useMk().list;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(list), [list]);
  if (!items.length) return null;
  return (
    <div className="simple-noprint mx-2 mt-1 mb-2 border-l-2 border-dashed border-line-strong pl-3">
      <button type="button" aria-expanded={open} className="text-sm text-text2 underline" onClick={() => setOpen(!open)}>
        {open ? "Hide the change" : `Change in review · see it`}
      </button>
      {open && items.map((c) => (
        <p key={c.kind} className="mt-1 text-[15px]">
          <span className="text-sm text-text-faint">{c.kind === "proposal" ? `Proposed by ${c.by_name}` : `Edited by ${c.by_name}`}{c.waiting_on.length ? ` · waiting on ${c.waiting_on.join(", ")}` : ""}</span>
          <Diff before={c.before} after={c.after} />
        </p>
      ))}
    </div>
  );
}

/** QV3 a: Present asks what to show. */
export function Qv3PresentMenu({ btnClass, v, onPick, open, setOpen, children }: { btnClass: string; v: View; onPick: (show: "draft" | "published") => void; open: boolean; setOpen: (o: boolean) => void; children: ReactNode }) {
  const n = v.draft?.changes ?? 0;
  return (
    <span className="relative inline-flex">
      <button type="button" className={btnClass} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>{children}</button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-20 mt-1 w-[330px] rounded-md border border-line-strong bg-surface p-1 shadow-md">
          <button role="menuitem" type="button" className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)]" onClick={() => onPick("published")}>
            <span className="block font-semibold">Published v{v.version}</span>
            <span className="block text-sm text-text2">What everyone has approved</span>
          </button>
          <button role="menuitem" type="button" className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)]" onClick={() => onPick("draft")}>
            <span className="block font-semibold">Working draft</span>
            <span className="block text-sm text-text2">With your {n} {n === 1 ? "change" : "changes"}, not yet approved</span>
          </button>
        </div>
      )}
    </span>
  );
}

/** QV3: the label over a presented page that says what it is. */
export function Qv3Label({ children }: { children: ReactNode }) {
  return <p data-testid="presenting-what" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px] font-semibold text-text2">{children}</p>;
}

/** QV3 c: the key to the colours, while presenting the draft with its marks. */
export function Qv3Legend() {
  return (
    <p aria-label="What the colours mean" className="flex flex-wrap items-center gap-4 text-[15px] text-text2">
      <span className="inline-flex items-center gap-2"><span className="inline-block h-4 w-6 rounded bg-[var(--simple-edited)]" />Edited, not yet approved</span>
      <span className="inline-flex items-center gap-2"><span className="inline-block h-4 w-6 rounded bg-[var(--simple-proposal)]" />Wording proposed by a commenter</span>
    </p>
  );
}
