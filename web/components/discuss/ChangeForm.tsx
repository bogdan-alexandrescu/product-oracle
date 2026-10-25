"use client";

import { useState, type ReactNode } from "react";

import { Button, SegmentedControl } from "@/components/ds";
import { FIELD_LABEL, InlineError, SELECT, TEXTAREA } from "@/components/review/parts";
import { api, unwrap } from "@/lib/api/client";
import { kindLabel } from "@/lib/api/discussion-changes";
import { hasRole } from "@/lib/me";
import { displayName } from "@/lib/names";
import { useQuery } from "@/lib/use-query";

type Payload = Record<string, unknown>;
type Horizon = "now" | "next" | "later";

const INPUT = "h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] font-normal tracking-normal text-text";
/** F3's basis kinds (ScheduleBasisCreate.kind). */
const BASIS_KINDS = [
  { value: "estimate", label: "Estimate" },
  { value: "capacity", label: "Capacity" },
  { value: "commitment", label: "Commitment" },
];
const HORIZONS: { value: Horizon; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "next", label: "Next" },
  { value: "later", label: "Later" },
];

const SCOPE_DECISIONS: { value: "include" | "exclude" | "defer"; label: string }[] = [
  { value: "include", label: "Include" },
  { value: "exclude", label: "Exclude" },
  { value: "defer", label: "Defer" },
];
const REQUIREMENT_OPS: { value: "add" | "enhance" | "cut"; label: string }[] = [
  { value: "add", label: "Add" },
  { value: "enhance", label: "Change" },
  { value: "cut", label: "Cut" },
];
const REVERSIBILITY: { value: "reversible" | "irreversible"; label: string }[] = [
  { value: "reversible", label: "Reversible" },
  { value: "irreversible", label: "Hard to reverse" },
];
/** The kinds with a form of their own; any other is written as JSON. */
const KNOWN = [
  "item_horizon",
  "item_outcome",
  "section_edit",
  "goal_measure",
  "conflict_pick",
  "answer",
  "basis_record",
  "ask_person",
  "scope_feature",
  "scope_requirement",
  "priority_move",
  "priority_pin",
  "decision",
];
/** The kinds whose payload names a feature (the subject may name it first). */
const FEATURE_KINDS = ["scope_feature", "scope_requirement", "priority_move", "priority_pin"];
const PEOPLE_KINDS = ["ask_person", "decision"];

/** A decision's options, one per line, as the API takes them (keys o1, o2, …). */
const optionsOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((label, i) => ({ key: `o${i + 1}`, label }));
const linesOf = (options: unknown) =>
  Array.isArray(options) ? options.map((o) => (o && typeof o === "object" ? str((o as Record<string, unknown>).label) : "")).filter(Boolean).join("\n") : "";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={FIELD_LABEL}>
      {label}
      {children}
    </label>
  );
}

/** A required text value for each kind's payload; null when the form is complete. */
function missing(kind: string, p: Payload): string | null {
  const need = (key: string, what: string) => (str(p[key]).trim() ? null : what);
  if (kind === "item_horizon") return need("item_key", "Name the item") ?? need("horizon", "Pick Now, Next or Later");
  if (kind === "item_outcome") return need("item_key", "Name the item") ?? need("outcome", "Write the outcome");
  if (kind === "section_edit") return need("section_key", "Pick the section") ?? need("instruction", "Say what to change");
  if (kind === "goal_measure") return need("metric", "Name the metric") ?? need("target", "Give the target");
  if (kind === "conflict_pick") return Number.isInteger(p.claim_index) ? null : "Pick a claim";
  if (kind === "answer") return need("body", "Write the answer");
  if (kind === "basis_record") return need("reference", "Name what the date rests on") ?? need("supports_date", "Pick the date it supports");
  if (kind === "ask_person") return need("asked_to", "Choose whom to ask") ?? need("prompt", "Write the question");
  if (kind === "scope_feature") return need("feature_id", "Pick the feature") ?? need("decision", "Pick Include, Exclude or Defer") ?? need("reason", "Say why");
  if (kind === "scope_requirement") {
    const op = str(p.op);
    if (op === "add") return need("feature_id", "Pick the feature it belongs to") ?? need("text", "Write the requirement");
    if (op === "enhance") return need("requirement_id", "Pick the requirement") ?? need("text", "Write the new requirement");
    if (op === "cut") return need("requirement_id", "Pick the requirement");
    return "Pick Add, Change or Cut";
  }
  if (kind === "priority_move") {
    const gap = need("feature_id", "Pick the feature to move") ?? need("above_feature_id", "Pick the feature to move it above");
    if (gap) return gap;
    if (p.feature_id === p.above_feature_id) return "Pick another feature to move it above";
    return need("reason", "Say why");
  }
  if (kind === "priority_pin") {
    const gap = need("feature_id", "Pick the feature to pin");
    if (gap) return gap;
    if (!Number.isInteger(p.position) || (p.position as number) < 1) return "Give a position of 1 or more";
    return need("reason", "Say why");
  }
  if (kind === "decision") {
    const gap = need("title", "Write the decision");
    if (gap) return gap;
    if (str(p.title).trim().length > 200) return "Keep the decision under 200 characters";
    if (Array.isArray(p.options) && p.options.length > 6) return "Give at most 6 options";
    return null;
  }
  return null;
}

/**
 * The payload form for one kind of change (G3 §3.7), shared by Edit and "Propose a change":
 * a horizon segmented control, an outcome text box, a section picker with what to change, a
 * goal's measure, a conflict's claim, an answer, a basis, whom to ask, a feature's scope, a
 * requirement, a priority move or pin, a decision, and JSON for any other kind. `fresh`: a new
 * change, so the item it is about can be named too. `featureHint`: the feature the subject names
 * (an entity id or an item key), picked until the person picks another.
 */
export function ChangeForm({
  kind,
  initial,
  fresh = false,
  sectionKeys = [],
  withRationale = false,
  saveLabel = "Save",
  featureHint,
  onSave,
  onCancel,
}: {
  kind: string;
  initial: Payload;
  fresh?: boolean;
  /** The sections a section edit can pick from; a text box when none are known. */
  sectionKeys?: string[];
  /** Ask for a one-sentence reason too (a new change). */
  withRationale?: boolean;
  saveLabel?: string;
  featureHint?: string;
  onSave: (payload: Payload, rationale: string | null) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [p, setP] = useState<Payload>(initial);
  const [json, setJson] = useState(() => JSON.stringify(initial, null, 2));
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionText, setOptionText] = useState(() => linesOf(initial.options));
  const set = (key: string, value: unknown) => setP((x) => ({ ...x, [key]: value }));
  const known = KNOWN.includes(kind);

  // What the pickers list: features (and requirements) from the baseline, people from the decision log's list.
  const wantsFeatures = FEATURE_KINDS.includes(kind);
  const wantsRequirements = kind === "scope_requirement";
  const wantsPeople = PEOPLE_KINDS.includes(kind);
  const featuresQ = useQuery(wantsFeatures ? "change-form|features" : "change-form|features|none", () =>
    wantsFeatures ? unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "feature" } } })) : Promise.resolve(undefined),
  );
  const requirementsQ = useQuery(wantsRequirements ? "change-form|requirements" : "change-form|requirements|none", () =>
    wantsRequirements ? unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "requirement" } } })) : Promise.resolve(undefined),
  );
  const peopleQ = useQuery(wantsPeople ? "change-form|people" : "change-form|people|none", () =>
    wantsPeople ? unwrap(api.GET("/v1/decisions/people")) : Promise.resolve(undefined),
  );
  const features = (featuresQ.data ?? []).filter((e) => e.status !== "rejected");
  const requirements = (requirementsQ.data ?? []).filter((e) => e.status !== "rejected");
  const people = peopleQ.data ?? [];
  const approvers = people.filter((x) => hasRole(x.role, "approver"));
  const loadError = featuresQ.error ?? requirementsQ.error ?? peopleQ.error;
  // The subject's feature, until the person picks one (an add names the feature too).
  const hinted = featureHint ? features.find((f) => f.id === featureHint || f.key === featureHint || f.key === `f.${featureHint}`) : undefined;
  const featureId = str(p.feature_id) || (wantsFeatures ? (hinted?.id ?? "") : "");

  const save = async () => {
    let payload: Payload = wantsFeatures && featureId ? { ...p, feature_id: featureId } : p;
    if (kind === "decision") {
      const options = optionsOf(optionText);
      payload = { ...payload, options };
      if (!str(payload.approver_id)) delete payload.approver_id;
    }
    if (kind === "scope_requirement") {
      // Only what the operation uses: an add names the feature, a change or cut the requirement.
      const op = str(payload.op);
      const { requirement_id, feature_id, text, ...rest } = payload;
      payload = { ...rest, ...(op === "add" ? { feature_id, text } : op === "enhance" ? { requirement_id, text } : { requirement_id }) };
    }
    if (!known) {
      try {
        const parsed = JSON.parse(json || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        payload = parsed as Payload;
      } catch {
        setError("Write the change as a JSON object");
        return;
      }
    }
    const gap = missing(kind, payload);
    if (gap) {
      setError(gap);
      return;
    }
    setBusy(true);
    setError(null);
    const refused = await onSave(payload, withRationale ? rationale.trim() || null : null);
    setBusy(false);
    if (refused) setError(refused);
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      data-testid="change-form"
      data-kind={kind}
      aria-label={kindLabel(kind)}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {(kind === "item_horizon" || kind === "item_outcome") && fresh && (
        <Field label="Item">
          <input aria-label="Item" className={INPUT} value={str(p.item_key)} onChange={(e) => set("item_key", e.target.value)} />
        </Field>
      )}
      {kind === "item_horizon" && (
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Horizon</span>
          <SegmentedControl<Horizon> label="Horizon" size="sm" items={HORIZONS} value={str(p.horizon) as Horizon} onChange={(v) => set("horizon", v)} />
        </div>
      )}
      {kind === "item_outcome" && (
        <Field label="Outcome">
          <textarea aria-label="Outcome" rows={2} maxLength={500} className={TEXTAREA} value={str(p.outcome)} onChange={(e) => set("outcome", e.target.value)} />
        </Field>
      )}
      {kind === "section_edit" && (
        <>
          <Field label="Section">
            {sectionKeys.length > 0 ? (
              <select aria-label="Section" className={INPUT} value={str(p.section_key)} onChange={(e) => set("section_key", e.target.value)}>
                {sectionKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : (
              <input aria-label="Section" className={INPUT} value={str(p.section_key)} onChange={(e) => set("section_key", e.target.value)} />
            )}
          </Field>
          <Field label="What to change">
            <textarea aria-label="What to change" rows={3} maxLength={2000} className={TEXTAREA} value={str(p.instruction)} onChange={(e) => set("instruction", e.target.value)} />
          </Field>
        </>
      )}
      {kind === "goal_measure" && (
        <>
          <Field label="Metric">
            <input aria-label="Metric" className={INPUT} value={str(p.metric)} onChange={(e) => set("metric", e.target.value)} />
          </Field>
          <Field label="Target">
            <input aria-label="Target" className={INPUT} value={str(p.target)} onChange={(e) => set("target", e.target.value)} />
          </Field>
          <Field label="By when">
            <input aria-label="By when" className={INPUT} value={str(p.horizon)} onChange={(e) => set("horizon", e.target.value)} />
          </Field>
        </>
      )}
      {kind === "conflict_pick" && (
        <Field label="Claim to keep">
          <input aria-label="Claim to keep"
            type="number"
            min={0}
            className={INPUT}
            value={typeof p.claim_index === "number" ? p.claim_index : ""}
            onChange={(e) => set("claim_index", e.target.value === "" ? null : Number(e.target.value))}
          />
        </Field>
      )}
      {kind === "answer" && (
        <Field label="Answer">
          <textarea aria-label="Answer" rows={3} maxLength={4000} className={TEXTAREA} value={str(p.body)} onChange={(e) => set("body", e.target.value)} />
        </Field>
      )}
      {kind === "basis_record" && (
        <>
          <Field label="Kind of basis">
            <select aria-label="Kind of basis" className={SELECT} value={str(p.kind) || "estimate"} onChange={(e) => set("kind", e.target.value)}>
              {BASIS_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What the date rests on">
            <input aria-label="What the date rests on" className={INPUT} value={str(p.reference)} onChange={(e) => set("reference", e.target.value)} />
          </Field>
          <Field label="Date it supports">
            <input aria-label="Date it supports" type="date" className={INPUT} value={str(p.supports_date)} onChange={(e) => set("supports_date", e.target.value)} />
          </Field>
        </>
      )}
      {kind === "ask_person" && (
        <>
          <Field label="Ask whom">
            <select aria-label="Ask whom" className={SELECT} value={str(p.asked_to)} onChange={(e) => set("asked_to", e.target.value)}>
              <option value="">Choose someone</option>
              {people.map((x) => (
                <option key={x.id} value={x.id}>
                  {displayName(x.email)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Question">
            <textarea aria-label="Question" rows={2} maxLength={2000} className={TEXTAREA} value={str(p.prompt)} onChange={(e) => set("prompt", e.target.value)} />
          </Field>
        </>
      )}
      {(kind === "scope_feature" || kind === "priority_move" || kind === "priority_pin" || (kind === "scope_requirement" && str(p.op) === "add")) && (
        <FeaturePicker label={kind === "scope_requirement" ? "Feature it belongs to" : "Feature"} features={features} value={featureId} onChange={(v) => set("feature_id", v)} />
      )}
      {kind === "scope_feature" && (
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Decision</span>
          <SegmentedControl label="Decision" size="sm" items={SCOPE_DECISIONS} value={str(p.decision) as "include"} onChange={(v) => set("decision", v)} />
        </div>
      )}
      {kind === "scope_requirement" && (
        <>
          <div className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>What to do</span>
            <SegmentedControl label="What to do" size="sm" items={REQUIREMENT_OPS} value={str(p.op) as "add"} onChange={(v) => set("op", v)} />
          </div>
          {(str(p.op) === "enhance" || str(p.op) === "cut") && (
            <Field label="Requirement">
              <select aria-label="Requirement" className={SELECT} value={str(p.requirement_id)} onChange={(e) => set("requirement_id", e.target.value)}>
                <option value="">{requirements.length ? "Choose a requirement" : "No requirements yet"}</option>
                {requirements.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(str(p.op) === "add" || str(p.op) === "enhance") && (
            <Field label="Requirement text">
              <textarea aria-label="Requirement text" rows={2} maxLength={2000} className={TEXTAREA} value={str(p.text)} onChange={(e) => set("text", e.target.value)} />
            </Field>
          )}
        </>
      )}
      {kind === "priority_move" && (
        <FeaturePicker label="Move above" features={features.filter((f) => f.id !== featureId)} value={str(p.above_feature_id)} onChange={(v) => set("above_feature_id", v)} />
      )}
      {kind === "priority_pin" && (
        <Field label="Position">
          <input
            aria-label="Position"
            type="number"
            min={1}
            className={INPUT}
            value={typeof p.position === "number" ? p.position : ""}
            onChange={(e) => set("position", e.target.value === "" ? null : Number(e.target.value))}
          />
        </Field>
      )}
      {(kind === "scope_feature" || kind === "priority_move" || kind === "priority_pin") && (
        <Field label="Reason">
          <textarea aria-label="Reason" rows={2} maxLength={500} className={TEXTAREA} value={str(p.reason)} onChange={(e) => set("reason", e.target.value)} />
        </Field>
      )}
      {kind === "decision" && (
        <>
          <Field label="Decision">
            <input aria-label="Decision" maxLength={200} className={INPUT} value={str(p.title)} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="What is being decided">
            <textarea aria-label="What is being decided" rows={2} maxLength={1000} className={TEXTAREA} value={str(p.question)} onChange={(e) => set("question", e.target.value)} />
          </Field>
          <Field label="Options">
            <textarea aria-label="Options" rows={3} placeholder="One option per line" className={TEXTAREA} value={optionText} onChange={(e) => setOptionText(e.target.value)} />
          </Field>
          <Field label="Who decides">
            <select aria-label="Who decides" className={SELECT} value={str(p.approver_id)} onChange={(e) => set("approver_id", e.target.value)}>
              <option value="">Choose who decides</option>
              {approvers.map((x) => (
                <option key={x.id} value={x.id}>
                  {displayName(x.email)}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Can it be undone?</span>
            <SegmentedControl
              label="Can it be undone?"
              size="sm"
              items={REVERSIBILITY}
              value={(str(p.reversibility) || "reversible") as "reversible"}
              onChange={(v) => set("reversibility", v)}
            />
          </div>
        </>
      )}
      {loadError && <InlineError>{loadError}</InlineError>}
      {!known && (
        <Field label="Change (JSON)">
          <textarea aria-label="Change (JSON)" rows={5} className={`${TEXTAREA} font-mono text-[13px]`} value={json} onChange={(e) => setJson(e.target.value)} />
        </Field>
      )}
      {withRationale && (
        <Field label="Why (one sentence)">
          <textarea aria-label="Why (one sentence)" rows={2} maxLength={500} className={TEXTAREA} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
      )}
      {error && <InlineError>{error}</InlineError>}
      <span className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy}>
          {saveLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** A feature from the baseline, by title. */
function FeaturePicker({ label, features, value, onChange }: { label: string; features: { id: string; title: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select aria-label={label} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{features.length ? "Choose a feature" : "No features yet"}</option>
        {features.map((f) => (
          <option key={f.id} value={f.id}>
            {f.title}
          </option>
        ))}
      </select>
    </Field>
  );
}
