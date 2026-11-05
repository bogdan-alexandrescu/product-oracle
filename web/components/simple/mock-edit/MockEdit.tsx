"use client";
// MOCK-HOOK: this whole file is the mk-edit-decisions mock-up (never merged). Every line below is a MOCK-HOOK.
// MOCK-HOOK: ?ec1=a|b|c (decisions) and ?eq2=a|b|c (questions); &open=1, &phase=mid|done, &act=edit|reassign|withdraw|new, &long=1, &as=viewer|commenter.

import { useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Schemas } from "@/lib/api/client";

import { Icon } from "@/components/ds/Icon";
import { InfoTip } from "@/components/ds/InfoTip";
import { Sheet } from "@/components/ds/Sheet";
import { toast } from "@/components/ds/Toast";
import { calendarDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { MK_LONG, MK_LONG_Q, MK_PEOPLE, mkDecisionCan, mkDecisionFields, type MkDecisionFields } from "@/lib/api/mock/mk-edit-decisions";

export const FIELD =
  "w-full rounded-xl border border-line bg-surface px-3 py-2 text-[16px] leading-6 text-text placeholder:text-text2 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";
const LABEL = "text-[14px] font-semibold text-text2";
/** An edited row's mark: a warm fill and a bar on its left, strong enough in the dark theme too. */
export const EDITED = "bg-[var(--mk-edited)] shadow-[inset_4px_0_0_var(--mk-edited-bar)]";
/** A title that opens its sheet: underlined at rest, so it reads as a link. */
export const TITLE_LINK = "text-left font-[650] underline decoration-line-strong decoration-1 underline-offset-[5px] hover:decoration-accent";

/** The mock-up's own tokens (the edited mark) and, on a wide screen, room for an open sheet beside the list. */
export function MkStyles() {
  return (
    <style>{`:root{--mk-edited:#fff1bf;--mk-edited-bar:#d4a017}
:root[data-theme="dark"]{--mk-edited:#3b3110;--mk-edited-bar:#f2c94c}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--mk-edited:#3b3110;--mk-edited-bar:#f2c94c}}
@media (min-width: 1500px){html:has([data-testid="question-sheet"]) .simple-page{margin-left:auto;margin-right:480px}}`}</style>
  );
}

/** Delete sends an item to Settings > Trash, where it can be restored: the toast says so, with Undo. */
export function useTrashToast(deleted: boolean, label: string, undo: () => void) {
  useEffect(() => {
    if (deleted) toast({ message: `${label} is in Settings › Trash`, action: { label: "Undo", onClick: undo } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleted]);
}

export function useMk() {
  const p = useSearchParams();
  const v = (k: string) => {
    const x = p.get(k);
    return x === "a" || x === "b" || x === "c" ? x : null;
  };
  return { ec1: v("ec1"), eq2: v("eq2"), open: p.get("open") === "1", phase: p.get("phase") ?? "", act: p.get("act") ?? "edit", long: p.get("long") === "1", as: p.get("as") ?? "" };
}

/** Who may act, as Detailed's inspector reads it: can() and the decision's own can_edit, can_withdraw and can_reassign.
 * An owner (or the decider) changes; an approver who is not the decider proposes a change to the decider; a viewer reads. */
export function useDecisionPower(status: string, decider: string) {
  const { can, me } = useMe();
  const d = mkDecisionCan(me, decider, status);
  const power: "change" | "propose" | "read" = can("update_decision", d.can_edit) && d.can_edit ? "change" : status === "proposed" && can("create_decision") ? "propose" : "read";
  return { power, mayWithdraw: power === "change" && d.can_withdraw, mayReassign: power === "change" && d.can_reassign && can("reassign_decision") };
}

export type MkDecision = MkDecisionFields & { title: string; decider: string; withdrawn?: boolean; deleted?: boolean; edited?: boolean; suggested?: boolean };

export function seedDecision(title: string, decider: string, long: boolean): MkDecision {
  return { ...(long ? MK_LONG : mkDecisionFields(title)), title, decider };
}

/** The canned edit the mid and done frames show (the same one each time): an option added and, but in c (one field at a time), the review day moved. */
export function cannedEdit(d: MkDecision, v: string | null): MkDecision {
  return { ...d, options: [...d.options, "Ship to pilot customers first"], review_on: v === "c" ? d.review_on : "2026-12-07", edited: true };
}

const dayWords = (iso: string) => calendarDay(iso, { month: "short", day: "numeric", year: "numeric" });

/* ---------------- shared pieces ---------------- */

export function RowMenu({ items, open, onOpen, label }: { items: { label: string; onClick: () => void; danger?: boolean }[]; open: boolean; onOpen: (o: boolean) => void; label: string }) {
  if (!items.length) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" aria-label={`More for ${label}`} aria-expanded={open} className="simple-button simple-button-quiet !min-h-9 !px-2" onClick={() => onOpen(!open)}>
        <Icon name="more" size={20} stroke={1.7} />
      </button>
      {open && (
        <span role="menu" className="flex w-[200px] flex-col rounded-xl border border-line bg-surface p-1 shadow-lg">
          {items.map((i) => (
            <button key={i.label} role="menuitem" type="button" className={`rounded-lg px-3 py-2 text-left text-[16px] hover:bg-surface2 ${i.danger ? "text-[var(--crit)]" : ""}`} onClick={i.onClick}>
              {i.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function Field({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={`${LABEL} flex items-center gap-1`}>
        {label}
        {tip && (
          <InfoTip label={label} align="start">
            {tip}
          </InfoTip>
        )}
      </span>
      {children}
    </label>
  );
}

export function OptionsEditor({ options, onChange }: { options: string[]; onChange: (o: string[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((o, i) => (
        <span key={i} className="flex items-center gap-2">
          <input aria-label={`Option ${i + 1}`} className={FIELD} value={o} onChange={(e) => onChange(options.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" aria-label={`Remove option ${i + 1}`} className="simple-button simple-button-quiet !min-h-9 !px-2" onClick={() => onChange(options.filter((_, j) => j !== i))}>
            <Icon name="x" size={18} stroke={1.7} />
          </button>
        </span>
      ))}
      <button type="button" className="simple-more !mt-0 self-start" onClick={() => onChange([...options, ""])}>
        + Add an option
      </button>
    </div>
  );
}

export function PeopleList({ current, onPick, verb }: { current: string; onPick: (p: string) => void; verb: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3" role="group" aria-label={`Who ${verb}`}>
      <input className={FIELD} placeholder="Find a person" aria-label="Find a person" />
      <ul className="flex flex-col">
        {MK_PEOPLE.map((p) => (
          <li key={p}>
            <button type="button" aria-pressed={p === current} className={`w-full rounded-lg px-3 py-2 text-left hover:bg-surface2 ${p === current ? "bg-accent-soft font-[650] text-accent-ink" : ""}`} onClick={() => onPick(p)}>
              {p}
              {p === current ? ` · ${verb} now` : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The form every proposal shares: title, question, context, options, review date. */
export function DecisionForm({ d, onChange, compact = false, pickDecider = false }: { d: MkDecision; onChange: (d: MkDecision) => void; compact?: boolean; pickDecider?: boolean }) {
  return (
    <div className={`flex flex-col ${compact ? "gap-3" : "gap-4"}`}>
      <Field label="Title">
        <input className={FIELD} value={d.title} onChange={(e) => onChange({ ...d, title: e.target.value })} />
      </Field>
      <Field label="Question">
        <textarea rows={2} className={FIELD} value={d.question} onChange={(e) => onChange({ ...d, question: e.target.value })} />
      </Field>
      <Field label="Context">
        <textarea rows={compact ? 2 : 4} className={FIELD} value={d.context} onChange={(e) => onChange({ ...d, context: e.target.value })} />
      </Field>
      <Field label="Options">
        <OptionsEditor options={d.options} onChange={(options) => onChange({ ...d, options })} />
      </Field>
      <Field label="Review on" tip="The day the decider looks at this call again.">
        <span className={`${FIELD} flex max-w-[220px] items-center justify-between`} role="button" tabIndex={0} aria-label="Review on, pick a day">
          {dayWords(d.review_on)}
          <Icon name="clock" size={18} stroke={1.7} />
        </span>
      </Field>
      {pickDecider && (
        <Field label="Decides">
          <select className="simple-select max-w-[260px]" value={d.decider} onChange={(e) => onChange({ ...d, decider: e.target.value })}>
            {MK_PEOPLE.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}

export function DecisionDetails({ d }: { d: MkDecision }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[16px] max-[600px]:grid-cols-1">
      <dt className={LABEL}>Question</dt>
      <dd className="break-words">{d.question}</dd>
      <dt className={LABEL}>Context</dt>
      <dd className="break-words">{d.context}</dd>
      <dt className={LABEL}>Options</dt>
      <dd>
        <ol className="list-decimal pl-5">
          {d.options.map((o) => <li key={o}>{o}</li>)}
        </ol>
      </dd>
      <dt className={LABEL}>Review on</dt>
      <dd>{dayWords(d.review_on)}</dd>
    </dl>
  );
}

/* ---------------- Decision 1: a decision row ---------------- */

/** One open decision's row under ec1: its title and meta come from the page; the variant adds its controls. */
export function DecisionEditRow({ title, decider, status, meta, first, long, code }: { title: string; decider: string; status: string; meta: string; first: boolean; long: boolean; code: string }) {
  const mk = useMk();
  const { power, mayWithdraw, mayReassign } = useDecisionPower(status, decider);
  const target = first && mk.long === long && mk.act !== "new";
  const start = seedDecision(title, decider, long);
  // The canned edit is only the edited example's: the hard case opens D-80 as it is.
  const edit = (x: MkDecision) => (long ? x : cannedEdit(x, mk.ec1));
  const preset =
    target && mk.phase === "done"
      ? mk.act === "withdraw"
        ? { ...start, withdrawn: true }
        : mk.act === "delete"
          ? { ...start, deleted: true }
          : mk.act === "reassign"
            ? { ...start, decider: "Mei Tanaka", edited: true }
            : power === "propose"
              ? { ...edit(start), edited: false, suggested: true }
              : edit(start)
      : start;
  const [d, setD] = useState<MkDecision>(preset);
  const [draft, setDraft] = useState<MkDecision>(target && mk.phase === "mid" ? edit(start) : start);
  const initial = target && (mk.open || mk.phase === "mid") ? (mk.ec1 === "a" && mk.open && mk.phase !== "mid" && mk.act === "edit" ? "menu" : mk.act) : null;
  const [mode, setMode] = useState<string | null>(initial);
  const [expanded, setExpanded] = useState(target && mk.ec1 === "c" && (mk.open || mk.phase !== ""));
  useTrashToast(!!d.deleted, `${code} ${d.title}`, () => setD({ ...d, deleted: false }));
  const save = (next: MkDecision) => {
    setD(power === "propose" ? { ...next, edited: false, suggested: true } : { ...next, edited: true });
    setMode(null);
  };
  const withdraw = () => { setD({ ...d, withdrawn: true }); setMode(null); };
  const remove = () => { setD({ ...d, deleted: true }); setMode(null); };
  const v = mk.ec1;
  const changes = power === "change";
  const verbSave = changes ? "Save" : `Suggest to ${d.decider}`;
  const icon = (
    <span aria-hidden className="simple-ico">
      <Icon name="flag" size={20} stroke={1.7} />
    </span>
  );
  if (d.deleted) return null;
  if (d.withdrawn)
    return (
      <li className="flex !items-start gap-[14px] border-t border-line py-[14px] opacity-80" data-testid="decision-row">
        <span aria-hidden className="simple-ico">
          <Icon name="x" size={20} stroke={1.7} />
        </span>
        <span className="simple-rb flex-1">
          <span>
            <span className="simple-code">{code}</span> <s className="font-[650]">{d.title}</s>
          </span>
          <span className="simple-meta">Withdrawn by you just now · kept in the history</span>
        </span>
        <button type="button" className="simple-button" onClick={() => setD({ ...d, withdrawn: false })}>
          Undo
        </button>
      </li>
    );
  const metaLine = [`${d.decider} decides`, meta, d.suggested ? `your change waits for ${d.decider}` : null, d.edited ? "edited just now" : null].filter(Boolean).join(" · ");
  const titleEl = (
    <span className="break-words">
      <span className="simple-code">{code}</span>{" "}
      {v === "b" ? (
        <button type="button" className={TITLE_LINK} onClick={() => setMode("sheet")}>
          {d.title}
        </button>
      ) : (
        <b className="font-[650]">{d.title}</b>
      )}
    </span>
  );
  const mark = d.edited || d.suggested ? EDITED : "";
  /* a: the row menu (Edit, Reassign, Withdraw, Delete); Edit opens the form in the row. */
  if (v === "a") {
    const items =
      power === "read"
        ? []
        : changes
          ? [
              { label: "Edit", onClick: () => { setDraft(d); setMode("edit"); } },
              ...(mayReassign ? [{ label: "Reassign", onClick: () => setMode("reassign") }] : []),
              ...(mayWithdraw ? [{ label: "Withdraw", onClick: () => setMode("withdraw") }, { label: "Delete", onClick: remove, danger: true }] : []),
            ]
          : [{ label: "Suggest a change", onClick: () => { setDraft(d); setMode("edit"); } }];
    return (
      <li className={`flex flex-wrap !items-start gap-[14px] border-t border-line py-[14px] ${mark}`} data-testid="decision-row">
        {icon}
        <span className="simple-rb min-w-0 flex-1">
          {titleEl}
          <span className="simple-meta">{metaLine}</span>
        </span>
        <RowMenu label={d.title} items={items} open={mode === "menu"} onOpen={(o) => setMode(o ? "menu" : null)} />
        <div className="basis-full pl-[54px] empty:hidden max-[600px]:pl-0">
          {mode === "edit" && (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line p-4">
              <DecisionForm d={draft} onChange={setDraft} compact />
              <span className="flex gap-2">
                <button type="button" className="simple-button simple-button-primary" onClick={() => save(draft)}>
                  {verbSave}
                </button>
                <button type="button" className="simple-button" onClick={() => setMode(null)}>
                  Cancel
                </button>
              </span>
            </div>
          )}
          {mode === "reassign" && <div className="mt-3"><PeopleList current={d.decider} verb="decides" onPick={(p) => { setD({ ...d, decider: p, edited: true }); setMode(null); }} /></div>}
          {mode === "withdraw" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line p-3">
              <span className="flex flex-1 items-center gap-1">
                Withdraw {code}?
                <InfoTip label="Withdraw" align="start">
                  Not now: it stays in the history, and Undo brings it back.
                </InfoTip>
              </span>
              <button type="button" className="simple-button simple-button-primary" onClick={withdraw}>
                Withdraw
              </button>
              <button type="button" className="simple-button" onClick={() => setMode(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </li>
    );
  }
  /* b: the title opens the decision's sheet: every field, the decider, Withdraw and Delete at its foot. */
  if (v === "b") {
    return (
      <li className={`flex !items-start gap-[14px] border-t border-line py-[14px] ${mark}`} data-testid="decision-row">
        {icon}
        <span className="simple-rb min-w-0 flex-1">
          {titleEl}
          <span className="simple-meta">{metaLine}</span>
        </span>
        <DecisionSheet
          open={mode !== null && mode !== "menu"}
          d={d}
          power={power}
          mayReassign={mayReassign}
          mayWithdraw={mayWithdraw}
          code={code}
          startEditing={mode === "edit" || (target && mk.phase === "mid")}
          startDraft={draft}
          startPeople={mode === "reassign"}
          onClose={() => setMode(null)}
          onSave={(n) => save(n)}
          onWithdraw={withdraw}
          onDelete={remove}
        />
      </li>
    );
  }
  /* c: in place: a chevron shows every field under the title, each one edited where it is. */
  return (
    <li className={`flex !items-start gap-[14px] border-t border-line py-[14px] ${mark}`} data-testid="decision-row">
      {icon}
      <span className="simple-rb min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            {power !== "read" && expanded ? (
              <InPlace value={d.title} label="Title" bold power={power} onSave={(t) => save({ ...d, title: t })} prefix={<span className="simple-code mr-1">{code}</span>} />
            ) : (
              titleEl
            )}
          </span>
          <button type="button" aria-expanded={expanded} aria-label={expanded ? "Hide details" : "Show details"} className="simple-button simple-button-quiet !min-h-9 !px-2" onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={20} stroke={1.7} />
          </button>
        </span>
        <span className="simple-meta">{metaLine}</span>
        {expanded && (
          <div className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
            <InPlace label="Question" value={d.question} power={power} onSave={(t) => save({ ...d, question: t })} />
            <InPlace label="Context" value={d.context} power={power} multiline onSave={(t) => save({ ...d, context: t })} />
            <InPlaceOptions d={d} power={power} startOpen={target && mk.phase === "mid"} extra={long ? null : "Ship to pilot customers first"} onSave={(o) => save({ ...d, options: o })} />
            <InPlace label="Review on" value={dayWords(d.review_on)} power={power} onSave={() => save(d)} />
            <span className="flex flex-wrap items-center gap-2">
              <span className={LABEL}>Decides</span>
              {mayReassign ? (
                <button type="button" className="simple-link underline decoration-line-strong underline-offset-[5px]" onClick={() => setMode(mode === "reassign" ? null : "reassign")}>
                  {d.decider}
                </button>
              ) : (
                <span>{d.decider}</span>
              )}
              {mayWithdraw && (
                <span className="ml-auto flex gap-4">
                  <button type="button" className="simple-more !mt-0" onClick={withdraw}>
                    Withdraw
                  </button>
                  <button type="button" className="simple-more !mt-0 !text-[var(--crit)]" onClick={remove}>
                    Delete
                  </button>
                </span>
              )}
            </span>
            {mode === "reassign" && <PeopleList current={d.decider} verb="decides" onPick={(p) => { setD({ ...d, decider: p, edited: true }); setMode(null); }} />}
          </div>
        )}
      </span>
    </li>
  );
}

function InPlace({ label, value, onSave, power, multiline, bold, prefix }: { label: string; value: string; onSave: (v: string) => void; power: string; multiline?: boolean; bold?: boolean; prefix?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing)
    return (
      <span className="flex flex-col gap-2">
        {multiline ? <textarea aria-label={label} rows={3} className={FIELD} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus /> : <input aria-label={label} className={FIELD} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />}
        <span className="flex gap-2">
          <button type="button" className="simple-button simple-button-primary" onClick={() => { onSave(draft); setEditing(false); }}>
            {power === "change" ? "Save" : "Suggest"}
          </button>
          <button type="button" className="simple-button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </span>
      </span>
    );
  return (
    <span className="group flex items-start gap-2 max-[600px]:flex-wrap">
      {!bold && <span className={`${LABEL} w-[90px] shrink-0 pt-0.5 max-[600px]:basis-full`}>{label}</span>}
      <span className={`min-w-0 flex-1 break-words ${bold ? "font-[650]" : ""}`}>
        {prefix}
        {value}
      </span>
      {power !== "read" && (
        <button type="button" aria-label={`${power === "change" ? "Edit" : "Suggest a change to"} ${label.toLowerCase()}`} className="text-accent-ink hover:underline" onClick={() => { setDraft(value); setEditing(true); }}>
          <span className="text-[14px] font-[650] underline-offset-2 hover:underline">{power === "change" ? "Edit" : "Suggest"}</span>
        </button>
      )}
    </span>
  );
}

function InPlaceOptions({ d, power, startOpen, extra, onSave }: { d: MkDecision; power: string; startOpen: boolean; extra: string | null; onSave: (o: string[]) => void }) {
  const [editing, setEditing] = useState(startOpen);
  const [draft, setDraft] = useState(startOpen && extra ? [...d.options, extra] : d.options);
  return (
    <span className="group flex items-start gap-2 max-[600px]:flex-wrap">
      <span className={`${LABEL} w-[90px] shrink-0 pt-0.5 max-[600px]:basis-full`}>Options</span>
      {editing ? (
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <OptionsEditor options={draft} onChange={setDraft} />
          <span className="flex gap-2">
            <button type="button" className="simple-button simple-button-primary" onClick={() => { onSave(draft); setEditing(false); }}>
              {power === "change" ? "Save" : "Suggest"}
            </button>
            <button type="button" className="simple-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        </span>
      ) : (
        <>
          <ol className="min-w-0 flex-1 list-decimal pl-5">{d.options.map((o) => <li key={o}>{o}</li>)}</ol>
          {power !== "read" && (
            <button type="button" aria-label="Edit options" className="text-accent-ink hover:underline" onClick={() => { setDraft(d.options); setEditing(true); }}>
              <span className="text-[14px] font-[650] underline-offset-2 hover:underline">{power === "change" ? "Edit" : "Suggest"}</span>
            </button>
          )}
        </>
      )}
    </span>
  );
}

/** b's sheet (the side on a desktop, the bottom on a phone), the same for a new decision. */
export function DecisionSheet({ open, d, power, mayReassign = false, mayWithdraw = false, code, startEditing, startDraft, startPeople = false, onClose, onSave, onWithdraw, onDelete, isNew = false }: { open: boolean; d: MkDecision; power: string; mayReassign?: boolean; mayWithdraw?: boolean; code: string; startEditing: boolean; startDraft: MkDecision; startPeople?: boolean; onClose: () => void; onSave: (d: MkDecision) => void; onWithdraw: () => void; onDelete: () => void; isNew?: boolean }) {
  const [editing, setEditing] = useState(startEditing || isNew);
  const [draft, setDraft] = useState(startEditing ? startDraft : d);
  const [people, setPeople] = useState(startPeople);
  const changes = power === "change";
  return (
    <Sheet open={open} title={isNew ? (changes ? "New decision" : "Propose a decision") : `${code} ${d.title}`} onClose={onClose} side testId="decision-sheet">
      <div className="flex flex-col gap-4 p-1">
        {editing ? (
          <DecisionForm d={draft} onChange={setDraft} />
        ) : (
          <DecisionDetails d={d} />
        )}
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="flex items-center gap-2">
            <span className={LABEL}>Decides</span>
            <span className="flex-1">{(isNew ? draft : d).decider}</span>
            {(isNew ? changes : mayReassign) && (
              <button type="button" className="simple-button" aria-expanded={people} onClick={() => setPeople(!people)}>
                {isNew ? "Pick" : "Reassign"}
              </button>
            )}
          </span>
          {people && <PeopleList current={(isNew ? draft : d).decider} verb="decides" onPick={(p) => { if (isNew || editing) setDraft({ ...draft, decider: p }); else onSave({ ...d, decider: p }); setPeople(false); }} />}
        </div>
        {power !== "read" && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {editing ? (
              <>
                <button type="button" className="simple-button simple-button-primary" onClick={() => { onSave(draft); setEditing(false); }}>
                  {isNew ? (changes ? "Add decision" : `Send to ${draft.decider}`) : changes ? "Save" : `Suggest to ${d.decider}`}
                </button>
                <button type="button" className="simple-button" onClick={() => (isNew ? onClose() : setEditing(false))}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="simple-button simple-button-primary" onClick={() => { setDraft(d); setEditing(true); }}>
                  {changes ? "Edit" : "Suggest a change"}
                </button>
                {mayWithdraw && (
                  <span className="ml-auto flex gap-2">
                    <button type="button" className="simple-button" onClick={onWithdraw}>
                      Withdraw
                    </button>
                    <button type="button" className="simple-button !text-[var(--crit)]" onClick={onDelete}>
                      Delete
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** "+ New decision" at the page's top (a and b); c adds a "Propose a decision" row at the list's foot instead. */
export function NewDecision({ onAdd }: { onAdd: (title: string, decider: string) => void }) {
  const mk = useMk();
  const { can } = useMe();
  const changes = can("create_decision") && can("recommend_decision_options");
  const propose = !changes && can("create_decision");
  const [open, setOpen] = useState(mk.open && mk.act === "new");
  const blank: MkDecision = { title: mk.phase === "mid" ? "Offer a yearly plan at launch" : "", question: mk.phase === "mid" ? "Do we sell a yearly plan from day one?" : "", context: "", options: mk.phase === "mid" ? ["Yes, 15% off", "Monthly only for now"] : ["", ""], review_on: "2026-12-15", decider: "Priya Nair" };
  if (!mk.ec1 || (!changes && !propose)) return null;
  if (mk.ec1 === "c") return null;
  return (
    <>
      <button type="button" className="simple-button simple-button-primary self-start" onClick={() => setOpen(true)} data-testid="mk-new-decision">
        <Icon name="plus" size={18} stroke={1.7} />
        {changes ? "New decision" : "Propose a decision"}
      </button>
      {mk.ec1 === "b" && <DecisionSheet open={open} isNew d={blank} power={changes ? "change" : "propose"} code="" startEditing startDraft={blank} onClose={() => setOpen(false)} onSave={(n) => { onAdd(n.title, n.decider); setOpen(false); }} onWithdraw={() => {}} onDelete={() => {}} />}
      {mk.ec1 === "a" && open && (
        <NewInline blank={blank} changes={changes} onCancel={() => setOpen(false)} onAdd={(t, p) => { onAdd(t, p); setOpen(false); }} />
      )}
    </>
  );
}

function NewInline({ blank, changes, onCancel, onAdd }: { blank: MkDecision; changes: boolean; onCancel: () => void; onAdd: (t: string, decider: string) => void }) {
  const [draft, setDraft] = useState(blank);
  return (
    <section className="simple-card" aria-label="New decision">
      <h2 className="simple-h2">{changes ? "New decision" : "Propose a decision"}</h2>
      <DecisionForm d={draft} onChange={setDraft} compact pickDecider />
      <span className="flex gap-2">
        <button type="button" className="simple-button simple-button-primary" onClick={() => onAdd(draft.title, draft.decider)}>
          {changes ? "Add decision" : `Send to ${draft.decider}`}
        </button>
        <button type="button" className="simple-button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </section>
  );
}

/** c: the list's last row, "Propose a decision": type its title, Enter adds it; the rest is filled in its row. */
export function NewDecisionRow({ onAdd }: { onAdd: (t: string, decider: string) => void }) {
  const mk = useMk();
  const { can } = useMe();
  const [t, setT] = useState(mk.act === "new" && mk.phase === "mid" ? "Offer a yearly plan at launch" : "");
  const [who, setWho] = useState("Priya Nair");
  if (mk.ec1 !== "c" || !can("create_decision")) return null;
  return (
    <li className="flex items-center gap-[14px] border-t border-line py-[14px]">
      <span aria-hidden className="simple-ico">
        <Icon name="plus" size={20} stroke={1.7} />
      </span>
      <input className={`${FIELD} min-w-0 flex-1`} placeholder={can("recommend_decision_options") ? "New decision: what needs deciding?" : "Propose a decision: what needs deciding?"} value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && t.trim()) { onAdd(t.trim(), who); setT(""); } }} autoFocus={mk.act === "new" && mk.open} />
      <select className="simple-select" aria-label="Decides" value={who} onChange={(e) => setWho(e.target.value)}>
        {MK_PEOPLE.map((p) => <option key={p} value={p}>{p} decides</option>)}
      </select>
      {t && (
        <button type="button" className="simple-button simple-button-primary" onClick={() => { onAdd(t.trim(), who); setT(""); }}>
          Add
        </button>
      )}
    </li>
  );
}

/* ---------------- Decision 2: a PRD's open question ---------------- */


type Q = Schemas["SimpleQuestion"];
export type MkQ = { title: string; recommendation: string; options: string[]; withdrawn: boolean; edited: boolean; suggested: boolean; deleted?: boolean };

/** c: the list's Edit mode (every row a form at once). */
export const MkEditAll = createContext<{ on: boolean; set: (on: boolean) => void }>({ on: false, set: () => {} });

export const qPower = (q: Q): "change" | "propose" | "read" => (q.can.decide ? "change" : q.can.propose ? "propose" : "read");

const Q_EDIT = { title: "Do weekly digests include muted alerts?", recommendation: "Leave muted alerts out, with a count at the foot", extra: "Only when a muted alert fired three times" };

/** A question's own state in the mock-up: the target row starts opened, mid-edit or done, as the address says. */
export function useMkQuestion(q: Q, target: boolean) {
  const mk = useMk();
  const power = qPower(q);
  const long = target && mk.long;
  const base: MkQ = { title: long ? MK_LONG_Q.title : q.title, recommendation: long ? MK_LONG_Q.recommendation : q.recommendation ?? "", options: long ? MK_LONG_Q.options : q.alternatives.map((a) => a.label), withdrawn: false, edited: false, suggested: false };
  // The canned edit is only the edited example's (Q5): the hard case opens the long question as it is.
  const changed: MkQ = long ? base : { ...base, title: Q_EDIT.title, recommendation: Q_EDIT.recommendation, options: [...base.options, Q_EDIT.extra] };
  const t = target && !!mk.eq2 && mk.act !== "new";
  const done = t && mk.phase === "done";
  // Withdrawn and deleted start from the edited question (the done frame before them).
  const [s, setS] = useState<MkQ>(done ? (mk.act === "withdraw" ? { ...changed, edited: true, withdrawn: true } : mk.act === "delete" ? { ...changed, edited: true, deleted: true } : power === "propose" ? { ...changed, title: base.title, recommendation: base.recommendation, options: base.options, suggested: true } : { ...changed, edited: true }) : base);
  const [draft, setDraft] = useState<MkQ>(t && mk.phase === "mid" ? changed : base);
  const [mode, setMode] = useState<string | null>(t && (mk.open || mk.phase === "mid") ? (mk.eq2 === "a" && mk.open && mk.phase !== "mid" ? "menu" : mk.act) : null);
  const save = (n: MkQ) => {
    setS(power === "propose" ? { ...s, suggested: true } : { ...n, edited: true });
    setMode(null);
  };
  useTrashToast(!!s.deleted, `${q.code} ${s.title}`, () => setS({ ...s, deleted: false }));
  return { mk, power, s, setS, draft, setDraft, mode, setMode, save, target: t };
}

export function QuestionForm({ d, onChange, prd }: { d: MkQ; onChange: (d: MkQ) => void; prd?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Question">
        <textarea rows={2} className={FIELD} value={d.title} onChange={(e) => onChange({ ...d, title: e.target.value })} />
      </Field>
      <Field label={prd ? `Recommended in ${prd}` : "Recommendation"}>
        <textarea rows={2} className={FIELD} value={d.recommendation} placeholder="None yet" onChange={(e) => onChange({ ...d, recommendation: e.target.value })} />
      </Field>
      <Field label="Other answers">
        <OptionsEditor options={d.options} onChange={(options) => onChange({ ...d, options })} />
      </Field>
    </div>
  );
}

/** The row's withdrawn state: struck through, kept in the history, Undo. */
export function WithdrawnQuestion({ code, title, onUndo }: { code: string; title: string; onUndo: () => void }) {
  return (
    <li className="simple-row opacity-80" data-testid="question-row">
      <span aria-hidden className="simple-ico">
        <Icon name="x" size={20} stroke={1.7} />
      </span>
      <div className="simple-rb">
        <span>
          <span className="simple-code">{code}</span> <s className="font-[650]">{title}</s>
        </span>
        <span className="simple-meta">Withdrawn by you just now · kept in the PRD&apos;s history</span>
      </div>
      <div className="simple-actions min-[601px]:w-[232px]">
        <button type="button" className="simple-button" onClick={onUndo}>
          Undo
        </button>
      </div>
    </li>
  );
}

/** b: the question's sheet, the same shape as a decision's. */
export function QuestionSheet({ open, q, m, isNew = false, onClose, onAdd }: { open: boolean; q?: Q; m?: ReturnType<typeof useMkQuestion>; isNew?: boolean; onClose: () => void; onAdd?: (q: MkQ) => void }) {
  const mk = useMk();
  const blank: MkQ = mk.phase === "mid" ? { title: "Who can export a team's alert history?", recommendation: "Owners only, from Settings", options: ["Every member", "Owners and approvers"], withdrawn: false, edited: false, suggested: false } : { title: "", recommendation: "", options: ["", ""], withdrawn: false, edited: false, suggested: false };
  const [editing, setEditing] = useState(isNew || m?.mode === "edit");
  const [nd, setNd] = useState(blank);
  const power = m?.power ?? "change";
  const d = isNew ? nd : editing ? m!.draft : m!.s;
  const set = isNew ? setNd : m ? m.setDraft : () => {};
  return (
    <Sheet open={open} title={isNew ? (power === "change" ? "Ask a question" : "Suggest a question") : `${q!.code} ${m!.s.title}`} onClose={onClose} side testId="question-sheet">
      <div className="flex flex-col gap-4 p-1">
        {isNew && (
          <Field label="PRD">
            <select className={`simple-select w-full`} defaultValue="alerts">
              <option value="alerts">Usage alerts PRD</option>
              <option value="onboarding">Team onboarding PRD</option>
            </select>
          </Field>
        )}
        {editing ? (
          <QuestionForm d={d} onChange={set} prd={q?.prd.title} />
        ) : (
          <dl className="flex flex-col gap-1 text-[16px]">
            <dt className={LABEL}>Recommended in {q!.prd.title}</dt>
            <dd>{d.recommendation || "None yet"}</dd>
            <dt className={`${LABEL} mt-2`}>Other answers</dt>
            <dd>
              <ul className="list-disc pl-5">{d.options.map((o) => <li key={o}>{o}</li>)}</ul>
            </dd>
            <dt className={`${LABEL} mt-2`}>Decides</dt>
            <dd>{q!.decider?.name ?? "No decider yet"}</dd>
          </dl>
        )}
        {power !== "read" && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {editing ? (
              <>
                <button type="button" className="simple-button simple-button-primary" onClick={() => { if (isNew) onAdd?.(nd); else { m!.save(m!.draft); setEditing(false); } }}>
                  {isNew ? (power === "change" ? "Add question" : "Send to the PRD's owner") : power === "change" ? "Save" : "Suggest"}
                </button>
                <button type="button" className="simple-button" onClick={() => (isNew ? onClose() : setEditing(false))}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="simple-button simple-button-primary" onClick={() => { m!.setDraft(m!.s); setEditing(true); }}>
                  {power === "change" ? "Edit" : "Suggest a change"}
                </button>
                {power === "change" && (
                  <span className="ml-auto flex gap-2">
                    <button type="button" className="simple-button" onClick={() => { m!.setS({ ...m!.s, withdrawn: true }); onClose(); }}>
                      Withdraw
                    </button>
                    <button type="button" className="simple-button !text-[var(--crit)]" onClick={() => { m!.setS({ ...m!.s, deleted: true }); onClose(); }}>
                      Delete
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** a: the list's last row, "Ask a question": a line to type in, the PRD beside it. c: the same row in Edit mode. */
export function AskQuestionRow({ onAdd }: { onAdd: (t: string) => void }) {
  const mk = useMk();
  const [t, setT] = useState(mk.act === "new" && mk.phase === "mid" ? "Who can export a team's alert history?" : "");
  return (
    <li className="simple-row" data-testid="mk-ask-row">
      <span aria-hidden className="simple-ico">
        <Icon name="plus" size={20} stroke={1.7} />
      </span>
      <div className="simple-rb flex !flex-row flex-wrap gap-2">
        <input className={`${FIELD} min-w-[220px] flex-1`} placeholder="Ask a question" aria-label="Ask a question" value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && t.trim()) { onAdd(t.trim()); setT(""); } }} autoFocus={mk.act === "new" && mk.open} />
        <select className="simple-select" aria-label="PRD" defaultValue="alerts">
          <option value="alerts">Usage alerts PRD</option>
          <option value="onboarding">Team onboarding PRD</option>
        </select>
      </div>
      <div className="simple-actions min-[601px]:w-[232px]">
        <button type="button" className="simple-button simple-button-primary" disabled={!t.trim()} onClick={() => { onAdd(t.trim()); setT(""); }}>
          Add
        </button>
      </div>
    </li>
  );
}

/** A question just added in the mock-up: no decider or recommendation yet. */
export function AddedQuestion({ q: { title, recommendation, options }, code }: { q: MkQ; code: string }) {
  const answers = options.filter(Boolean);
  return (
    <li className={`simple-row ${EDITED}`} data-testid="question-row">
      <span aria-hidden className="simple-ico">
        <Icon name="flag" size={20} stroke={1.7} />
      </span>
      <div className="simple-rb">
        <span>
          <span className="simple-code">{code}</span> <b className="font-[650]">{title}</b>
        </span>
        <span className="simple-meta">Usage alerts PRD · added by you just now</span>
        {recommendation ? (
          <span className="simple-rec">
            <span className="simple-rec-label">Recommended in Usage alerts PRD:</span> {recommendation}
          </span>
        ) : (
          <span className="simple-meta">No recommendation in the PRD yet.</span>
        )}
        {answers.length > 0 && <span className="simple-meta">Other answers: {answers.join(" · ")}</span>}
        <span className="simple-meta">No decider yet</span>
      </div>
      <div className="simple-actions min-[601px]:w-[232px]">
        <button type="button" className="simple-button simple-button-primary">
          Name a decider
        </button>
      </div>
    </li>
  );
}

export function useMkEditAll() {
  return useContext(MkEditAll);
}
