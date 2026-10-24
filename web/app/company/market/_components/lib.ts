import type { Schemas } from "@/lib/api/client";

export type Memo = Schemas["PricingMemoSummary"];
export type Deal = Schemas["DealOutcomeOut"];
export type Result = Deal["result"];
export type Reason = Deal["reason"];

export const MEMO_STATE: Record<Memo["state"], { label: string; kind: "na" | "acc" | "pass" | "now" }> = {
  draft: { label: "Draft", kind: "na" },
  in_review: { label: "In review", kind: "acc" },
  approved: { label: "Approved", kind: "pass" },
  decided: { label: "Decided", kind: "now" },
};

/** The results and reasons in plain words (oracle.pricing.outcomes). */
export const RESULTS: Record<Result, string> = { won: "Won", lost: "Lost", no_decision: "No decision", churned: "Churned" };
export const REASONS: Record<Reason, string> = {
  price: "Price",
  value: "Value not clear",
  product_gap: "Missing feature",
  alternative: "Chose an alternative",
  timing: "Timing",
  no_budget: "No budget",
  champion: "Lost the champion",
  other: "Other",
};
export const CURRENCIES = ["USD", "EUR", "GBP"] as const;

/** What a record keeps of its alternative until H7's alternatives land: "Alternative: <name>" in the note. */
export function alternativeOf(d: Pick<Deal, "reason_note">): string | null {
  return /(?:^|\n)Alternative: (.+)$/m.exec(d.reason_note ?? "")?.[1] ?? null;
}

/** The pricing memo list's key, shared by the Pricing tab and a memo's header. */
export const MEMOS_KEY = "pricing-memos";
