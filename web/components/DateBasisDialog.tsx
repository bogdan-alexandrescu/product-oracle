"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button, Icon, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

export type Basis = Schemas["ScheduleBasisOut"];
export type DateRights = Schemas["DateRightsOut"];
type Kind = Schemas["ScheduleBasisCreate"]["kind"];

export const KIND_LABEL: Record<Kind, string> = {
  estimate: "Estimate",
  capacity: "Capacity plan",
  commitment: "Commitment",
};
export const HELP =
  "Record what supports this date: an estimate, a capacity plan or a commitment from the team doing the work. Oracle never invents dates.";
export const LEAD_VERIFIES = "The engineering lead verifies it before any date rests on it.";

const dayFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
/** "2026-11-30" (or a timestamp) as "Nov 30". */
export const shortDay = (iso: string) => dayFmt.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));

/** F3: what the signed-in member may do with a date basis (GET /v1/schedule-bases/rights). */
export function useDateRights() {
  return useQuery("schedule-bases|rights", () => unwrap(api.GET("/v1/schedule-bases/rights")));
}

/** The dialog frame: a centred card over the page, full width on a phone. */
function Frame({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid={testId}
        className="w-full max-w-xl overflow-hidden rounded-inspector border border-line bg-surface text-text shadow-tip"
      >
        <div className="flex items-center justify-between gap-3 bg-hero px-5 py-4 text-hero-text max-[600px]:px-4">
          <h2 id={`${id}-title`} className="font-display text-[20px] leading-[26px] font-bold tracking-heading">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 place-items-center rounded-lg text-hero-text2 hover:bg-hero-2 hover:text-hero-text"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4 text-[15px] max-[600px]:px-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
        {label}
      </label>
      {children}
    </div>
  );
}

export type BasisPrefill = {
  prd?: string;
  supports_date?: string;
  reference?: string;
  item_key?: string;
};

/**
 * F3 Record basis: the estimate, capacity plan or commitment a date rests on. A lead or an
 * owner verifies it by recording it; an approver (while a lead is named) proposes it.
 */
export function DateBasisDialog({
  prefill = {},
  rights,
  onClose,
  onSaved,
}: {
  prefill?: BasisPrefill;
  rights: DateRights;
  onClose: () => void;
  onSaved: (basis: Basis) => void;
}) {
  const id = useId();
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const [prd, setPrd] = useState(prefill.prd ?? "");
  const [kind, setKind] = useState<Kind>("estimate");
  const [reference, setReference] = useState(prefill.reference ?? "");
  const [day, setDay] = useState(prefill.supports_date ?? "");
  const [scope, setScope] = useState<"prd" | "item" | "tracker">(prefill.item_key ? "item" : "prd");
  const [key, setKey] = useState(prefill.item_key ?? "");
  const [recordId, setRecordId] = useState("");
  const [detail, setDetail] = useState("");
  // The PRD's roadmap items (from the plan) and the tracker records of its tracks, for the pickers.
  const plan = useQuery("plan|approved|basis", () => unwrap(api.GET("/v1/plan", { params: { query: { scope: "approved" } } })));
  const records = useQuery("tracker|records", () => unwrap(api.GET("/v1/tracker/records", { params: { query: { limit: 500 } } })));
  const prdId = prds.data?.find((d) => d.slug === prd || d.id === prd)?.id ?? prd;
  const items = [...new Map((plan.data?.items ?? []).filter((i) => i.prd?.id === prdId).map((i) => [i.key, i])).values()];
  const tracks = new Set(items.map((i) => i.track_id).filter(Boolean));
  const prdRecords = (records.data ?? []).filter((r) => r.track_id && tracks.has(r.track_id) && r.target_date);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const propose = rights.rights === "propose";
  const ready = !!prd && !!reference.trim() && !!day && (scope === "prd" || !!key.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const basis = await unwrap(
        api.POST("/v1/schedule-bases", {
          body: {
            prd,
            kind,
            reference: reference.trim(),
            supports_date: day,
            detail: detail.trim() || null,
            item_key: scope === "item" ? key.trim() : null,
            tracker_key: scope === "tracker" ? key.trim() : null,
            tracker_record_id: recordId || null,
          },
        }),
      );
      onSaved(basis);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Frame title="Record basis" onClose={onClose} testId="date-basis-dialog">
      <p className="text-text2">{HELP}</p>
      <Field label="PRD" htmlFor={`${id}-prd`}>
        <select id={`${id}-prd`} className={INPUT} value={prd} onChange={(e) => setPrd(e.target.value)}>
          <option value="">Choose a PRD</option>
          {prefill.prd && !prds.data?.some((d) => d.slug === prefill.prd || d.id === prefill.prd) && (
            <option value={prefill.prd}>{prefill.prd}</option>
          )}
          {(prds.data ?? []).map((d) => (
            <option key={d.id} value={d.id === prefill.prd ? d.id : d.slug}>
              {d.title}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
        <Field label="Kind" htmlFor={`${id}-kind`}>
          <select id={`${id}-kind`} className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference" htmlFor={`${id}-ref`}>
          <input
            id={`${id}-ref`}
            className={INPUT}
            value={reference}
            placeholder="ENG-412"
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Date it supports" htmlFor={`${id}-date`}>
        <input id={`${id}-date`} type="date" className={INPUT} value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Field label="For" htmlFor={`${id}-for`}>
        <select id={`${id}-for`} className={INPUT} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="prd">Whole PRD</option>
          <option value="item">One item</option>
          <option value="tracker">Items of one tracker issue</option>
        </select>
      </Field>
      {scope === "item" && (
        <Field label="Item" htmlFor={`${id}-item`}>
          <select id={`${id}-item`} className={INPUT} value={key} onChange={(e) => setKey(e.target.value)}>
            <option value="">Choose an item</option>
            {key && !items.some((i) => i.key === key) && <option value={key}>{key}</option>}
            {items.map((i) => (
              <option key={i.key} value={i.key}>
                {i.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {scope === "tracker" && (
        <Field label="Tracker issue key" htmlFor={`${id}-key`}>
          <input id={`${id}-key`} className={INPUT} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
      )}
      <Field label="From a tracker record (optional)" htmlFor={`${id}-record`}>
        <select
          id={`${id}-record`}
          className={INPUT}
          value={recordId}
          onChange={(e) => {
            const r = prdRecords.find((x) => x.id === e.target.value);
            setRecordId(r?.id ?? "");
            if (r) {
              setReference(r.external_ref);
              setDay(r.target_date!);
            }
          }}
        >
          <option value="">None</option>
          {prdRecords.map((r) => (
            <option key={r.id} value={r.id}>
              {[r.external_ref, r.title, shortDay(r.target_date!)].filter(Boolean).join(" · ")}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Detail (optional)" htmlFor={`${id}-detail`}>
        <textarea id={`${id}-detail`} className={INPUT} rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </Field>
      {propose && <p className="text-sm text-text2">{LEAD_VERIFIES}</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || busy} onClick={submit}>
          {propose ? "Propose for verification" : "Verify"}
        </Button>
      </div>
    </Frame>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "This removes Nov 30 from: 1 milestone (Beta), 2 roadmap items (…), 1 roadmap document (…)." */
export function impactSentence(basis: Basis, impact: Schemas["BasisImpactOut"]): string {
  const parts: string[] = [];
  const undated = impact.milestones.filter((m) => !m.keeps_date);
  if (undated.length)
    parts.push(`${plural(undated.length, "milestone", "milestones")} (${undated.map((m) => m.name).join(", ")})`);
  if (impact.items.length)
    parts.push(`${plural(impact.items.length, "roadmap item", "roadmap items")} (they will be marked for review)`);
  for (const d of impact.documents)
    parts.push(`1 roadmap document (v${d.version}: ${plural(d.marks, "place", "places")} will show 'date withdrawn')`);
  if (!parts.length) return `Nothing rests on ${shortDay(basis.supports_date)} through ${basis.reference} now.`;
  return `This removes ${shortDay(basis.supports_date)} from: ${parts.join(", ")}.`;
}

/** F3 Withdraw: the impact first, then a required reason. */
export function WithdrawBasisDialog({ basis, onClose, onDone }: { basis: Basis; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const impact = useQuery(`schedule-bases|impact|${basis.id}`, () =>
    unwrap(
      api.GET("/v1/schedule-bases/{basis_id}/impact", {
        params: { path: { basis_id: basis.id } },
      }),
    ),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/schedule-bases/{basis_id}/withdraw", {
          params: { path: { basis_id: basis.id } },
          body: { reason: reason.trim() },
        }),
      );
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Frame title={`Withdraw ${basis.reference}`} onClose={onClose} testId="withdraw-basis-dialog">
      <p data-testid="withdraw-impact" className="font-medium">
        {impact.data ? impactSentence(basis, impact.data) : (impact.error ?? "Reading what rests on this date…")}
      </p>
      <Field label="Reason" htmlFor={`${id}-reason`}>
        <textarea id={`${id}-reason`} className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!reason.trim() || !impact.data || busy} onClick={submit}>
          Withdraw date basis
        </Button>
      </div>
    </Frame>
  );
}

/** F3 Reject: a required reason. */
export function RejectBasisDialog({ basis, onClose, onDone }: { basis: Basis; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/schedule-bases/{basis_id}/reject", {
          params: { path: { basis_id: basis.id } },
          body: { reason: reason.trim() },
        }),
      );
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Frame title={`Reject ${basis.reference}`} onClose={onClose} testId="reject-basis-dialog">
      <Field label="Reason" htmlFor={`${id}-reason`}>
        <textarea id={`${id}-reason`} className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!reason.trim() || busy} onClick={submit}>
          Reject
        </Button>
      </div>
    </Frame>
  );
}

/** Verify a proposed basis in one click. */
export async function verifyBasis(basis: Basis): Promise<Basis> {
  return unwrap(
    api.POST("/v1/schedule-bases/{basis_id}/verify", {
      params: { path: { basis_id: basis.id } },
      body: { note: null },
    }),
  );
}
