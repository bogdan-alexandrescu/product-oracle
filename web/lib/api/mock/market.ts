/**
 * Mock of H7 Competitive digest's API (/v1/competitors, /v1/competitor-pages,
 * /v1/competitor-changes, /v1/competitor-web-findings, /v1/positioning and
 * /v1/positioning-suggestions; api/oracle/market). Made-up data only: the "market" scenario
 * seeds Competitor A (direct), Competitor B (indirect) and Spreadsheets (the status quo), a
 * page change on Competitor A's pricing page, three not-vetted web findings on .example hosts
 * (one whose summary holds an HTML link and a Markdown link, to show they stay plain text),
 * and two positioning suggestions. Other scenarios start with no alternatives.
 *
 * A watched page is "read" at once: the mock has no fetcher, so the first read stores no
 * change; a page on /blocked is blocked by robots.txt (Check now answers 409).
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";

type CompetitorOut = Schemas["CompetitorOut"];
type PageOut = Schemas["PageOut"];
type ChangeOut = Schemas["ChangeOut"];
type ChangeDetail = Schemas["ChangeDetail"];
type WebFindingOut = Schemas["WebFindingOut"];
type PositioningOut = Schemas["PositioningOut"];
type Suggestion = Schemas["PositioningSuggestionOut"];
type FieldKey = keyof Schemas["PositioningFields"];
type Role = "viewer" | "commenter" | "approver" | "owner";

type Competitor = Omit<CompetitorOut, "pages" | "last_change_on" | "changes_this_month" | "open_web_findings" | "watch_problem">;
type Page = Omit<PageOut, "host">;
type Change = Omit<ChangeOut, "competitor_name" | "page_label" | "page_url" | "web_host"> & {
  page_id: string | null;
  diff: Schemas["DiffLine"][];
};
type Finding = Omit<WebFindingOut, "competitor_name" | "vetted" | "found_on"> & { created_at: string };
// A request or source item ref carries its title here: the market mock keeps no requests or
// sources of its own (the API reads the request's title, and a source item's for its owner).
type StoredSuggestion = Omit<Suggestion, "refs"> & {
  refs: { kind: Schemas["SuggestionRef"]["kind"]; id: string; title?: string }[];
  status: "open" | "accepted" | "dismissed";
};

export interface MarketDb {
  competitors: Competitor[];
  pages: Page[];
  changes: Change[];
  findings: Finding[];
  positioning: { fields: Record<FieldKey, { id: string; text: string }[]>; updated_by_name: string | null; updated_at: string | null; lock_version: number };
  suggestions: StoredSuggestion[];
}

export interface MarketContext {
  me: { id: string; email: string; name: string | null; role: Role };
  uuid: () => string;
  companyTimezone: () => string;
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, detail: string) => json(status, { detail });
const now = () => new Date();
const DAY_MS = 86_400_000;

export const FIELDS: FieldKey[] = ["alternatives", "unique_attributes", "value_and_proof", "best_fit_customers", "market_category", "trends"];
const PAGES_PER_COMPETITOR = 10;
const PAGES_PER_COMPANY = 60;
const MAX_ALIASES = 5;
const ITEM_CHARS = 300;
const BLOCKED = "The site asks bots not to read this page";
const NOT_READ = "Not read for 3 weeks";
const LABELS = ["pricing", "changelog", "product", "docs", "blog", "other"] as const;
const LABEL_TITLES: Record<string, string> = { pricing: "Pricing", changelog: "Changelog", product: "Product", docs: "Docs", blog: "Blog", other: "Other" };

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The calendar day (YYYY-MM-DD) of `iso` in `zone`. */
function dayIn(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function emptyMarket(): MarketDb {
  return {
    competitors: [],
    pages: [],
    changes: [],
    findings: [],
    positioning: { fields: Object.fromEntries(FIELDS.map((f) => [f, []])) as unknown as MarketDb["positioning"]["fields"], updated_by_name: null, updated_at: null, lock_version: 1 },
    suggestions: [],
  };
}

const id = (key: string) => stableUuid(`market:${key}`);

/** The "market" scenario's made-up alternatives, their change log, web findings and positioning. */
export function seedMarket(occurrenceId: string | null): MarketDb {
  const db = emptyMarket();
  const competitor = (key: string, name: string, kind: Competitor["kind"], website: string | null, aliases: string[], description: string): Competitor => ({
    id: id(key),
    name,
    kind,
    website,
    aliases,
    description,
    status: "active",
    lock_version: 1,
  });
  const a = competitor("a", "Competitor A", "direct", "https://competitor-a.example", ["CompA"], "A planning tool for product teams.");
  const b = competitor("b", "Competitor B", "indirect", "https://competitor-b.example", [], "A general project tracker teams use for roadmaps.");
  const s = competitor("s", "Spreadsheets", "status_quo", null, ["a spreadsheet"], "Roadmaps and request lists kept in shared spreadsheets.");
  db.competitors.push(a, b, s);
  const page = (key: string, c: Competitor, url: string, label: Page["label"], fields: Partial<Page> = {}): Page => ({
    id: id(`page:${key}`),
    competitor_id: c.id,
    url,
    label,
    status: "active",
    last_checked_at: "2026-10-19T16:00:00Z",
    last_changed_at: null,
    attempts: 0,
    last_error: null,
    ...fields,
  });
  const pricing = page("a-pricing", a, "https://competitor-a.example/pricing", "pricing", { last_changed_at: "2026-10-14T16:00:00Z" });
  db.pages.push(
    pricing,
    page("a-changelog", a, "https://competitor-a.example/changelog", "changelog"),
    page("b-docs", b, "https://competitor-b.example/blocked/docs", "docs", { status: "blocked", last_error: BLOCKED }),
  );
  db.changes.push({
    id: id("change:a-pricing"),
    competitor_id: a.id,
    origin: "page",
    page_id: pricing.id,
    detected_at: "2026-10-14T16:00:00Z",
    added_lines: 3,
    removed_lines: 2,
    rating: "notable",
    rated_by: "rule",
    summary: "A new team plan replaces the old per-seat plan.",
    web_finding_id: null,
    diff: [
      { op: "-", text: "Pro: $20 per seat a month" },
      { op: "-", text: "Start a trial at https://competitor-a.example/trial" },
      { op: "+", text: "Team: $400 a month for up to 25 people" },
      { op: "+", text: "Every plan includes roadmap sharing" },
      { op: "+", text: "Sign up at https://competitor-a.example/signup" },
    ],
  });
  const finding = (key: string, c: Competitor, fields: Omit<Finding, "id" | "competitor_id" | "status" | "occurrence_id" | "created_at" | "host">): Finding => ({
    id: id(`finding:${key}`),
    competitor_id: c.id,
    status: "open",
    occurrence_id: occurrenceId,
    created_at: "2026-10-22T17:00:00Z",
    host: hostOf(fields.url),
    ...fields,
  });
  const review = finding("review", a, {
    kind: "review",
    title: "Review: setup takes too long",
    summary: "A review site rates Competitor A's onboarding poorly.",
    excerpt: "It took our team two weeks to set up.",
    url: "https://reviews.example/competitor-a",
    published_on: "2026-10-18",
  });
  db.findings.push(
    review,
    finding("news", b, {
      kind: "pricing",
      title: "Competitor B raises its prices",
      summary: "A news site reports a 20% price rise for teams.",
      excerpt: "prices rise by 20% for every team plan",
      url: "https://news.example/competitor-b-prices",
      published_on: null,
    }),
    finding("free-plan", a, {
      kind: "launch",
      title: "Competitor A opens a free plan",
      summary: 'A blog says: <a href="https://evil.example">click</a> and read [the details](https://evil.example/plan).',
      excerpt: "a free plan for teams of three",
      url: "https://blog.example/competitor-a-free",
      published_on: "2026-10-20",
    }),
  );
  const item = (key: string, text: string) => ({ id: key, text });
  db.positioning.fields = {
    alternatives: [item("alt1", "Shared spreadsheets and a weekly meeting")],
    unique_attributes: [item("ua1", "Reads the company's own sources before it writes")],
    value_and_proof: [],
    best_fit_customers: [item("bf1", "Product teams of 5 to 50 people")],
    market_category: [item("mc1", "Product operations")],
    trends: [],
  };
  db.positioning.updated_at = "2026-10-01T16:00:00Z";
  db.suggestions.push(
    {
      id: id("suggestion:afternoon"),
      field: "unique_attributes",
      action: "add",
      item_id: null,
      text: "Set up in one afternoon",
      rationale: "Reviews say Competitor A takes two weeks to set up.",
      refs: [{ kind: "web", id: review.id }],
      occurrence_id: occurrenceId,
      status: "open",
    },
    {
      id: id("suggestion:trend"),
      field: "trends",
      action: "add",
      item_id: null,
      text: "Teams move roadmaps off spreadsheets",
      rationale: "Competitor A's new team plan targets teams leaving spreadsheets.",
      refs: [{ kind: "change", id: id("change:a-pricing") }],
      occurrence_id: occurrenceId,
      status: "open",
    },
    {
      id: id("suggestion:spreadsheets"),
      field: "alternatives",
      action: "remove",
      item_id: "alt1",
      text: null,
      rationale: "Competitor A's team plan and the requests name tools, not spreadsheets.",
      refs: [
        { kind: "change", id: id("change:a-pricing") },
        { kind: "request", id: id("request:import"), title: "Import our roadmap from a spreadsheet" },
      ],
      occurrence_id: occurrenceId,
      status: "open",
    },
  );
  return db;
}

// --- shapes -----------------------------------------------------------------------------------

function pageOut(p: Page): PageOut {
  return { ...p, host: hostOf(p.url) };
}

function changeOut(db: MarketDb, ch: Change): ChangeOut {
  const c = db.competitors.find((x) => x.id === ch.competitor_id)!;
  const page = ch.page_id ? db.pages.find((x) => x.id === ch.page_id) : undefined;
  const finding = ch.web_finding_id ? db.findings.find((x) => x.id === ch.web_finding_id) : undefined;
  const out: ChangeOut & { page_id?: string | null; diff?: unknown } = {
    ...ch,
    competitor_name: c.name,
    page_label: page?.label ?? null,
    page_url: page?.url ?? null,
    web_host: finding?.host ?? null,
  };
  delete out.page_id;
  delete out.diff;
  return out;
}

function findingOut(db: MarketDb, f: Finding, zone: string): WebFindingOut {
  const c = db.competitors.find((x) => x.id === f.competitor_id)!;
  const out: WebFindingOut & { created_at?: string } = { ...f, competitor_name: c.name, vetted: false, found_on: dayIn(f.created_at, zone) };
  delete out.created_at;
  return out;
}

function competitorOut(db: MarketDb, c: Competitor, zone: string): CompetitorOut {
  const pages = db.pages.filter((p) => p.competitor_id === c.id);
  const changes = db.changes.filter((x) => x.competitor_id === c.id).sort((x, y) => y.detected_at.localeCompare(x.detected_at));
  const month = dayIn(now().toISOString(), zone).slice(0, 7);
  return {
    ...c,
    pages: pages.length,
    last_change_on: changes[0] ? dayIn(changes[0].detected_at, zone) : null,
    changes_this_month: changes.filter((x) => dayIn(x.detected_at, zone).startsWith(month)).length,
    open_web_findings: db.findings.filter((f) => f.competitor_id === c.id && f.status === "open").length,
    watch_problem: pages.some((p) => p.status === "error" && p.attempts >= 3) ? NOT_READ : null,
  };
}

function positioningOut(db: MarketDb): PositioningOut {
  const refOut = (r: StoredSuggestion["refs"][number]): Schemas["SuggestionRef"] => {
    if (r.kind === "web") {
      const f = db.findings.find((x) => x.id === r.id);
      return { ...r, title: f?.title ?? null, vetted: false };
    }
    if (r.kind === "change") {
      const ch = db.changes.find((x) => x.id === r.id);
      return { ...r, title: ch?.summary ?? null, vetted: null };
    }
    return { kind: r.kind, id: r.id, title: r.title ?? null, vetted: null };
  };
  return {
    fields: db.positioning.fields,
    suggestions: db.suggestions
      .filter((s) => s.status === "open")
      .map((s) => {
        const out: Suggestion & { status?: string } = { ...s, refs: s.refs.map(refOut) };
        delete out.status;
        return out;
      }),
    updated_by_name: db.positioning.updated_by_name,
    updated_at: db.positioning.updated_at,
    lock_version: db.positioning.lock_version,
  };
}

/** The digest's pre-read blocks over this data (api/oracle/market/blocks.py), for the mock occurrence. */
export function digestBlocks(db: MarketDb, zone: string, asOf: string) {
  const day = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(new Date(iso));
  const changes = db.changes.map((ch) => {
    const c = db.competitors.find((x) => x.id === ch.competitor_id)!;
    const out = changeOut(db, ch);
    const origin = out.page_label ? LABEL_TITLES[out.page_label] : `From the web · ${out.web_host}`;
    const lines = ch.origin === "page" ? ` · +${ch.added_lines} −${ch.removed_lines}` : "";
    // As the API: a web change's summary (the finding's title) is a field marked untrusted, never pre-read text.
    const untrusted = ch.origin === "web";
    return {
      change_id: ch.id,
      href: `/company/market?alternative=${c.id}&change=${ch.id}`,
      summary: ch.summary,
      untrusted,
      text: `${c.name} · ${origin} · ${day(ch.detected_at)}${lines} · ${ch.rating}${ch.summary && !untrusted ? ` · ${ch.summary}` : ""}`,
    };
  });
  const web = db.findings
    .filter((f) => f.status === "open")
    .map((f) => {
      const c = db.competitors.find((x) => x.id === f.competitor_id)!;
      return {
        finding_id: f.id,
        competitor_id: c.id,
        href: `/company/market?tab=changes&view=web&alternative=${c.id}`,
        text: `${c.name}: ${f.title} (Not vetted · ${f.host} · ${f.published_on ? day(`${f.published_on}T12:00:00Z`) : `found ${day(f.created_at)}`})`,
      };
    });
  const problems = db.pages
    .filter((p) => p.status === "blocked" || p.status === "error")
    .map((p) => {
      const c = db.competitors.find((x) => x.id === p.competitor_id)!;
      return { href: `/company/market?alternative=${c.id}`, text: `${c.name} · ${LABEL_TITLES[p.label]} · ${hostOf(p.url)}: ${p.last_error ?? "not read"}` };
    });
  const block = (key: string, title: string, rows: { text: string; href?: string }[]) => ({ key, title, as_of: asOf, rows });
  return [
    block("competitor_changes", "Changes", changes),
    block("competitor_web", "From the web", web),
    block("competitor_mentions", "What people in the company said", [
      { text: "Share a roadmap with customers · names Competitor A · Asked for because an alternative has it?", href: "/requests" },
    ]),
    block("watch_problems", "Watch problems", problems),
  ];
}

// --- routes -----------------------------------------------------------------------------------

/** Handles the market routes; null for any other path. */
export async function routeMarket(ctx: MarketContext, db: MarketDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const area = p[1];
  if (!["competitors", "competitor-pages", "competitor-changes", "competitor-web-findings", "positioning", "positioning-suggestions"].includes(area)) return null;
  const m = req.method;
  const zone = ctx.companyTimezone();
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const approver = atLeast(ctx.me.role, "approver");
  const notApprover = () => fail(403, "Requires the approver role");

  if (area === "competitors") {
    if (p.length === 2 && m === "GET") {
      const all = q.get("include_archived") === "true";
      return json(
        200,
        db.competitors
          .filter((c) => all || c.status === "active")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => competitorOut(db, c, zone)),
      );
    }
    if (p.length === 2 && m === "POST") {
      if (!approver) return notApprover();
      const input = await body<Schemas["CompetitorCreate"]>();
      const name = (input.name ?? "").trim();
      if (!name) return fail(422, "name: required");
      if (db.competitors.some((c) => c.status === "active" && c.name.toLowerCase() === name.toLowerCase())) return fail(422, "name: another active alternative has this name");
      const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
      if (aliases.length > MAX_ALIASES) return fail(422, `aliases: at most ${MAX_ALIASES} aliases`);
      const c: Competitor = {
        id: ctx.uuid(),
        name,
        kind: input.kind,
        website: input.website?.trim() || null,
        aliases,
        description: input.description?.trim() || null,
        status: "active",
        lock_version: 1,
      };
      db.competitors.push(c);
      return json(201, competitorOut(db, c, zone));
    }
    const c = db.competitors.find((x) => x.id === p[2]);
    if (!c) return fail(404, "No such alternative");
    if (p.length === 3 && m === "GET") {
      const changes = db.changes
        .filter((x) => x.competitor_id === c.id)
        .sort((a, b) => b.detected_at.localeCompare(a.detected_at))
        .slice(0, 20)
        .map((x) => changeOut(db, x));
      return json(200, {
        ...competitorOut(db, c, zone),
        page_list: db.pages.filter((x) => x.competitor_id === c.id).map(pageOut),
        changes,
        web_findings: db.findings.filter((f) => f.competitor_id === c.id && f.status === "open").map((f) => findingOut(db, f, zone)),
      } satisfies Schemas["CompetitorDetail"]);
    }
    if (p.length === 4 && m === "POST" && p[3] === "pages") {
      if (!approver) return notApprover();
      const input = await body<Schemas["PageIn"]>();
      const url = (input.url ?? "").trim();
      if (!/^https:\/\/[^\s/]+/i.test(url)) return fail(422, "url: only https:// pages can be watched");
      if (!LABELS.includes(input.label)) return fail(422, "label: pricing, changelog, product, docs, blog or other");
      if (c.status !== "active") return fail(409, "The alternative is archived; restore it first");
      if (db.pages.filter((x) => x.competitor_id === c.id).length >= PAGES_PER_COMPETITOR) return fail(422, `url: at most ${PAGES_PER_COMPETITOR} pages per alternative`);
      if (db.pages.length >= PAGES_PER_COMPANY) return fail(422, `url: at most ${PAGES_PER_COMPANY} watched pages in all`);
      if (db.pages.some((x) => x.competitor_id === c.id && x.url === url)) return fail(422, "url: this page is already watched for this alternative");
      const blocked = new URL(url).pathname.startsWith("/blocked");
      const page: Page = {
        id: ctx.uuid(),
        competitor_id: c.id,
        url,
        label: input.label,
        status: blocked ? "blocked" : "active",
        last_checked_at: now().toISOString(),
        last_changed_at: null,
        attempts: 0,
        last_error: blocked ? BLOCKED : null,
      };
      db.pages.push(page);
      return json(201, pageOut(page));
    }
    if (p.length === 4 && m === "POST" && (p[3] === "archive" || p[3] === "restore")) {
      if (!approver) return notApprover();
      c.status = p[3] === "archive" ? "archived" : "active";
      if (c.status === "archived") for (const x of db.pages) if (x.competitor_id === c.id && x.status === "active") x.status = "paused";
      c.lock_version += 1;
      return json(200, competitorOut(db, c, zone));
    }
    return fail(404, "Route not found");
  }

  if (area === "competitor-pages") {
    const page = db.pages.find((x) => x.id === p[2]);
    if (!page) return fail(404, "No such watched page");
    if (!approver) return notApprover();
    if (p.length === 3 && m === "PATCH") {
      const input = await body<Schemas["PagePatch"]>();
      if (input.label) page.label = input.label;
      if (input.status) page.status = input.status;
      return json(200, pageOut(page));
    }
    if (p.length === 3 && m === "DELETE") {
      db.pages = db.pages.filter((x) => x !== page);
      db.changes = db.changes.filter((x) => x.page_id !== page.id);
      return new Response(null, { status: 204 });
    }
    if (p.length === 4 && m === "POST" && p[3] === "check") {
      if (new URL(page.url).pathname.startsWith("/blocked")) {
        Object.assign(page, { status: "blocked", last_error: BLOCKED, last_checked_at: now().toISOString() });
        return fail(409, BLOCKED);
      }
      Object.assign(page, { last_checked_at: now().toISOString(), attempts: 0, last_error: null });
      return json(200, pageOut(page));
    }
    return fail(404, "Route not found");
  }

  if (area === "competitor-changes") {
    if (p.length === 2 && m === "GET") {
      const from = q.get("from");
      const to = q.get("to");
      const rows = db.changes
        .filter((x) => !q.get("competitor_id") || x.competitor_id === q.get("competitor_id"))
        .filter((x) => !q.get("rating") || x.rating === q.get("rating"))
        .filter((x) => !q.get("origin") || x.origin === q.get("origin"))
        .filter((x) => !from || x.detected_at >= `${from}T00:00:00Z`)
        .filter((x) => !to || x.detected_at < `${to}T00:00:00Z`)
        .sort((a, b) => b.detected_at.localeCompare(a.detected_at));
      return json(200, rows.map((x) => changeOut(db, x)));
    }
    const ch = db.changes.find((x) => x.id === p[2]);
    if (!ch) return fail(404, "No such change");
    if (p.length === 3 && m === "GET") {
      const f = ch.web_finding_id ? db.findings.find((x) => x.id === ch.web_finding_id) : undefined;
      return json(200, { ...changeOut(db, ch), diff: ch.diff, web_finding: f ? findingOut(db, f, zone) : null } satisfies ChangeDetail);
    }
    return fail(404, "Route not found");
  }

  if (area === "competitor-web-findings") {
    if (p.length === 2 && m === "GET") {
      const status = q.get("status") ?? "open";
      const older = q.get("include_older") === "true";
      const cutoff = now().getTime() - 90 * DAY_MS;
      return json(
        200,
        db.findings
          .filter((f) => f.status === status)
          .filter((f) => !q.get("competitor_id") || f.competitor_id === q.get("competitor_id"))
          .filter((f) => !q.get("occurrence_id") || f.occurrence_id === q.get("occurrence_id"))
          .filter((f) => older || status !== "open" || Date.parse(f.created_at) >= cutoff)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((f) => findingOut(db, f, zone)),
      );
    }
    const f = db.findings.find((x) => x.id === p[2]);
    if (!f) return fail(404, "No such web finding");
    if (p.length === 4 && m === "POST" && (p[3] === "promote" || p[3] === "dismiss")) {
      if (!approver) return notApprover();
      if (f.status !== "open") return fail(409, `This finding was already ${f.status}`);
      if (p[3] === "dismiss") {
        const input = await body<Schemas["FindingDismissIn"]>();
        Object.assign(f, { status: "dismissed", dismiss_reason: input?.reason?.trim() || null });
        return json(200, findingOut(db, f, zone));
      }
      const input = await body<Schemas["PromoteIn"]>();
      f.status = "promoted";
      const ch: Change = {
        id: ctx.uuid(),
        competitor_id: f.competitor_id,
        origin: "web",
        page_id: null,
        detected_at: now().toISOString(),
        added_lines: 0,
        removed_lines: 0,
        rating: input?.rating ?? "notable",
        rated_by: "person",
        summary: f.title,
        web_finding_id: f.id,
        diff: [],
      };
      db.changes.push(ch);
      return json(200, changeOut(db, ch));
    }
    return fail(404, "Route not found");
  }

  if (area === "positioning" && p.length === 2) {
    if (m === "GET") return json(200, positioningOut(db));
    if (m === "PUT") {
      if (!approver) return notApprover();
      const input = await body<Schemas["PositioningIn"]>();
      if (input.lock_version !== db.positioning.lock_version) return fail(409, "Someone else changed the positioning; reload");
      const fields = {} as MarketDb["positioning"]["fields"];
      for (const f of FIELDS) {
        const items = (input.fields[f] ?? []).map((i) => ({ id: i.id ?? ctx.uuid().slice(0, 12), text: i.text.trim() }));
        const limit = f === "market_category" ? 1 : 10;
        if (items.length > limit) return fail(422, `fields.${f}: at most ${limit} item${limit > 1 ? "s" : ""}`);
        if (items.some((i) => !i.text)) return fail(422, `fields.${f}: an item has no text`);
        if (items.some((i) => i.text.length > ITEM_CHARS)) return fail(422, `fields.${f}: an item is over ${ITEM_CHARS} characters`);
        fields[f] = items;
      }
      Object.assign(db.positioning, { fields, updated_by_name: ctx.me.name ?? ctx.me.email, updated_at: now().toISOString(), lock_version: db.positioning.lock_version + 1 });
      return json(200, positioningOut(db));
    }
  }

  if (area === "positioning-suggestions" && p.length === 4 && m === "POST" && (p[3] === "accept" || p[3] === "dismiss")) {
    const s = db.suggestions.find((x) => x.id === p[2]);
    if (!s) return fail(404, "No such suggestion");
    if (!approver) return notApprover();
    if (s.status !== "open") return fail(409, `This suggestion was already ${s.status}`);
    if (p[3] === "accept") {
      const items = db.positioning.fields[s.field];
      if (s.action === "add") {
        if (s.field === "market_category") items.length = 0;
        items.push({ id: ctx.uuid().slice(0, 12), text: s.text ?? "" });
      } else if (s.action === "replace") {
        const hit = items.find((i) => i.id === s.item_id);
        if (!hit) return fail(409, "The item this suggestion replaces is gone");
        hit.text = s.text ?? "";
      } else {
        if (!items.some((i) => i.id === s.item_id)) return fail(409, "The item this suggestion removes is gone");
        db.positioning.fields[s.field] = items.filter((i) => i.id !== s.item_id);
      }
      Object.assign(db.positioning, { updated_by_name: ctx.me.name ?? ctx.me.email, updated_at: now().toISOString(), lock_version: db.positioning.lock_version + 1 });
    }
    s.status = p[3] === "accept" ? "accepted" : "dismissed";
    return json(200, positioningOut(db));
  }
  return fail(404, "Route not found");
}
