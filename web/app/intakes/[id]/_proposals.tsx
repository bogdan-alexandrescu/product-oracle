"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, Empty, type ChipKind } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, type Role } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { when, type Summary } from "./_lib";

type Proposal = Schemas["IntakeProposalOut"];

const KIND: Record<Proposal["kind"], string> = { research_run: "Research run", prd_patch: "PRD patch" };
const STATUS: Record<Proposal["status"], { label: string; kind: ChipKind }> = {
  proposed: { label: "Proposed", kind: "warn" },
  accepted: { label: "Accepted", kind: "pass" },
  dismissed: { label: "Dismissed", kind: "na" },
};
const DECIDE_REASON = "An approver accepts or dismisses proposals";

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** What the proposal would change: the PRD text a patch adds, or the run research would start. */
function ProposalDiff({ p }: { p: Proposal }) {
  const d = p.detail;
  if (p.kind === "prd_patch") {
    const where = [text(d.document) && `${d.document}${d.base_version != null ? ` v${d.base_version}` : ""}`, text(d.section_key)].filter(Boolean).join(" › ");
    return (
      <div data-testid="proposal-diff" className="flex min-w-0 flex-col gap-1 rounded-button border border-line bg-surface2 p-2.5 text-sm">
        {where && <span className="font-mono text-[13px] break-all text-text2">{where}</span>}
        <p className="break-words">
          <ins className="rounded-sm bg-pass-bg px-0.5 text-pass no-underline">{text(d.text) ?? "—"}</ins>
        </p>
      </div>
    );
  }
  return (
    <div data-testid="proposal-diff" className="flex min-w-0 flex-col gap-1 rounded-button border border-line bg-surface2 p-2.5 text-sm">
      {text(d.question) && <p className="break-words">{text(d.question)}</p>}
      <span className="text-[13px] text-text2">Depth: {text(d.depth) ?? "quick"}</span>
      {text(d.why) && <p className="text-[13px] break-words text-text2">{text(d.why)}</p>}
    </div>
  );
}

function Outcome({ p }: { p: Proposal }) {
  if (p.status === "accepted") {
    const run = text(p.result.run_id);
    if (run)
      return (
        <Link href={`/runs/${run}`} className="text-sm font-semibold text-accent-ink underline">
          Open the run
        </Link>
      );
    return <p className="text-sm text-text2">Added as feedback on the PRD</p>;
  }
  if (p.status === "dismissed" && p.decision_note) return <p className="text-sm break-words text-text2">Reason: {p.decision_note}</p>;
  return null;
}

function ProposalCard({ p, approver, onChanged }: { p: Proposal; approver: boolean; onChanged: () => void }) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[p.status];

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setDismissing(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const path = { params: { path: { proposal_id: p.id } } };
  const accept = () => act(() => unwrap(api.POST("/v1/intake-proposals/{proposal_id}/accept", path)));
  const dismiss = () => act(() => unwrap(api.POST("/v1/intake-proposals/{proposal_id}/dismiss", { ...path, body: { reason: reason.trim() || null } })));

  return (
    <li data-testid="proposal" className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface p-3 text-text">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 basis-60 text-[15px] font-semibold break-words">{p.title}</p>
        <span className="flex flex-wrap gap-1.5">
          <Chip kind="acc">{KIND[p.kind]}</Chip>
          <Chip kind={status.kind} dot data-testid="proposal-status">
            {status.label}
          </Chip>
        </span>
      </div>
      <span className="text-[13px] text-text2">Proposed {when(p.created_at)}</span>
      <ProposalDiff p={p} />
      <Outcome p={p} />
      {error && <InlineError>{error}</InlineError>}
      {approver &&
        p.status === "proposed" &&
        (dismissing ? (
          <div className="flex min-w-0 flex-col gap-2 rounded-button border border-line bg-surface2 p-2.5">
            <label className={FIELD_LABEL}>
              Reason (optional)
              <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} />
            </label>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="danger" disabled={busy} onClick={dismiss}>
                Dismiss proposal
              </Button>
              <Button variant="ghost" onClick={() => setDismissing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button variant="solid" icon="check" disabled={busy} onClick={accept}>
              Accept
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDismissing(true)}>
              Dismiss
            </Button>
          </div>
        ))}
    </li>
  );
}

/**
 * The brief's proposals (#343): research runs and PRD patches, each with what it would
 * change. An approver accepts (a research run starts; a patch becomes feedback on the PRD)
 * or dismisses, with an optional reason. Others do not see those controls (a control a role
 * can never use is hidden, owner rule #370); the note says who decides.
 */
export function ProposalsTab({ summary: s, role, onChanged }: { summary: Summary; role: Role | null; onChanged: () => void }) {
  const approver = hasRole(role, "approver");
  const proposals = [...s.proposals].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <div data-testid="intake-proposals" className="flex min-w-0 flex-col gap-3 pt-3">
      {!approver && (
        <p data-testid="proposals-role-note" role="note" className="text-[13px] text-text2">
          {DECIDE_REASON}; you can read them.
        </p>
      )}
      {proposals.length === 0 ? (
        <Empty>No proposals yet</Empty>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {proposals.map((p) => (
            <ProposalCard key={`${p.id}-${p.status}`} p={p} approver={approver} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );
}
