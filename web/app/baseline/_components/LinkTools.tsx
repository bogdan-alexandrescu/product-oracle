"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { Button, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type EdgeOut, type EntityDetail, type GraphOut, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { sourceKindLabel, titleOf } from "./common";

/** Links and evidence change only for approvers and owners, as in the API. */
export const WRITE_REASON = "Only approvers and owners change links and cite source items.";

const LABEL = "flex min-w-0 flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";

export const RELATIONS = [
  { type: "depends_on", label: "Depends on" },
  { type: "blocks", label: "Blocks" },
  { type: "part_of", label: "Part of" },
] as const;

type Relation = (typeof RELATIONS)[number]["type"];

/** What a person picks when adding a link: the far end, the type and (for a goal) the contribution. */
export type NewLink = { dst_id: string; type: EdgeOut["type"]; attrs: Record<string, unknown> };

function FormButtons({ busy, submit, onCancel }: { busy: boolean; submit: string; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="solid" disabled={busy}>
        {submit}
      </Button>
      <Button onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

/** Link to goal: a goal this item does not support yet, and its contribution 0-3. */
export function LinkToGoalForm({
  detail,
  graph,
  busy,
  onCancel,
  onSave,
}: {
  detail: EntityDetail;
  graph: GraphOut | undefined;
  busy: boolean;
  onCancel: () => void;
  onSave: (link: NewLink) => void;
}) {
  const linked = new Set(detail.edges_out.filter((e) => e.type === "supports").map((e) => e.dst_id));
  const goals = (graph?.entities ?? []).filter((g) => g.type === "goal" && g.status !== "rejected" && !linked.has(g.id));
  const [goal, setGoal] = useState("");
  const [contribution, setContribution] = useState("2");
  const [invalid, setInvalid] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!goal) return setInvalid(true);
    onSave({ dst_id: goal, type: "supports", attrs: { contribution: Number(contribution) } });
  }
  return (
    <form aria-label="Link to goal" className="flex flex-col gap-3" onSubmit={submit}>
      {goals.length === 0 ? (
        <p className="text-text2">It already supports every goal.</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <label className={LABEL}>
            Goal
            <select className={INPUT} value={goal} onChange={(e) => setGoal(e.target.value)}>
              <option value="">Choose…</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Contribution
            <ContributionSelect value={contribution} onChange={setContribution} />
          </label>
        </div>
      )}
      {invalid && !goal && <Notice tone="error">Pick a goal.</Notice>}
      <FormButtons busy={busy} submit="Link" onCancel={onCancel} />
    </form>
  );
}

/** 0 (none) to 3 (strong), as the feature × goal matrix shows it. */
export function ContributionSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className={INPUT}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="0">0 · none</option>
      <option value="1">1 · weak</option>
      <option value="2">2 · medium</option>
      <option value="3">3 · strong</option>
    </select>
  );
}

const TYPE_GROUP: Record<string, string> = {
  goal: "Goals",
  product: "Products",
  feature: "Features",
  requirement: "Requirements",
  constraint: "Constraints",
  decision: "Decisions",
  person: "People",
  outcome: "Outcomes",
  acceptance_criterion: "Acceptance criteria",
  assumption: "Assumptions",
  risk: "Risks",
  strategy_choice: "Strategy choices",
};

/** Add dependency: depends on, blocks or part of another entry, picked by kind. */
export function AddDependencyForm({
  detail,
  graph,
  busy,
  onCancel,
  onSave,
}: {
  detail: EntityDetail;
  graph: GraphOut | undefined;
  busy: boolean;
  onCancel: () => void;
  onSave: (link: NewLink) => void;
}) {
  const [relation, setRelation] = useState<Relation>("depends_on");
  const [entry, setEntry] = useState("");
  const [invalid, setInvalid] = useState(false);
  const entries = (graph?.entities ?? []).filter((e) => e.id !== detail.id && e.status !== "rejected");
  const groups = Object.keys(TYPE_GROUP)
    .map((type) => ({ type, items: entries.filter((e) => e.type === type).sort((a, b) => a.title.localeCompare(b.title)) }))
    .filter((g) => g.items.length > 0);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!entry) return setInvalid(true);
    onSave({ dst_id: entry, type: relation, attrs: {} });
  }
  return (
    <form aria-label="Add dependency" className="flex flex-col gap-3" onSubmit={submit}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 max-[420px]:grid-cols-1">
        <label className={LABEL}>
          Relation
          <select className={INPUT} value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
            {RELATIONS.map((r) => (
              <option key={r.type} value={r.type}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Entry
          <select className={INPUT} value={entry} onChange={(e) => setEntry(e.target.value)}>
            <option value="">Choose…</option>
            {groups.map((g) => (
              <optgroup key={g.type} label={TYPE_GROUP[g.type]}>
                {g.items.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      {invalid && !entry && <Notice tone="error">Pick an entry.</Notice>}
      <FormButtons busy={busy} submit="Add" onCancel={onCancel} />
    </form>
  );
}

const plain = (snippet: string) => snippet.replace(/<\/?mark>/g, "");

/** Cite a source item: search your own sources, then cite one hit. */
export function CiteSourceForm({
  busy,
  onCancel,
  onCite,
}: {
  busy: boolean;
  onCancel: () => void;
  onCite: (item: Schemas["ItemOut"]) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Schemas["SearchHit"][] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await unwrap(api.GET("/v1/search", { params: { query: { q: query.trim(), limit: 10 } } }));
      setHits(res.hits);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }
  return (
    <form aria-label="Cite a source item" className="flex flex-col gap-3" onSubmit={search}>
      <div className="flex items-end gap-2">
        <label className={`${LABEL} flex-1`}>
          Search your sources
          <input className={INPUT} type="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Button type="submit" disabled={searching || !query.trim()}>
          Search
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {hits &&
        (hits.length === 0 ? (
          <p className="text-text2">Nothing in your sources matches.</p>
        ) : (
          <ul aria-label="Source items" className="flex flex-col divide-y divide-line">
            {hits.map((h) => {
              const name = h.item.title ?? h.item.external_id;
              return (
                <li key={h.item.id} className="flex min-w-0 items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{name}</span>
                    <span className="block truncate text-sm text-text2" title={plain(h.snippet)}>
                      {sourceKindLabel(h.item.source_kind)} · {plain(h.snippet)}
                    </span>
                  </span>
                  <Button className="flex-none" disabled={busy} aria-label={`Cite ${name}`} onClick={() => onCite(h.item)}>
                    Cite
                  </Button>
                </li>
              );
            })}
          </ul>
        ))}
      <div>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The in-page confirm for removing a link or a piece of evidence; evidence asks why. */
export function ConfirmRemove({
  name,
  prompt,
  reason = false,
  busy,
  onBack,
  onRemove,
}: {
  name: string;
  prompt: ReactNode;
  reason?: boolean;
  busy: boolean;
  onBack: () => void;
  onRemove: (reason: string) => void;
}) {
  const [note, setNote] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      aria-label={name}
      className="flex flex-col gap-2 rounded-lg bg-surface2 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason && !note.trim()) return setInvalid(true);
        onRemove(note.trim());
      }}
    >
      <p className="text-sm text-text2">{prompt}</p>
      {reason && (
        <label className={LABEL}>
          Reason
          <textarea className={INPUT} rows={2} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {invalid && <Notice tone="error">Say why it is removed.</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={busy}>
          Remove
        </Button>
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** The far end's name, for messages and accessible names. */
export const endName = (graph: GraphOut | undefined, edge: EdgeOut, from: string) =>
  titleOf(graph, edge.src_id === from ? edge.dst_id : edge.src_id);
