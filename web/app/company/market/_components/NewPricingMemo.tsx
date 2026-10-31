"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { addMonths, todayIn, useCompanyZone } from "@/lib/dates";
import { useFlowCost } from "@/lib/flow-cost";
import { formatMoney } from "@/lib/format";
import { errorMessage } from "@/lib/use-query";

import { Modal } from "./Modal";

const QUESTION_MAX = 300;

/** A memo's title from its question: the first words, without the question mark. */
function titleOf(question: string): string {
  const words = question.trim().replace(/[?.!]+$/, "").split(/\s+/).slice(0, 8).join(" ");
  return words ? `Pricing: ${words}` : "Pricing memo";
}

/**
 * New pricing memo (H9; approvers and owners): the question and the evidence window (the
 * last six months by default, in the Company time zone), then Draft with Oracle: the memo
 * starts from the pricing options memo template and Oracle's pricing_memo run writes it at
 * standard depth. qa4-company-32: the dialog says what the run costs, as New update does.
 */
export function NewPricingMemo({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const today = todayIn(useCompanyZone());
  const [question, setQuestion] = useState("");
  const [from, setFrom] = useState(() => addMonths(today, -6));
  const [to, setTo] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // qa4-company-32: the run's cost from the flow catalog (each step's roles at standard depth,
  // as the run's estimate counts them), and who approves it over the approval threshold.
  const cost = useFlowCost("pricing_memo");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return setError("Say the pricing question in one sentence");
    if (!from || !to) return setError("Choose the evidence window's first and last day");
    if (from > to) return setError("The evidence window starts after it ends");
    setBusy(true);
    setError(null);
    try {
      const draft = await unwrap(
        api.POST("/v1/drafts", { body: { kind: "pricing", title: titleOf(q), template: "pricing-options-memo", question: q, period: { from, to } } }),
      );
      const run = await unwrap(
        api.POST("/v1/runs", { body: { flow: "pricing_memo", document: draft.slug, knobs: { depth: "standard", roles: {}, checkpoints: {} } } }),
      );
      await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: run.id } } }));
      router.push(`/documents/${draft.slug}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal id="new-pricing-memo-title" title="New pricing memo" testId="new-pricing-memo" onClose={onClose}>
      <form className="flex flex-col gap-4 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Question
          <textarea
            className={INPUT}
            rows={2}
            value={question}
            maxLength={QUESTION_MAX}
            data-autofocus=""
            placeholder="Should the team plan move from per-seat to a flat price per team?"
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-semibold text-text2">Evidence window</legend>
          <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              From
              <input type="date" className={INPUT} value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              To
              <input type="date" className={INPUT} value={to} max={today} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <p className="text-sm text-text2">The last six months by default, in the Company time zone.</p>
        </fieldset>
        <p className="text-sm text-text2">
          Oracle drafts the memo from pricing interviews, win and loss records and the sources: the options, the evidence and a research plan. It never
          decides a price; the pricing owner does, in the decision log. Owners and approvers see it.
        </p>
        {cost && (
          <p className="text-sm text-text" data-testid="pricing-memo-cost">
            The draft is one Oracle run of about <span className="tnum font-semibold">{formatMoney(cost.usd)}</span>.
            {cost.over && ` Over ${formatMoney(cost.threshold)}, an owner approves the cost before it runs.`}
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Drafting…" : cost ? `Draft with Oracle · ${formatMoney(cost.usd)}` : "Draft with Oracle"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
