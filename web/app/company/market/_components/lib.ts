import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { calendarDay, zoneDay } from "@/lib/dates";

export type Competitor = Schemas["CompetitorOut"];
export type CompetitorDetail = Schemas["CompetitorDetail"];
export type WatchedPage = Schemas["PageOut"];
export type Change = Schemas["ChangeOut"];
export type ChangeDetail = Schemas["ChangeDetail"];
export type Finding = Schemas["WebFindingOut"];
export type Positioning = Schemas["PositioningOut"];
export type Suggestion = Schemas["PositioningSuggestionOut"];
export type FieldKey = keyof Schemas["PositioningFields"];
export type Kind = Competitor["kind"];
export type Label = WatchedPage["label"];
export type Rating = Change["rating"];

export const KIND_LABEL: Record<Kind, string> = { direct: "Direct", indirect: "Indirect", status_quo: "Status quo" };
export const KINDS: Kind[] = ["direct", "indirect", "status_quo"];

export const LABEL_TITLE: Record<Label, string> = {
  pricing: "Pricing",
  changelog: "Changelog",
  product: "Product",
  docs: "Docs",
  blog: "Blog",
  other: "Other",
};
export const LABELS = Object.keys(LABEL_TITLE) as Label[];

export const PAGE_STATE: Record<WatchedPage["status"], { label: string; kind: ChipKind }> = {
  active: { label: "Watched", kind: "pass" },
  paused: { label: "Paused", kind: "na" },
  blocked: { label: "Blocked", kind: "warn" },
  error: { label: "Not read", kind: "crit" },
};

export const RATING_LABEL: Record<Rating, string> = { minor: "Minor", notable: "Notable", major: "Major" };
export const RATING_KIND: Record<Rating, ChipKind> = { minor: "na", notable: "acc", major: "warn" };
export const RATINGS: Rating[] = ["minor", "notable", "major"];

export const FINDING_KIND: Record<Finding["kind"], string> = { news: "News", review: "Review", launch: "Launch", pricing: "Pricing", other: "Other" };

/** The six positioning inputs, in the canvas's order ([76]). */
export const FIELDS: { key: FieldKey; title: string; hint: string }[] = [
  { key: "alternatives", title: "Competitive alternatives", hint: "What customers would use if the company did not exist." },
  { key: "unique_attributes", title: "Unique attributes", hint: "What the company has that the alternatives lack." },
  { key: "value_and_proof", title: "Value and proof", hint: "What those attributes do for customers, and the proof." },
  { key: "best_fit_customers", title: "Best-fit customers", hint: "Who cares most about that value." },
  { key: "market_category", title: "Market category", hint: "The market the company says it competes in. People choose it." },
  { key: "trends", title: "Relevant trends", hint: "Trends that make the value matter now." },
];
export const FIELD_TITLE = Object.fromEntries(FIELDS.map((f) => [f.key, f.title])) as Record<FieldKey, string>;

/** Where a change came from: its page's label, or "From the web · <host>". */
export function originOf(c: Change): string {
  if (c.origin === "web") return c.web_host ? `From the web · ${c.web_host}` : "From the web";
  return c.page_label ? LABEL_TITLE[c.page_label] : "Page";
}

/** A finding's date: when it was published, else when Oracle found it ("found Nov 2"). */
export function findingDate(f: Finding): string {
  return f.published_on ? calendarDay(f.published_on) : `found ${calendarDay(f.found_on)}`;
}

/** An instant's day in the Company time zone ("Oct 23"). */
export const day = (iso: string, zone: string) => zoneDay(iso, zone);

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// --- H9 Pricing input: Pricing and Win and loss ------------------------------------------

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
