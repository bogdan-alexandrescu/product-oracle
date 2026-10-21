"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { Button, Chip, Empty, FilterChips, InfoTip, Panel } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { FINDING_LABEL, FINDING_STATES, canWaive, shortDate, subjectHref, subjectName, type Finding, type FindingState, type Stack } from "./lib";

/** Waive a finding with a reason (the reason is required, as the API). */
export function WaiveForm({ finding, onWaived, onCancel }: { finding: Finding; onWaived: (f: Finding) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function waive() {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/strategy/findings/{finding_id}/waive", { params: { path: { finding_id: finding.id } }, body: { reason: reason.trim() } }),
      );
      onWaived(out);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label="Waive finding" className="mt-2 flex flex-col gap-2 rounded-button bg-surface2 p-3">
      <label htmlFor={`${id}-reason`} className="text-sm font-semibold text-text">
        Why waive it?
      </label>
      <textarea
        id={`${id}-reason`}
        data-autofocus
        rows={2}
        className={INPUT}
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
        placeholder="The reason stays with the finding."
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !reason.trim()} onClick={waive}>
          {busy ? "Waiving…" : "Waive finding"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One finding: what it is, about what, since when; Waive and Open. */
export function FindingRow({
  finding: f,
  stack,
  onWaived,
  testId = "finding-row",
}: {
  finding: Finding;
  stack: Stack | undefined;
  onWaived: (f: Finding) => void;
  testId?: string;
}) {
  const { role } = useMe();
  const [waiving, setWaiving] = useState(false);
  const href = subjectHref(f, stack);
  const draft = f.detail?.draft === true;
  return (
    <li data-testid={testId} data-kind={f.kind} data-status={f.status} className="border-t border-line px-4 py-3 first:border-t-0 max-[600px]:px-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-text">{FINDING_LABEL[f.kind]}</span>
        {f.severity === "high" && <Chip kind="crit">High</Chip>}
        <span className="min-w-0 flex-1 text-text2 [overflow-wrap:anywhere]">
          {subjectName(f, stack)}
          {draft && <span className="ml-1.5 text-sm">(draft)</span>}
        </span>
        <span className="tnum text-sm text-text2">Since {shortDate(f.first_seen_at)}</span>
        {href && (
          <Link href={href} className="text-sm font-medium text-accent-ink hover:underline">
            Open
          </Link>
        )}
        {canWaive(f, role) && !waiving && (
          <Button variant="ghost" onClick={() => setWaiving(true)}>
            Waive
          </Button>
        )}
      </div>
      {f.status === "waived" && f.waive_reason && (
        <p className="mt-1 text-sm text-text2">
          Waived {shortDate(f.waived_at)}: {f.waive_reason}
        </p>
      )}
      {f.status === "resolved" && <p className="mt-1 text-sm text-text2">Resolved {shortDate(f.resolved_at)}</p>}
      {waiving && <WaiveForm finding={f} onCancel={() => setWaiving(false)} onWaived={onWaived} />}
    </li>
  );
}

/** The drift findings, Open · Waived · Resolved. Drift is advisory: nothing waits on a finding. */
export function DriftList({
  state,
  onState,
  rows,
  loading,
  error,
  stack,
  onWaived,
}: {
  state: FindingState;
  onState: (s: FindingState) => void;
  rows: Finding[] | undefined;
  loading: boolean;
  error: string | null;
  stack: Stack | undefined;
  onWaived: (f: Finding) => void;
}) {
  const counts: Partial<Record<FindingState, number>> = { open: stack?.counts.open, waived: stack?.counts.waived };
  return (
    <Panel
      title="Drift"
      testId="drift-list"
      tools={
        <InfoTip label="strategy drift" align="end">
          Oracle checks every day, and after a strategy, vision, roadmap or goal changes, whether the goals follow from the strategy and
          the roadmap from the goals. Drift is advisory: nothing waits on a finding. Waive one with a reason and it stays waived until its
          subject changes again.
        </InfoTip>
      }
    >
      <div className="border-b border-line px-4 py-3 max-[600px]:px-3">
        <FilterChips
          label="Finding state"
          testId="finding-state"
          items={FINDING_STATES.map((s) => ({ value: s.value, label: s.label, count: counts[s.value] }))}
          value={state}
          onChange={onState}
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!rows && loading ? (
        <div className="px-4 py-3">
          <Loading />
        </div>
      ) : rows && rows.length === 0 ? (
        <Empty testId="drift-empty">{state === "open" ? "No open findings" : state === "waived" ? "Nothing waived" : "Nothing resolved"}</Empty>
      ) : (
        <ul>
          {(rows ?? []).map((f) => (
            <FindingRow key={f.id} finding={f} stack={stack} onWaived={onWaived} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
