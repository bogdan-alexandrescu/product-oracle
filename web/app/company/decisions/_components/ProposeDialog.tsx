"use client";

import { useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { optionKey, personName, personOption, type Decision, type DecisionOption, type Person } from "./lib";
import { LinksPicker, type Links } from "./LinksPicker";

/** An option as typed; `key` keeps an existing option's key (and so its evidence and recommendation). */
export type Draft = { key?: string; label: string; summary: string; pros: string; cons: string; cost: string };
export const empty = (): Draft => ({ label: "", summary: "", pros: "", cons: "", cost: "" });
/**
 * qa-company-5: a field of the propose form. The label's semibold stops at the field, and a
 * placeholder is a dim example ("e.g. …"), never something that reads as filled in.
 */
const FIELD = `${INPUT} font-normal placeholder:text-text-faint/80`;

export const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Propose decision (commenter and above): the call in one sentence, the question, two to six
 * options, the one approver (approver and above), reversibility, contributors and informed,
 * the baseline items and evidence it rests on and what it is about. `subject`: what it is
 * about to begin with, when the page was opened for one (?subject=kind:id).
 */
export function ProposeDialog({
  people,
  subject,
  onClose,
  onProposed,
}: {
  people: Person[];
  subject: Schemas["Subject"] | null;
  onClose: () => void;
  onProposed: (d: Decision) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const approvers = people.filter((p) => hasRole(p.role, "approver"));
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<Draft[]>([empty(), empty()]);
  const [approver, setApprover] = useState("");
  const [reversibility, setReversibility] = useState<"reversible" | "irreversible">("reversible");
  const [contributors, setContributors] = useState<string[]>([]);
  const [informed, setInformed] = useState<string[]>([]);
  const [links, setLinks] = useState<Links>({ entity_ids: [], evidence_ids: [], subjects: subject ? [subject] : [] });
  const [error, setError] = useState<string | null>(null);
  // A missing field's note sits under that field, which is marked invalid; qa4-company-9: every
  // missing field is marked at once, and the first is scrolled to and focused.
  const [invalid, setInvalid] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // qa-company-46: the page under the dialog does not scroll, so only the dialog's own
  // scrollbar shows (the page's beside it pushed the dialog off centre on a phone).
  useEffect(() => {
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = overflow;
    };
  }, []);

  function flag(notes: Partial<Record<Field, string>>) {
    setError(null);
    setInvalid(notes);
    const first = FIELDS.find((f) => notes[f]);
    // After the render that marks them: scroll the first into view and put the cursor in it.
    requestAnimationFrame(() => {
      const el = form.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
    });
  }
  const noteOf = (field: Field) => invalid[field] ?? null;
  const clear = (field: Field) => setInvalid((all) => (all[field] ? { ...all, [field]: undefined } : all));

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const filled = options.filter((o) => o.label.trim());
    const notes: Partial<Record<Field, string>> = {
      ...(!title.trim() ? { title: "Write the decision in one sentence" } : {}),
      ...(filled.length < 2 ? { options: "Add at least two options" } : {}),
      ...(!approver ? { approver: "Name the approver" } : {}),
    };
    if (Object.keys(notes).length > 0) return flag(notes);
    setBusy(true);
    setError(null);
    setInvalid({});
    const body: Schemas["DecisionCreate"] = {
      title: title.trim(),
      question: question.trim() || null,
      options: optionsOf(filled),
      approver_id: approver,
      reversibility,
      contributor_ids: contributors,
      informed_ids: informed,
      evidence_ids: links.evidence_ids,
      entity_ids: links.entity_ids,
      subjects: links.subjects,
    };
    try {
      onProposed(await unwrap(api.POST("/v1/decisions", { body })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // qa-company-46: on a phone a full-width sheet, edge to edge.
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:p-0">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="propose-decision-title"
        tabIndex={-1}
        className="w-full max-w-2xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none max-[600px]:min-h-full max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:border-0"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="propose-decision-title" className="font-display text-xl font-bold tracking-heading">
            Propose decision
          </h2>
        </div>
        <form ref={form} className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Decision
              <input
                data-autofocus
                data-field="title"
                className={FIELD}
                value={title}
                maxLength={200}
                aria-invalid={noteOf("title") ? true : undefined}
                aria-describedby={noteOf("title") ? "propose-note-title" : undefined}
                onChange={(e) => {
                  setTitle(e.target.value);
                  clear("title");
                }}
                placeholder="e.g. Offer annual billing at launch"
              />
            </label>
            <FieldNote id="propose-note-title" note={noteOf("title")} />
          </div>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Question
            <input className={FIELD} value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Do we bill yearly from day one?" />
          </label>
          <OptionsEditor
            options={options}
            setOptions={(next) => {
              setOptions(next);
              clear("options");
            }}
            note={noteOf("options")}
          />
          <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
                Approver
                <select
                  aria-label="Approver"
                  data-field="approver"
                  className={FIELD}
                  value={approver}
                  aria-invalid={noteOf("approver") ? true : undefined}
                  aria-describedby={noteOf("approver") ? "propose-note-approver" : undefined}
                  onChange={(e) => {
                    setApprover(e.target.value);
                    clear("approver");
                  }}
                >
                  <option value="">Choose the approver</option>
                  {approvers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {personOption(p)}
                    </option>
                  ))}
                </select>
              </label>
              <FieldNote id="propose-note-approver" note={noteOf("approver")} />
            </div>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Reversibility
              <select aria-label="Reversibility" className={FIELD} value={reversibility} onChange={(e) => setReversibility(e.target.value as typeof reversibility)}>
                <option value="reversible">Reversible</option>
                <option value="irreversible">Hard to reverse</option>
              </select>
            </label>
          </div>
          <People label="Contributors" people={people} chosen={contributors} onToggle={(id) => setContributors((c) => toggle(c, id))} />
          <People label="Informed" people={people} chosen={informed} onToggle={(id) => setInformed((c) => toggle(c, id))} />
          <LinksPicker value={links} onChange={setLinks} />
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="solid" disabled={busy}>
              Propose
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

type Field = "title" | "options" | "approver";
/** The form's required fields, top to bottom: the first missing one takes the cursor. */
const FIELDS: Field[] = ["title", "options", "approver"];

/** The note under a field that needs filling in, read with the field (aria-describedby). */
export function FieldNote({ id, note }: { id: string; note: string | null }) {
  if (!note) return null;
  return (
    <span id={id} role="alert" className="text-sm font-medium text-crit">
      {note}
    </span>
  );
}

/** The typed options as the API takes them; an existing option keeps its key, evidence and recommendation. */
export function optionsOf(drafts: Draft[], before: DecisionOption[] = []): DecisionOption[] {
  const filled = drafts.filter((o) => o.label.trim());
  const taken = new Set(filled.flatMap((o) => (o.key ? [o.key] : [])));
  return filled.map((o) => {
    const old = before.find((b) => b.key === o.key);
    const key = o.key ?? optionKey(o.label, taken);
    taken.add(key);
    return {
      key,
      label: o.label.trim(),
      summary: o.summary.trim() || null,
      pros: lines(o.pros),
      cons: lines(o.cons),
      evidence_ids: old?.evidence_ids ?? [],
      cost_if_wrong: o.cost.trim() || null,
      recommended: old?.recommended ?? false,
    };
  });
}

/**
 * qa4-company-10: each option card's examples go with its own label example (Monthly only is
 * "Billed each month", never the yearly one).
 */
const EXAMPLES = [
  { label: "Annual at launch", summary: "Yearly plans from the first day", cost: "A month of rework" },
  { label: "Monthly only", summary: "Billed each month", cost: "Lower revenue up front" },
];
const example = (i: number) => EXAMPLES[i] ?? { label: "Another way", summary: "What this option does", cost: "What it costs to undo" };

/** Two to six options: a label, a summary, pros and cons one a line, the cost if wrong. */
export function OptionsEditor({
  options,
  setOptions,
  note = null,
}: {
  options: Draft[];
  setOptions: Dispatch<SetStateAction<Draft[]>>;
  /** Why the options will not do yet; the first empty option is marked invalid and is where the cursor goes. */
  note?: string | null;
}) {
  const set = (i: number, patch: Partial<Draft>) => setOptions((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const firstEmpty = options.findIndex((o) => !o.label.trim());
  const flagged = note ? (firstEmpty >= 0 ? firstEmpty : 0) : -1;
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={note ? "options-note" : undefined}>
      <legend className="mb-1 text-sm font-semibold text-text2">Options</legend>
      <FieldNote id="options-note" note={note} />
      {options.map((o, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
          <div className="flex items-center gap-2">
            <input
              aria-label={`Option ${i + 1}`}
              data-field={i === flagged ? "options" : undefined}
              aria-invalid={i === flagged ? true : undefined}
              aria-describedby={i === flagged ? "options-note" : undefined}
              className={FIELD}
              value={o.label}
              maxLength={200}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder={`e.g. ${example(i).label}`}
            />
            {/* qa4-company-8: two options at the least, so Remove shows only above two. */}
            {options.length > 2 && (
              <Button variant="ghost" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </div>
          <input
            aria-label={`Option ${i + 1} summary`}
            className={FIELD}
            value={o.summary}
            onChange={(e) => set(i, { summary: e.target.value })}
            placeholder={`Summary, e.g. ${example(i).summary}`}
          />
          <div className="grid grid-cols-2 gap-1.5 max-[600px]:grid-cols-1">
            <textarea aria-label={`Option ${i + 1} pros`} className={FIELD} rows={2} value={o.pros} onChange={(e) => set(i, { pros: e.target.value })} placeholder="Pros, one a line" />
            <textarea aria-label={`Option ${i + 1} cons`} className={FIELD} rows={2} value={o.cons} onChange={(e) => set(i, { cons: e.target.value })} placeholder="Cons, one a line" />
          </div>
          <input aria-label={`Option ${i + 1} cost if wrong`} className={FIELD} value={o.cost} onChange={(e) => set(i, { cost: e.target.value })} placeholder={`Cost if wrong, e.g. ${example(i).cost}`} />
        </div>
      ))}
      {options.length < 6 && (
        <div>
          <Button icon="plus" onClick={() => setOptions((all) => [...all, empty()])}>
            Add option
          </Button>
        </div>
      )}
    </fieldset>
  );
}

export function People({ label, people, chosen, onToggle }: { label: string; people: Person[]; chosen: string[]; onToggle: (id: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-semibold text-text2">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {people.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => onToggle(p.id)} />
            <span>{personName(p)}</span>
            {personName(p) !== p.email && <span className="text-text2">{p.email}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
