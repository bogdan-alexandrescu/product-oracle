"use client";

import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { optionKey, type Decision, type DecisionOption, type Person } from "./lib";
import { LinksPicker, type Links } from "./LinksPicker";

/** An option as typed; `key` keeps an existing option's key (and so its evidence and recommendation). */
export type Draft = { key?: string; label: string; summary: string; pros: string; cons: string; cost: string };
export const empty = (): Draft => ({ label: "", summary: "", pros: "", cons: "", cost: "" });
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
  const [busy, setBusy] = useState(false);

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const filled = options.filter((o) => o.label.trim());
    if (!title.trim()) return setError("Write the decision in one sentence");
    if (filled.length < 2) return setError("Add at least two options");
    if (!approver) return setError("Name the approver");
    setBusy(true);
    setError(null);
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
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="propose-decision-title"
        tabIndex={-1}
        className="w-full max-w-2xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="propose-decision-title" className="font-display text-xl font-bold tracking-heading">
            Propose decision
          </h2>
        </div>
        <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Decision
            <input data-autofocus className={INPUT} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Ship usage caps before detection" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Question
            <input className={INPUT} value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} placeholder="What is being decided" />
          </label>
          <OptionsEditor options={options} setOptions={setOptions} />
          <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Approver
              <select aria-label="Approver" className={INPUT} value={approver} onChange={(e) => setApprover(e.target.value)}>
                <option value="">Choose the approver</option>
                {approvers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Reversibility
              <select aria-label="Reversibility" className={INPUT} value={reversibility} onChange={(e) => setReversibility(e.target.value as typeof reversibility)}>
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

/** Two to six options: a label, a summary, pros and cons one a line, the cost if wrong. */
export function OptionsEditor({ options, setOptions }: { options: Draft[]; setOptions: Dispatch<SetStateAction<Draft[]>> }) {
  const set = (i: number, patch: Partial<Draft>) => setOptions((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold text-text2">Options</legend>
      {options.map((o, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
          <div className="flex items-center gap-2">
            <input
              aria-label={`Option ${i + 1}`}
              className={INPUT}
              value={o.label}
              maxLength={200}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder={`Option ${i + 1}`}
            />
            <Button variant="ghost" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
          <input aria-label={`Option ${i + 1} summary`} className={INPUT} value={o.summary} onChange={(e) => set(i, { summary: e.target.value })} placeholder="Summary" />
          <div className="grid grid-cols-2 gap-1.5 max-[600px]:grid-cols-1">
            <textarea aria-label={`Option ${i + 1} pros`} className={INPUT} rows={2} value={o.pros} onChange={(e) => set(i, { pros: e.target.value })} placeholder="Pros, one a line" />
            <textarea aria-label={`Option ${i + 1} cons`} className={INPUT} rows={2} value={o.cons} onChange={(e) => set(i, { cons: e.target.value })} placeholder="Cons, one a line" />
          </div>
          <input aria-label={`Option ${i + 1} cost if wrong`} className={INPUT} value={o.cost} onChange={(e) => set(i, { cost: e.target.value })} placeholder="Cost if wrong" />
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
            {p.email}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
