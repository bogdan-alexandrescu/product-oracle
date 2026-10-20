"use client";

import { useId, useState, type FormEvent } from "react";

import { Button, InfoTip, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import type { EntityDetail, Schemas } from "@/lib/api/client";

import { EvidenceChip } from "./EvidenceChip";

type Create = Schemas["BlockerCreate"];

/** What an intake answer suggests for the blocker (`attrs.proposed_blocker`). */
export type Suggestion = {
  type?: Create["type"];
  limit_kind?: NonNullable<Create["limit_kind"]>;
  severity?: NonNullable<Create["severity"]>;
  status?: Create["status"];
};

/**
 * The "suggested blocker" mark (B4): a constraint an intake answer proposed as a blocker,
 * accepted into the baseline but not a blocker yet. Null for anything else.
 */
export function suggestedBlocker(e: { type: string; attrs?: Record<string, unknown> | null }): Suggestion | null {
  const mark = e.attrs?.proposed_blocker;
  if (e.type !== "constraint" || e.attrs?.blocker || !mark || typeof mark !== "object") return null;
  return mark as Suggestion;
}

const TYPES: [Create["type"], string][] = [
  ["hard", "Hard"],
  ["soft", "Soft"],
  ["temporary", "Temporary"],
  ["unknown", "Unknown"],
];
const SEVERITIES: [NonNullable<Create["severity"]>, string][] = [
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];
const LIMIT_KINDS: [NonNullable<Create["limit_kind"]>, string][] = [
  ["capacity", "Rate or capacity limit"],
  ["eligibility", "API eligibility"],
  ["permission", "Permissions"],
  ["policy", "Third-party policy"],
  ["other", "Other constraint"],
];
/** A limit kind in words. */
export const LIMIT_LABEL: Record<string, string> = Object.fromEntries(LIMIT_KINDS);
const STATUSES: [Create["status"], string][] = [
  ["open", "Open"],
  ["mitigating", "Mitigating"],
];

const pick = <T extends string>(options: [T, string][], value: unknown, fallback: T): T =>
  options.some(([v]) => v === value) ? (value as T) : fallback;

/**
 * Promote to blocker: the blocker form pre-filled from the constraint (statement, detail)
 * and the intake's suggestion (type, limit kind, severity, status), all editable. Its
 * evidence stays on the constraint and becomes the blocker's. Saving creates the blocker
 * and clears the "suggested blocker" mark in the same write (POST /v1/blockers).
 */
export function PromoteForm({
  entity,
  low,
  busy,
  onCancel,
  onSave,
}: {
  entity: EntityDetail;
  low?: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Create) => void;
}) {
  const mark = suggestedBlocker(entity) ?? {};
  const [statement, setStatement] = useState(entity.title);
  const [detail, setDetail] = useState(entity.body ?? "");
  const [type, setType] = useState(pick(TYPES, mark.type, "unknown"));
  const [severity, setSeverity] = useState(pick(SEVERITIES, mark.severity, "medium"));
  const [limitKind, setLimitKind] = useState(pick(LIMIT_KINDS, mark.limit_kind, "other"));
  const [thirdParty, setThirdParty] = useState("");
  const [status, setStatus] = useState(pick(STATUSES, mark.status, "open"));
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const uid = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!statement.trim()) return setInvalid("The statement cannot be empty.");
    if (statement.trim().length > 500) return setInvalid("Keep the statement under 500 characters.");
    if (thirdParty.trim() && limitKind === "other") {
      return setInvalid(
        "A third party's limit needs a kind: rate or capacity, API eligibility, permissions or policy.",
      );
    }
    setInvalid(null);
    onSave({
      entity_id: entity.id,
      statement: statement.trim(),
      detail: detail.trim() ? detail : null,
      type,
      severity,
      limit_kind: limitKind,
      third_party: thirdParty.trim() || null,
      status,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  }

  const label = "flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";
  // A label beside its select (not around it), so the options are not part of its name.
  const select = <T extends string>(name: string, value: T, options: [T, string][], set: (v: T) => void) => (
    <div className={label}>
      <label htmlFor={`${uid}-${name}`}>{name}</label>
      <select id={`${uid}-${name}`} className={INPUT} value={value} onChange={(e) => set(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <form onSubmit={submit} aria-label="Promote to blocker" className="flex flex-col gap-3">
      <p className="text-sm text-text2">Filled in from the intake answer. Change anything before you save.</p>
      <label className={label}>
        Statement
        <input className={INPUT} value={statement} onChange={(e) => setStatement(e.target.value)} />
      </label>
      <label className={label}>
        Detail
        <textarea className={INPUT} rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
        {select("Type", type, TYPES, setType)}
        {select("Severity", severity, SEVERITIES, setSeverity)}
        {select("Limit kind", limitKind, LIMIT_KINDS, setLimitKind)}
        {select("Status", status, STATUSES, setStatus)}
      </div>
      <label className={label}>
        Third party (optional)
        <input className={INPUT} value={thirdParty} onChange={(e) => setThirdParty(e.target.value)} />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold tracking-[0.02em] text-text2">Evidence</span>
        {entity.evidence.length === 0 ? (
          <p className="text-sm text-text2">None yet</p>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Blocker evidence">
            {entity.evidence.map((ev) => (
              <li key={ev.id} className="flex min-h-8 min-w-0 items-center gap-2">
                <EvidenceChip evidence={ev} low={low} />
                <span className="min-w-0 flex-1 truncate text-sm text-text2" title={ev.ref ?? ev.url ?? undefined}>
                  {ev.ref ?? ev.url}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[13px] text-text2">
          The item&apos;s evidence becomes the blocker&apos;s. Add or refresh it in the Evidence section.
        </p>
      </div>
      <label className={label}>
        Reason (optional)
        <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {invalid && <Notice tone="error">{invalid}</Notice>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" disabled={busy}>
          Save blocker
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <InfoTip label="saving" align="start">
          Saving makes this item a blocker and removes the suggested-blocker mark. A critical, hard blocker gates
          publishing the documents it is linked to.
        </InfoTip>
      </div>
    </form>
  );
}
