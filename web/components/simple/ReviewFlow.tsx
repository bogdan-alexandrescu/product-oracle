"use client";

import { useState } from "react";

import { Button, Dialog } from "@/components/ds";
import { PersonPicker } from "@/components/PersonPicker";
import type { Schemas } from "@/lib/api/client";

type View = Schemas["OnePagerOut"];
type Ref = Schemas["SimplePersonRef"];

/** The block a line sits in ("What we will build"), to say which part of the page changed. */
function lineName(v: View, id: string): string {
  return v.blocks.find((b) => b.lines.some((l) => l.id === id))?.title ?? "";
}

/** Old words struck, new words in bold. */
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <span className="block">
      <s className="text-text-faint">{before}</s>
      <span className="mx-1 text-text-faint">→</span>
      <span className="font-semibold">{after}</span>
    </span>
  );
}

const CHIP = "inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-3 py-1 text-[15px]";

/**
 * build-review (QV1 a, picked Nov 1): Send for approval… asks first: the changes being sent,
 * who approves (the PRD's required reviewers, already there) and "+ Add a reviewer".
 */
export function SendForApproval({ v, busy, onClose, onSend }: { v: View; busy: boolean; onClose: () => void; onSend: (reviewerIds: string[]) => void }) {
  const [added, setAdded] = useState<Ref[]>([]);
  const [adding, setAdding] = useState(false);
  const changes = v.notes.filter((n) => n.kind === "change");
  const required = v.draft?.reviewers ?? [];
  const n = v.draft?.changes ?? changes.length;
  return (
    <Dialog
      title={`Send ${n} ${n === 1 ? "change" : "changes"} for approval`}
      testId="send-for-approval"
      onClose={onClose}
      busy={busy}
      phoneSheet
      actions={
        <Button variant="primary" disabled={busy} onClick={() => onSend(added.map((p) => p.id))}>
          Send for approval
        </Button>
      }
    >
      <div className="space-y-4 text-[15px]">
        <p>Each reviewer gets an Inbox note. {v.published_at ? `Published v${v.draft?.base_version ?? v.version} stays live until they approve.` : "Nothing is published until they approve."}</p>
        <ul className="space-y-2" aria-label="Changes to send">
          {changes.map((c) => (
            <li key={c.change_id} className="rounded-md border border-[var(--simple-rule)] px-3 py-2">
              <span className="text-sm text-text-faint">{lineName(v, c.line_id)}</span>
              <Diff before={c.before} after={c.after} />
            </li>
          ))}
        </ul>
        <div>
          <p className="mb-2 font-semibold">Who approves</p>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2" data-testid="approvers">
              {required.map((p) => (
                <span key={p.id} className={CHIP}>
                  {p.name} <span className="text-text-faint">· required for this PRD</span>
                </span>
              ))}
              {added.map((p) => (
                <span key={p.id} className={CHIP}>
                  {p.name}
                  <button type="button" aria-label={`Remove ${p.name}`} className="ml-1 text-text-faint" onClick={() => setAdded(added.filter((x) => x.id !== p.id))}>
                    ×
                  </button>
                </span>
              ))}
              {!adding && <Button onClick={() => setAdding(true)}>+ Add a reviewer</Button>}
            </div>
            {adding && (
              <PersonPicker
                autoFocus
                exclude={[...required.map((p) => p.id), ...added.map((p) => p.id)]}
                onPick={(p) => {
                  setAdded([...added, { id: p.user_id, name: p.name ?? p.email }]);
                  setAdding(false);
                }}
              />
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * build-review (QV2 a, picked Nov 1): readers' bar of changes in review, with "See the N
 * changes": each change's part of the page, its old and new words, who made it and who it
 * waits on. The page itself stays the published version.
 */
export function InReviewBar({ v }: { v: View }) {
  const [open, setOpen] = useState(false);
  const n = v.changes_in_review;
  const word = `${n} ${n === 1 ? "change" : "changes"}`;
  return (
    <div className="simple-noprint border-b border-[var(--simple-rule)] text-base">
      <div role="status" className="flex flex-wrap items-center gap-3 px-4 py-2 text-text2">
        <span>
          {word} in review · {v.published_at ? "you read the published version" : `you read version ${v.version}, not published yet`}
        </span>
        {v.in_review.length > 0 && (
          <Button aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide the changes" : `See the ${word}`}
          </Button>
        )}
      </div>
      {open && (
        <ul aria-label="Changes in review" className="mx-auto max-w-[1180px] space-y-2 px-4 pb-3">
          {v.in_review.map((c, i) => (
            <li key={`${c.line_id}-${c.kind}-${i}`} className="rounded-md border border-[var(--simple-rule)] bg-surface px-3 py-2 text-[15px]">
              <span className="text-sm text-text-faint">
                {lineName(v, c.line_id)} · {c.kind === "proposal" ? `proposed by ${c.by_name}` : `edited by ${c.by_name}`}
                {c.waiting_on.length ? ` · waiting on ${c.waiting_on.map((p) => p.name).join(", ")}` : ""}
              </span>
              <Diff before={c.before} after={c.after} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** build-review (QV3 a, picked Nov 1): with a working draft, Present asks what to show. */
export function PresentMenu({ v, btnClass, label, onPick }: { v: View; btnClass: string; label: React.ReactNode; onPick: (show: "draft" | "published") => void }) {
  const [open, setOpen] = useState(false);
  const n = v.draft?.changes ?? 0;
  const item = "block w-full rounded px-3 py-2 text-left hover:bg-[var(--simple-edited)]";
  return (
    <span className="relative inline-flex">
      <button type="button" className={btnClass} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <div role="menu" aria-label="What to present" className="absolute top-full left-0 z-20 mt-1 w-[330px] max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-surface p-1 shadow-md">
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onPick("published"); }}>
            <span className="block font-semibold">Published v{v.draft?.base_version ?? v.version}</span>
            <span className="block text-sm text-text2">What everyone has approved</span>
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onPick("draft"); }}>
            <span className="block font-semibold">Working draft</span>
            <span className="block text-sm text-text2">
              With your {n} {n === 1 ? "change" : "changes"}, not yet approved
            </span>
          </button>
        </div>
      )}
    </span>
  );
}
