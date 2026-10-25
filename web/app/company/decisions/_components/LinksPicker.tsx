"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { SUBJECT_LABEL, entityTypeLabel, type Decision } from "./lib";

type Subject = Schemas["Subject"];
type Entity = Schemas["EntityOut"];

/** What a decision rests on and is about: linked baseline items, their evidence, its subjects. */
export type Links = { entity_ids: string[]; evidence_ids: string[]; subjects: Subject[] };

export const linksOf = (d: Pick<Decision, "entity_ids" | "evidence_ids" | "subjects">): Links => ({
  entity_ids: d.entity_ids,
  evidence_ids: d.evidence_ids,
  subjects: d.subjects as Subject[],
});

const MAX_SUBJECTS = 10;
const MATCHES = 8;
/** The kinds a person picks here; others (a section, a version, a run's stop) are set by the page that opens the form. */
const KINDS = [
  { value: "document", label: "Document" },
  { value: "entity", label: "Baseline item" },
  { value: "run", label: "Run" },
] as const;
type PickKind = (typeof KINDS)[number]["value"];

export const subjectLabel = (s: { kind: string; ref?: string | null }) => `${SUBJECT_LABEL[s.kind] ?? s.kind} ${s.ref ?? ""}`.trim();
const short = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * The three pickers of Propose decision and Edit: linked items (search the baseline), the
 * evidence of those items to tick, and what the decision is about (a document, a baseline
 * item or a run). `known` is the decision's own read-back, so evidence it already rests on
 * stays listed even when its item is not linked.
 */
export function LinksPicker({ value, onChange, known }: { value: Links; onChange: (next: Links) => void; known?: Pick<Decision, "entities" | "evidence"> }) {
  const entitiesQ = useQuery("decisions|entities", () => unwrap(api.GET("/v1/baseline/entities")));
  const all = (entitiesQ.data ?? []).filter((e) => e.status !== "rejected");
  const byId = new Map<string, Pick<Entity, "id" | "type" | "title">>((known?.entities ?? []).map((e) => [e.id, { ...e, type: e.type as Entity["type"] }]));
  for (const e of all) byId.set(e.id, e);
  // Which item each ticked evidence came from, so unlinking an item drops its evidence.
  const owner = useRef(new Map<string, string>((known?.evidence ?? []).flatMap((e) => (e.entity_id ? [[e.id, e.entity_id] as [string, string]] : []))));
  const [find, setFind] = useState("");

  const link = (id: string) => {
    onChange({ ...value, entity_ids: [...value.entity_ids, id] });
    setFind("");
  };
  const unlink = (id: string) =>
    onChange({ ...value, entity_ids: value.entity_ids.filter((x) => x !== id), evidence_ids: value.evidence_ids.filter((e) => owner.current.get(e) !== id) });
  const tick = (id: string, entity: string | null | undefined) => {
    if (entity) owner.current.set(id, entity);
    onChange({ ...value, evidence_ids: value.evidence_ids.includes(id) ? value.evidence_ids.filter((x) => x !== id) : [...value.evidence_ids, id] });
  };

  const needle = find.trim().toLowerCase();
  const matches = needle
    ? all.filter((e) => !value.entity_ids.includes(e.id) && (e.title.toLowerCase().includes(needle) || e.key.toLowerCase().includes(needle))).slice(0, MATCHES)
    : [];
  // Evidence the decision rests on whose item is not linked (an earlier pick, a capture).
  const other = (known?.evidence ?? []).filter((e) => !e.entity_id || !value.entity_ids.includes(e.entity_id));

  return (
    <>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-semibold text-text2">Linked items</legend>
        {value.entity_ids.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {value.entity_ids.map((id) => {
              const e = byId.get(id);
              const title = e?.title ?? "A baseline item";
              return (
                <li key={id} className="flex items-center gap-1 rounded-lg border border-line px-2 py-0.5 text-sm">
                  <span>{title}</span>
                  {e && <span className="text-text2">· {entityTypeLabel(e.type)}</span>}
                  <Button variant="ghost" aria-label={`Remove ${title}`} onClick={() => unlink(id)}>
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <input className={INPUT} aria-label="Find an item to link" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a goal, feature, risk…" />
        {needle && (
          <ul className="flex flex-col gap-0.5">
            {matches.length === 0 ? (
              <li className="text-sm text-text2">{entitiesQ.loading ? "Loading…" : "No baseline item matches"}</li>
            ) : (
              matches.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => link(e.id)}
                    className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-surface2"
                  >
                    <span className="font-medium">{e.title}</span> <span className="text-text2">· {entityTypeLabel(e.type)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-semibold text-text2">Evidence</legend>
        {value.entity_ids.length === 0 && other.length === 0 && <p className="text-sm text-text2">Link a baseline item to pick from its evidence</p>}
        {value.entity_ids.map((id) => (
          <ItemEvidence key={id} entity={id} title={byId.get(id)?.title ?? "A baseline item"} chosen={value.evidence_ids} onTick={tick} />
        ))}
        {other.map((e) => (
          <EvidenceBox key={e.id} evidence={e} checked={value.evidence_ids.includes(e.id)} onTick={() => tick(e.id, e.entity_id)} />
        ))}
      </fieldset>
      <SubjectsPicker subjects={value.subjects} entities={all} onChange={(subjects) => onChange({ ...value, subjects })} />
    </>
  );
}

function ItemEvidence({ entity, title, chosen, onTick }: { entity: string; title: string; chosen: string[]; onTick: (id: string, entity: string) => void }) {
  // The item's own read (as the baseline drawer's): its evidence comes with it.
  const q = useQuery(`decisions|evidence|${entity}`, () => unwrap(api.GET("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: entity } } })));
  const rows = q.data?.evidence ?? [];
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-sm font-medium">{title}</p>
      {q.loading && !q.data ? (
        <p className="text-sm text-text2">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text2">No evidence on this item</p>
      ) : (
        rows.map((e) => <EvidenceBox key={e.id} evidence={e} checked={chosen.includes(e.id)} onTick={() => onTick(e.id, entity)} />)
      )}
    </div>
  );
}

function EvidenceBox({ evidence: e, checked, onTick }: { evidence: { id: string; excerpt?: string | null; ref?: string | null; url?: string | null }; checked: boolean; onTick: () => void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={onTick} />
      <span>
        {short(e.excerpt || e.ref || e.url || "Evidence")}
        {e.ref && e.excerpt && <span className="text-text2"> · {e.ref}</span>}
      </span>
    </label>
  );
}

/** What it is about: up to ten subjects; a document, a baseline item or a run is picked here. */
function SubjectsPicker({ subjects, entities, onChange }: { subjects: Subject[]; entities: Entity[]; onChange: (next: Subject[]) => void }) {
  const [kind, setKind] = useState<PickKind>("document");
  const [picked, setPicked] = useState("");
  const docsQ = useQuery("decisions|documents", () => unwrap(api.GET("/v1/documents")));
  const runsQ = useQuery("decisions|runs", () => unwrap(api.GET("/v1/runs")));
  const taken = new Set(subjects.map((s) => `${s.kind}:${s.id}`));
  const choices: (Subject & { label: string })[] =
    kind === "document"
      ? (docsQ.data ?? []).map((d) => ({ kind: "document", id: d.id, ref: d.slug, label: d.title }))
      : kind === "entity"
        ? entities.map((e) => ({ kind: "entity", id: e.id, ref: e.title, label: e.title }))
        : (runsQ.data ?? []).map((r) => ({ kind: "run", id: r.id, ref: r.flow_title, label: `${r.flow_title}${r.document_slug ? ` · ${r.document_slug}` : ""}` }));
  const open = choices.filter((c) => !taken.has(`${c.kind}:${c.id}`));
  const full = subjects.length >= MAX_SUBJECTS;
  const add = () => {
    const c = open.find((x) => x.id === picked);
    if (!c) return;
    onChange([...subjects, { kind: c.kind, id: c.id, ref: c.ref }]);
    setPicked("");
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-semibold text-text2">About</legend>
      {subjects.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {subjects.map((s) => (
            <li key={`${s.kind}:${s.id}`} className="flex items-center gap-1 rounded-lg border border-line px-2 py-0.5 text-sm">
              <span>{subjectLabel(s)}</span>
              <Button variant="ghost" aria-label={`Remove ${subjectLabel(s)}`} onClick={() => onChange(subjects.filter((x) => x !== s))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="text-sm text-text2">A decision is about at most {MAX_SUBJECTS} things</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 max-[600px]:flex-col max-[600px]:items-stretch">
          <select
            aria-label="Kind"
            className={`${INPUT} w-auto max-[600px]:w-full`}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as PickKind);
              setPicked("");
            }}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <select aria-label="Item" className={`${INPUT} min-w-0 flex-1`} value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose one</option>
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <Button onClick={add} disabled={!picked}>
            Add
          </Button>
        </div>
      )}
    </fieldset>
  );
}
