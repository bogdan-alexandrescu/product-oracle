/**
 * H9 Pricing input in the mock: the pricing options memo template (word for word
 * api/oracle/templates/builtin/pricing/pricing-options-memo.md, its headings), the draft a
 * pricing_memo run writes, and the win and loss records with their CSV import
 * (oracle.pricing.outcomes). Owners and approvers only, as the API. Made-up deals and
 * accounts only ("Account 14"); the company is the fictional "Example Co".
 */
import type { Schemas } from "@/lib/api/client";

import type { SectionSeed } from "./fixtures";

type DealOut = Schemas["DealOutcomeOut"];
type DealIn = Schemas["DealOutcomeIn"];
type Role = Schemas["Me"]["role"];
export type Result = DealOut["result"];
export type Reason = DealOut["reason"];
export type EvidenceWindow = Schemas["UpdatePeriod"];

export const PRICING_TEMPLATE = "pricing-options-memo";
export const PRICING_BRIEF = ["question", "recommendation", "options"];

export interface PricingOption {
  id: string;
  title: string;
  reversibility: "reversible" | "irreversible";
  recommended: boolean;
  summary: string;
}

export interface PricingDb {
  deals: DealOut[];
}

export interface PricingContext {
  me: { id: string; role: Role };
  uuid: () => string;
  now: () => string;
  /** Today in the Company time zone, YYYY-MM-DD. */
  today: () => string;
}

const RESULT_LABELS: Record<Result, string> = { won: "Won", lost: "Lost", no_decision: "No decision", churned: "Churned" };
const REASON_LABELS: Record<Reason, string> = {
  price: "Price",
  value: "Value not clear",
  product_gap: "Missing feature",
  alternative: "Chose an alternative",
  timing: "Timing",
  no_budget: "No budget",
  champion: "Lost the champion",
  other: "Other",
};
const CURRENCIES = ["USD", "EUR", "GBP"] as const;
const REQUIRED = ["result", "account", "decided_on", "reason"];
const COLUMNS = ["result", "account", "segment", "plan", "annual_value", "currency", "decided_on", "reason", "reason_note", "alternative", "price_quoted"];
const MAX_ROWS = 2000;
const MAX_BYTES = 1024 * 1024;
const ACCOUNT_MAX = 120;
const LABEL_MAX = 200;
const NOTE_MAX = 2000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

// ----------------------------------------------------------------------------- the memo

/** A new memo from the template (start_draft): its headings, the hints kept as italic prompts. */
export function pricingTemplateSections(title: string): SectionSeed[] {
  const hint = (text: string) => `_${text}_`;
  return [
    { key: "title", level: 1, heading: title, body: hint("Input for one pricing question. The price is decided by the pricing owner in the decision log, never here.") },
    { key: "question", level: 2, heading: "The question", body: hint("The question, why it comes up now, and who decides it (the pricing owner).") },
    { key: "recommendation", level: 2, heading: "Recommendation", body: hint("The recommended option and why, in one paragraph.") },
    { key: "options", level: 2, heading: "Options", body: hint("One section per option.") },
    { key: "full", level: 1, heading: "Full version", body: hint("Everything below is the detail behind the brief.") },
    { key: "willingness-to-pay", level: 2, heading: "Willingness to pay", body: "_To write._" },
    { key: "win-loss", level: 2, heading: "Win and loss", body: "_To write._" },
    { key: "usage-by-plan", level: 2, heading: "Usage by plan", body: "_To write._" },
    { key: "alternatives-pricing", level: 2, heading: "Alternatives' pricing", body: "_To write._" },
    { key: "research-plan", level: 2, heading: "Research plan", body: "_To write._" },
    { key: "risks", level: 2, heading: "Risks", body: "_To write._" },
    { key: "sources", level: 2, heading: "Sources and data points", body: "_To write._" },
  ];
}

/** The two options the mock's pricing_memo run sets out (the second recommended). */
export const DRAFT_OPTIONS: PricingOption[] = [
  {
    id: "keep",
    title: "Keep per-seat pricing",
    reversibility: "reversible",
    recommended: false,
    summary: "Teams keep paying $20 per seat a month. Nothing changes for existing customers; growing teams still meet a bill that rises with every seat.",
  },
  {
    id: "flat-team",
    title: "Flat price per team",
    reversibility: "irreversible",
    recommended: true,
    summary: "Teams of 10 to 50 pay $400 a month, whatever their seat count. Larger teams pay less per seat; teams under 20 seats pay more.",
  },
];

/** A memo version's front matter: kind, template, its brief, question, options and evidence window. */
export function pricingFrontMatter(slug: string, title: string, question: string | null, window: EvidenceWindow, options: PricingOption[] = []): Record<string, unknown> {
  return {
    document: slug,
    title,
    template: PRICING_TEMPLATE,
    template_version: "1",
    kind: "pricing",
    brief: PRICING_BRIEF,
    question,
    options: options.map(({ id, title, reversibility, recommended }) => ({ id, title, reversibility, recommended })),
    evidence_window: window,
  };
}

/** The draft a pricing_memo run writes for `question`: the question, the recommendation and the options first. */
export function pricingDraftSections(title: string, question: string, window: EvidenceWindow, options: PricingOption[] = DRAFT_OPTIONS): SectionSeed[] {
  const recommended = options.find((o) => o.recommended);
  return [
    { key: "title", level: 1, heading: title, body: "Input for the pricing owner. Oracle sets out the options and the evidence; the price is decided in the decision log." },
    { key: "question", level: 2, heading: "The question", body: `${question}\n\nWhy now: a third of lost deals this half named price. The pricing owner decides.` },
    {
      key: "recommendation",
      level: 2,
      heading: "Recommendation",
      body: recommended
        ? `Oracle recommends **${recommended.title}**, tested first with new teams of 10 to 50 for one quarter. The pricing owner decides.`
        : "The options are set out without a recommendation.",
    },
    { key: "options", level: 2, heading: "Options", body: `${options.length} options, each with what it changes and the cost of being wrong.` },
    ...options.map((o) => ({
      key: `option-${o.id}`,
      level: 3,
      heading: o.title,
      body: `${o.summary}\n\n- Reversibility: ${o.reversibility === "reversible" ? "reversible" : "hard to reverse"}\n- How to test it first: offer it to new teams for one quarter.`,
    })),
    { key: "full", level: 1, heading: "Full version", body: "The detail behind the brief." },
    { key: "willingness-to-pay", level: 2, heading: "Willingness to pay", body: "Two pricing interviews: a flat team price felt like a bargain below $450 a month." },
    { key: "win-loss", level: 2, heading: "Win and loss", body: `From ${window.from} to ${window.to}: 4 won, 3 lost (2 on price), 1 no decision.` },
    { key: "usage-by-plan", level: 2, heading: "Usage by plan", body: "No usage figures in Oracle." },
    { key: "alternatives-pricing", level: 2, heading: "Alternatives' pricing", body: "No watched pricing pages in Oracle." },
    { key: "research-plan", level: 2, heading: "Research plan", body: "- Five pricing interviews with teams of 10 or more.\n- Ask lost accounts what price they compared against." },
    { key: "risks", level: 2, heading: "Risks", body: "- Teams under 20 seats pay more with a flat price; some may leave." },
    { key: "sources", level: 2, heading: "Sources and data points", body: "Every number above, with its value, as-of date and source." },
    { key: "sources-list", level: 3, heading: "Sources", body: "- d1: oracle, Win and loss records, retrieved 2026-10-20\n- i1: oracle, Pricing interviews, retrieved 2026-10-20" },
    { key: "sources-data", level: 3, heading: "Data points", body: "- $20 per seat a month: the Team plan's price, from d1\n- $400 a month: the flat price asked for, from i1\n- 2 of 3 losses on price, from d1" },
    { key: "sources-evidence", level: 3, heading: "Evidence by section", body: "- options: d1, i1\n- win-loss: d1\n- willingness-to-pay: i1" },
  ];
}

/** The front matter's options with each option section's first paragraph, as Decide reads them. */
export function memoOptions(frontMatter: Record<string, unknown>, sections: { section_key: string; body_md: string }[]): PricingOption[] {
  const listed = (frontMatter.options as Omit<PricingOption, "summary">[] | undefined) ?? [];
  return listed.map((o) => ({
    ...o,
    summary: (sections.find((s) => s.section_key === `option-${o.id}`)?.body_md.split(/\n\s*\n/)[0] ?? "").slice(0, 500),
  }));
}

// ----------------------------------------------------------------------------- win and loss

/** The pricing scenario's made-up deals: 8 records over the last months. */
export function seedDeals(ctx: PricingContext, recorder: string): DealOut[] {
  const rows: [Result, string, string, string, number | null, string, Reason, string | null, string | null][] = [
    ["won", "Account 3", "Teams 10-50", "Team", 4800, "2026-09-12", "value", null, "$20 per seat a month"],
    ["lost", "Account 7", "Teams 10-50", "Team", 6000, "2026-09-20", "price", "Asked for a flat team price", "$20 per seat a month"],
    ["lost", "Account 9", "Teams 50+", "Business", null, "2026-09-28", "alternative", "Alternative: Example Rival", null],
    ["won", "Account 11", "Teams under 10", "Starter", 960, "2026-10-02", "timing", null, null],
    ["no_decision", "Account 12", "Teams 10-50", "Team", null, "2026-10-06", "no_budget", null, null],
    ["churned", "Account 14", "Teams 10-50", "Team", 3600, "2026-10-09", "price", "Seat count grew faster than budget", "$20 per seat a month"],
  ];
  return rows.map(([result, account, segment, plan, value, decided_on, reason, note, price]) => ({
    id: ctx.uuid(),
    result,
    account,
    segment,
    plan,
    annual_value: value,
    currency: value == null ? null : "USD",
    decided_on,
    reason,
    reason_note: note,
    competitor_id: null,
    price_quoted: price,
    source_item_id: null,
    source_item: null,
    recorded_by: recorder,
    created_at: `${decided_on}T17:00:00Z`,
    updated_at: `${decided_on}T17:00:00Z`,
    lock_version: 1,
  }));
}

/** As oracle.pricing.outcomes.rule_problem: the rules across fields; null when they hold. */
function ruleProblem(r: { reason: Reason; reason_note: string | null; annual_value: number | null; currency: string | null; decided_on: string }, today: string): string | null {
  if (r.reason === "other" && !r.reason_note) return "reason other needs a reason_note";
  if (r.annual_value != null && r.currency == null) return "annual_value needs a currency";
  if (r.currency != null && r.annual_value == null) return "currency needs an annual_value";
  if (r.decided_on > today) return "decided_on is in the future";
  return null;
}

const key = (text: string) => text.replace(/[_-]/g, " ").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const lookup = <K extends string>(labels: Record<K, string>) =>
  Object.fromEntries((Object.entries(labels) as [K, string][]).flatMap(([k, v]) => [[key(k), k], [key(v), k]])) as Record<string, K>;
const RESULTS = lookup(RESULT_LABELS);
const REASONS = lookup(REASON_LABELS);

/** One CSV row as a record's fields, or the first problem in plain words (as _row). */
function rowOf(values: Record<string, string>, today: string): [Omit<DealIn, "competitor_id" | "source_item_id"> | null, string | null] {
  const result = RESULTS[key(values.result ?? "")];
  if (!result) return [null, `result must be one of: ${Object.values(RESULT_LABELS).join(", ")}`];
  const account = (values.account ?? "").trim();
  if (!account) return [null, "account is required"];
  if (account.length > ACCOUNT_MAX) return [null, `account is longer than ${ACCOUNT_MAX} characters`];
  const text = (name: string, cap: number): string | null | Error => {
    const v = (values[name] ?? "").trim() || null;
    return v && v.length > cap ? new Error(`${name} is longer than ${cap} characters`) : v;
  };
  const texts: Record<string, string | null> = {};
  for (const [name, cap] of [["segment", LABEL_MAX], ["plan", LABEL_MAX], ["price_quoted", LABEL_MAX], ["reason_note", NOTE_MAX]] as const) {
    const v = text(name, cap);
    if (v instanceof Error) return [null, v.message];
    texts[name] = v;
  }
  const raw = (values.annual_value ?? "").trim().replace(/,/g, "");
  let annual_value: number | null = null;
  if (raw) {
    annual_value = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(annual_value) || annual_value < 0 || annual_value >= 1e12) return [null, "annual_value must be a number of 0 or more"];
  }
  const currency = (values.currency ?? "").trim().toUpperCase() || null;
  if (currency && !(CURRENCIES as readonly string[]).includes(currency)) return [null, "currency must be USD, EUR or GBP"];
  const decided_on = (values.decided_on ?? "").trim();
  if (!DAY.test(decided_on) || Number.isNaN(Date.parse(`${decided_on}T00:00:00Z`)) || new Date(`${decided_on}T00:00:00Z`).toISOString().slice(0, 10) !== decided_on) {
    return [null, "decided_on must be YYYY-MM-DD"];
  }
  const reason = REASONS[key(values.reason ?? "")];
  if (!reason) return [null, `reason must be one of: ${Object.values(REASON_LABELS).join(", ")}`];
  const alternative = (values.alternative ?? "").trim();
  let note = texts.reason_note;
  if (alternative) {
    // H7's alternatives are not here yet: kept as text.
    note = note ? `${note}\nAlternative: ${alternative}` : `Alternative: ${alternative}`;
    if (note.length > NOTE_MAX) return [null, `reason_note and alternative are longer than ${NOTE_MAX} characters`];
  }
  const fields = {
    result,
    account,
    segment: texts.segment,
    plan: texts.plan,
    annual_value,
    currency: currency as DealIn["currency"],
    decided_on,
    reason,
    reason_note: note,
    price_quoted: texts.price_quoted,
  };
  const problem = ruleProblem({ ...fields, currency: fields.currency ?? null }, today);
  return problem ? [null, problem] : [fields, null];
}

/** CSV cells per line (quotes and doubled quotes), each data row with its first line number; the header is line 1. */
function parseCsv(text: string): { header: string[]; rows: [number, string[]][] } | string {
  const rows: [number, string[]][] = [];
  let header: string[] | null = null;
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRow = () => {
    cells.push(cell);
    cell = "";
    if (cells.some((c) => c.trim())) {
      if (!header) header = cells.map((c) => key(c).replace(/ /g, "_"));
      else rows.push([start, cells]);
    }
    cells = [];
  };
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      endRow();
      line++;
      start = line;
      if (rows.length > MAX_ROWS) return `The file has more than ${MAX_ROWS.toLocaleString("en-US")} rows`;
    } else cell += ch;
  }
  if (cell || cells.length) endRow();
  if (rows.length > MAX_ROWS) return `The file has more than ${MAX_ROWS.toLocaleString("en-US")} rows`;
  const missing = REQUIRED.filter((c) => !(header ?? []).includes(c));
  if (missing.length) return `The header row must name the columns ${COLUMNS.join(", ")}; missing: ${missing.join(", ")}`;
  return { header: header ?? [], rows };
}

/** A form's record: its fields checked as the API's DealOutcomeIn and rules. */
function checked(b: Partial<DealIn>, today: string): string | null {
  if (!b.result || !(b.result in RESULT_LABELS)) return "result: Input should be 'won', 'lost', 'no_decision' or 'churned'";
  if (!b.reason || !(b.reason in REASON_LABELS)) return "reason: Input should be one of the reasons";
  const account = (b.account ?? "").trim();
  if (!account || account.length > ACCOUNT_MAX) return `account: 1 to ${ACCOUNT_MAX} characters`;
  if (!b.decided_on || !DAY.test(b.decided_on)) return "decided_on must be YYYY-MM-DD";
  if (b.currency && !(CURRENCIES as readonly string[]).includes(b.currency)) return "currency must be USD, EUR or GBP";
  const value = b.annual_value == null || b.annual_value === "" ? null : Number(b.annual_value);
  if (value != null && (!Number.isFinite(value) || value < 0)) return "annual_value must be a number of 0 or more";
  return ruleProblem({ reason: b.reason, reason_note: b.reason_note?.trim() || null, annual_value: value, currency: b.currency ?? null, decided_on: b.decided_on }, today);
}

/** /v1/deal-outcomes…; null for other routes. Owners and approvers only (403 for a write, an empty read is never shown below). */
export async function routeDeals(ctx: PricingContext, db: PricingDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "deal-outcomes") return null;
  const m = req.method;
  if (!atLeast(ctx.me.role, "approver")) return fail(403, "Requires the approver role");
  const today = ctx.today();

  if (p.length === 2 && m === "GET") {
    const rows = db.deals
      .filter((d) => !q.get("result") || d.result === q.get("result"))
      .filter((d) => !q.get("reason") || d.reason === q.get("reason"))
      .filter((d) => !q.get("from") || d.decided_on >= q.get("from")!)
      .filter((d) => !q.get("to") || d.decided_on <= q.get("to")!)
      .sort((a, b) => b.decided_on.localeCompare(a.decided_on) || b.created_at.localeCompare(a.created_at));
    return json(200, rows);
  }
  if (p.length === 2 && m === "POST") {
    const b = JSON.parse((await req.text()) || "{}") as Partial<DealIn>;
    const problem = checked(b, today);
    if (problem) return fail(422, problem);
    const at = ctx.now();
    const value = b.annual_value == null || b.annual_value === "" ? null : Number(b.annual_value);
    const row: DealOut = {
      id: ctx.uuid(),
      result: b.result!,
      account: b.account!.trim(),
      segment: b.segment?.trim() || null,
      plan: b.plan?.trim() || null,
      annual_value: value,
      currency: b.currency ?? null,
      decided_on: b.decided_on!,
      reason: b.reason!,
      reason_note: b.reason_note?.trim() || null,
      competitor_id: null,
      price_quoted: b.price_quoted?.trim() || null,
      source_item_id: null,
      source_item: null,
      recorded_by: ctx.me.id,
      created_at: at,
      updated_at: at,
      lock_version: 1,
    };
    db.deals.push(row);
    return json(201, row);
  }
  if (p.length === 3 && p[2] === "import" && m === "POST") {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return fail(422, "The file is larger than 1 MB");
    const parsed = parseCsv(text);
    if (typeof parsed === "string") return fail(422, parsed);
    const dry = q.get("dry_run") === "true";
    const skipped: Schemas["ImportSkipped"][] = [];
    let created = 0;
    for (const [line, cells] of parsed.rows) {
      const values = Object.fromEntries(parsed.header.map((h, i) => [h, cells[i] ?? ""]));
      const [fields, problem] = rowOf(values, today);
      if (problem || !fields) {
        skipped.push({ line, message: problem! });
        continue;
      }
      created += 1;
      if (!dry) {
        const at = ctx.now();
        db.deals.push({
          id: ctx.uuid(),
          ...fields,
          segment: fields.segment ?? null,
          plan: fields.plan ?? null,
          annual_value: fields.annual_value == null ? null : Number(fields.annual_value),
          currency: fields.currency ?? null,
          reason_note: fields.reason_note ?? null,
          price_quoted: fields.price_quoted ?? null,
          competitor_id: null,
          source_item_id: null,
          source_item: null,
          recorded_by: ctx.me.id,
          created_at: at,
          updated_at: at,
          lock_version: 1,
        });
      }
    }
    return json(200, { dry_run: dry, created, skipped } satisfies Schemas["ImportOut"]);
  }
  const row = db.deals.find((d) => d.id === p[2]);
  if (!row || p.length !== 3) return fail(404, "No such win or loss record");
  if (m === "PATCH") {
    const b = JSON.parse((await req.text()) || "{}") as Schemas["DealOutcomePatch"];
    if (b.lock_version !== row.lock_version) return fail(409, "Someone else changed this since you loaded it; reload and try again");
    const next = { ...row, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => k !== "lock_version" && v !== undefined)) } as DealOut;
    const problem = checked(next as unknown as DealIn, today);
    if (problem) return fail(422, problem);
    next.annual_value = next.annual_value == null ? null : Number(next.annual_value);
    Object.assign(row, next, { lock_version: row.lock_version + 1, updated_at: ctx.now() });
    return json(200, row);
  }
  if (m === "DELETE") {
    db.deals.splice(db.deals.indexOf(row), 1);
    return new Response(null, { status: 204 });
  }
  return null;
}
