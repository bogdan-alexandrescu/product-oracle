"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { todayIn, useCompanyZone } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

import { CURRENCIES, REASONS, RESULTS, type Deal, type Reason, type Result } from "./lib";
import { Modal } from "./Modal";

type Form = {
  result: Result;
  account: string;
  segment: string;
  plan: string;
  annual_value: string;
  currency: "" | (typeof CURRENCIES)[number];
  decided_on: string;
  reason: Reason;
  reason_note: string;
  price_quoted: string;
};

const LABEL = "flex flex-col gap-1 text-sm font-semibold text-text2";

/**
 * Add or edit one win or loss record (H9): the result, the account as given (no contact
 * details), the day it was decided (not after today in the Company time zone) and the main
 * reason; Other needs a note.
 */
export function DealDialog({ deal, onClose, onSaved }: { deal: Deal | null; onClose: () => void; onSaved: () => void }) {
  const today = todayIn(useCompanyZone());
  const [f, setF] = useState<Form>(() => ({
    result: deal?.result ?? "lost",
    account: deal?.account ?? "",
    segment: deal?.segment ?? "",
    plan: deal?.plan ?? "",
    annual_value: deal?.annual_value != null ? String(deal.annual_value) : "",
    currency: deal?.currency ?? "",
    decided_on: deal?.decided_on ?? today,
    reason: deal?.reason ?? "price",
    reason_note: deal?.reason_note ?? "",
    price_quoted: deal?.price_quoted ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.account.trim()) return setError("Name the account, as you label it");
    if (f.reason === "other" && !f.reason_note.trim()) return setError("Other needs a note");
    if (!f.decided_on || f.decided_on > today) return setError("The day it was decided is today or earlier");
    if (!!f.annual_value.trim() !== !!f.currency) return setError("Give the annual value with its currency, or neither");
    const fields = {
      result: f.result,
      account: f.account.trim(),
      segment: f.segment.trim() || null,
      plan: f.plan.trim() || null,
      annual_value: f.annual_value.trim() || null,
      currency: f.currency || null,
      decided_on: f.decided_on,
      reason: f.reason,
      reason_note: f.reason_note.trim() || null,
      price_quoted: f.price_quoted.trim() || null,
    } satisfies Partial<Schemas["DealOutcomeIn"]>;
    setBusy(true);
    setError(null);
    try {
      if (deal) {
        await unwrap(api.PATCH("/v1/deal-outcomes/{outcome_id}", { params: { path: { outcome_id: deal.id } }, body: { ...fields, lock_version: deal.lock_version } }));
      } else {
        await unwrap(api.POST("/v1/deal-outcomes", { body: fields }));
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal id="deal-title" title={deal ? "Edit win or loss" : "Add win or loss"} testId="deal-dialog" onClose={onClose}>
      <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
        <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
          <label className={LABEL}>
            Result
            <select className={INPUT} value={f.result} onChange={(e) => set("result", e.target.value as Result)} data-autofocus="">
              {(Object.keys(RESULTS) as Result[]).map((r) => (
                <option key={r} value={r}>
                  {RESULTS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Decided on
            <input type="date" className={INPUT} value={f.decided_on} max={today} onChange={(e) => set("decided_on", e.target.value)} />
          </label>
        </div>
        <label className={LABEL}>
          Account
          <input className={INPUT} value={f.account} maxLength={120} placeholder="Account 14" onChange={(e) => set("account", e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
          <label className={LABEL}>
            Segment
            <input className={INPUT} value={f.segment} maxLength={200} onChange={(e) => set("segment", e.target.value)} />
          </label>
          <label className={LABEL}>
            Plan
            <input className={INPUT} value={f.plan} maxLength={200} onChange={(e) => set("plan", e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
          <label className={LABEL}>
            Annual value
            <input className={INPUT} inputMode="decimal" value={f.annual_value} onChange={(e) => set("annual_value", e.target.value)} />
          </label>
          <label className={LABEL}>
            Currency
            <select className={INPUT} value={f.currency} onChange={(e) => set("currency", e.target.value as Form["currency"])}>
              <option value="">None</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={LABEL}>
          Main reason
          <select className={INPUT} value={f.reason} onChange={(e) => set("reason", e.target.value as Reason)}>
            {(Object.keys(REASONS) as Reason[]).map((r) => (
              <option key={r} value={r}>
                {REASONS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Note{f.reason === "other" ? " (needed for Other)" : ""}
          <textarea className={INPUT} rows={2} value={f.reason_note} maxLength={2000} onChange={(e) => set("reason_note", e.target.value)} />
        </label>
        <label className={LABEL}>
          Price quoted
          <input className={INPUT} value={f.price_quoted} maxLength={200} placeholder="$20 per seat a month" onChange={(e) => set("price_quoted", e.target.value)} />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {deal ? "Save" : "Add"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
