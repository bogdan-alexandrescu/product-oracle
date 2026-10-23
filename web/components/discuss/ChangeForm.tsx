"use client";

import { useState, type ReactNode } from "react";

import { Button, SegmentedControl } from "@/components/ds";
import { FIELD_LABEL, InlineError, SELECT, TEXTAREA } from "@/components/review/parts";
import { kindLabel } from "@/lib/api/discussion-changes";

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
  return null;
}

/**
 * The payload form for one kind of change (G3 §3.7), shared by Edit and "Propose a change":
 * a horizon segmented control, an outcome text box, a section picker with what to change, a
 * goal's measure, a conflict's claim, an answer, and JSON for any other kind. `fresh`: a new
 * change, so the item it is about can be named too.
 */
export function ChangeForm({
  kind,
  initial,
  fresh = false,
  sectionKeys = [],
  withRationale = false,
  saveLabel = "Save",
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
  onSave: (payload: Payload, rationale: string | null) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [p, setP] = useState<Payload>(initial);
  const [json, setJson] = useState(() => JSON.stringify(initial, null, 2));
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, value: unknown) => setP((x) => ({ ...x, [key]: value }));
  const known = ["item_horizon", "item_outcome", "section_edit", "goal_measure", "conflict_pick", "answer", "basis_record"].includes(kind);

  const save = async () => {
    let payload = p;
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
