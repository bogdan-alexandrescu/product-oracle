/**
 * O5 in the mock (as api/oracle/shares and api/oracle/roadmap/public_router.py): a
 * roadmap's share links with their passcodes (owner answer O5-Q5), the view log, the
 * Public version's texts and leak findings, the public check, and a link holder's routes
 * (/v1/public/shares/{token}). The "sharing" scenario seeds a published roadmap with five
 * items (internal titles are marker strings), one Team link with two views, and two links
 * revoked when their creator left (the owners' Inbox row).
 *
 * The mock keeps the raw token and passcode on the row (the API keeps only hashes) and
 * stands in for the link's cookie with `opened` (token -> passcode version, browser id).
 */
import type { Schemas } from "@/lib/api/client";

import type { SectionSeed } from "./fixtures";

type Role = "viewer" | "commenter" | "approver" | "owner";
type Audience = Schemas["ShareLinkOut"]["audience"];
type Stage = Schemas["PublicTextOut"]["stage"];
type Finding = Schemas["LeakFindingOut"];

export const SHARING_SCENARIO = "sharing";
/** The "sharing" roadmap with Public as its default audience and no public texts yet. */
export const SHARING_PUBLIC_SCENARIO = "sharing-public";
export const SHARING_ROADMAP_SLUG = "example-labs-roadmap";
export const SHARING_ROADMAP_TITLE = "Platform roadmap, autumn";
/** Win/loss account labels and request askers' company labels the leak check knows. */
export const CUSTOMER_LABELS = ["Northwind", "Account 14"];

export const SHARING_SECTIONS: SectionSeed[] = [
  { key: "title", level: 1, heading: SHARING_ROADMAP_TITLE, body: "Three bets for the autumn from the platform team." },
  { key: "summary", level: 2, heading: "Summary", body: "Two items now, two next, one later." },
  { key: "goals", level: 2, heading: "Goals", body: "- G1 Cut monthly churn to 2%\n- G2 Grow self-serve sign-ups" },
  {
    key: "brief-items",
    level: 2,
    heading: "Items by horizon",
    body: "| Horizon | Item |\n|---|---|\n| Now | Falcon alerts rework |\n| Now | Northwind bulk import |\n| Next | Billing ledger v2 |\n| Next | Partner API beta |\n| Later | Ops console cleanup |",
  },
  { key: "full", level: 1, heading: "Full version", body: "" },
  { key: "now", level: 2, heading: "Now", body: "In build this cycle." },
  { key: "item-falcon", level: 3, heading: "Falcon alerts rework", body: "Owner: Admin. Serves G1. ENG-512 tracks it. Beta by 2026-11-30." },
  { key: "item-import", level: 3, heading: "Northwind bulk import", body: "Owner: Approver. Serves G2. Asked for by Northwind." },
  { key: "next", level: 2, heading: "Next", body: "Shaped, not started." },
  { key: "item-ledger", level: 3, heading: "Billing ledger v2", body: "Owner: Admin. Serves G1. Depends on Falcon alerts rework." },
  { key: "item-partner", level: 3, heading: "Partner API beta", body: "Owner: Approver. Serves G2." },
  { key: "later", level: 2, heading: "Later", body: "Ideas we keep." },
  { key: "item-ops", level: 3, heading: "Ops console cleanup", body: "Owner: Admin. This item serves no confirmed goal." },
  {
    key: "dependencies",
    level: 2,
    heading: "Dependencies and owners",
    body: "| Item | Owner | Depends on |\n|---|---|---|\n| Billing ledger v2 | Admin | Falcon alerts rework |\n| Partner API beta | Approver | ENG-530 |",
  },
  { key: "sources", level: 2, heading: "Sources and data points", body: "- Platform PRDs, October" },
];

const DISCLAIMER = "This roadmap shows our current plans. It is not a commitment, and plans and timing can change.";
const ORACLE_MARK = "Made with Product Oracle";
const ENDED = "This link has ended. Ask the person who sent it for a new one.";
const UPDATING = "This page is being updated";
const VIEW_NOTE = "Counts browsers, not people. Oracle never records who opened a link.";
const RUN_REFUSED = "Sharing outside the company is a person's act";
const COLUMNS: [Stage, string][] = [
  ["shipped", "Shipped recently"],
  ["in_progress", "In progress"],
  ["planned", "Planned"],
  ["exploring", "Exploring"],
];
const EXPIRY: Record<string, number> = { "24h": 1, "7d": 7, "14d": 14, "30d": 30, "90d": 90 };
const NO_GOAL = "serves no confirmed goal";
const PASSCODE_TRIES = 5;
const LOCK_MS = 15 * 60_000;
const INBOX_REASONS = ["creator removed", "creator's role changed", "document moved to Trash", "document limited to owners and approvers"];
const ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ORDER.indexOf(role) >= ORDER.indexOf(min);

type LinkRow = {
  id: string;
  document_id: string;
  publication_id: string;
  audience: Audience;
  label: string;
  /** Mock only: the API keeps sha256(token) and an argon2 hash of the passcode. */
  token: string;
  passcode: string;
  passcode_version: number;
  failures: number;
  locked_until: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  allow_download: boolean;
  views: number;
  last_viewed_at: string | null;
  inbox_dismissed_at: string | null;
};
type ViewRow = { link_id: string; viewed_at: string; kind: "page" | "download"; browser_key: string; browser_family: string | null; country: string | null };
type TextRow = Omit<Schemas["PublicTextOut"], "findings"> & { document_id: string; source_hash: string };
type CheckRow = { id: string; document_id: string; version_id: string; publication_id: string; checked_by: string; checked_at: string; shown_item_keys: string[]; content_hash: string };

export interface SharesDb {
  links: LinkRow[];
  views: ViewRow[];
  texts: TextRow[];
  checks: CheckRow[];
  pages: Record<string, { public_title: string | null; public_intro: string | null }>;
  /** The link holder's cookie, per token: the passcode version it opened and its browser id. */
  opened: Record<string, { v: number; b: string }>;
}

type Section = { section_key: string; level: number; heading: string; body_md: string; body_text: string };
type DocLike = { id: string; slug: string; title: string; kind?: string | null; visibility?: string | null };
type VersionLike = { id: string; document_id: string; number: number; sections: Section[] };
type PubLike = { id: string; document_id: string; number: number; version_id: string; version_number: number };
type MemberLike = { id: string; email: string; name?: string | null; role: Role; status?: string };

export interface SharesContext {
  db: SharesDb;
  documents: DocLike[];
  versions: VersionLike[];
  publications: PubLike[];
  members: MemberLike[];
  me: { id: string; role: Role; run?: boolean } | null;
  company: string;
  uuid: () => string;
  now: () => string;
  /** The export's HTML of `v` rendered for `audience` (./audience.ts), as the export route. */
  renderAudience: (doc: DocLike, v: VersionLike, audience: Audience) => string;
  /** Whether Oracle only observes "Words for people outside" (H11 external_messages). */
  observesOutside?: () => boolean;
  /** Queues the public_text job for `v` (./llm-jobs.ts queueJob): the job, or why it was refused. */
  queueDraft?: (doc: DocLike, v: VersionLike) => Schemas["LlmJobOut"] | string;
}

export const emptyShares = (): SharesDb => ({ links: [], views: [], texts: [], checks: [], pages: {}, opened: {} });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const html = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const randomToken = (n: number) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function passcode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}
const sourceHash = (title: string) => `src:${title}`;
const displayName = (m: MemberLike | undefined) => (m ? m.name || m.email.split("@")[0] : null);

function state(link: LinkRow, at: string): "active" | "expired" | "revoked" {
  if (link.revoked_at) return "revoked";
  return link.expires_at <= at ? "expired" : "active";
}

/** The version's roadmap items: each level-3 section under Now, Next or Later. */
function items(v: VersionLike) {
  let horizon: string | null = null;
  const out: { key: string; title: string; horizon: string; serves: boolean; body: string }[] = [];
  for (const s of v.sections) {
    if (s.level <= 2) horizon = ["now", "next", "later"].includes(s.section_key) ? s.section_key : null;
    if (s.level === 3 && horizon) out.push({ key: s.section_key, title: s.heading, horizon, serves: !s.body_md.toLowerCase().includes(NO_GOAL), body: s.body_md });
  }
  return out;
}

/** The leak check (api/oracle/roadmap/leak_check.py), on the words the mock knows. */
function findings(ctx: SharesContext, text: string, internalTitle: string | null, checked: string[] = []): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, severity: Finding["severity"], words: string[]) => words.length && out.push({ code, severity, words: [...new Set(words)] });
  const lower = text.toLowerCase();
  add("person_name", "blocking", ctx.members.flatMap((m) => [m.email, ...(m.name && m.name.includes(" ") ? [m.name] : [])]).filter((w) => lower.includes(w.toLowerCase())));
  add("email_or_phone", "blocking", text.match(/[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d ()-]{7,}\d/g) ?? []);
  add("customer_name", "blocking", CUSTOMER_LABELS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text)));
  add("internal_code", "blocking", text.match(/\b[A-Z]{2,10}-\d+\b|\bG\d+\b|\bD-\d+\b/g) ?? []);
  add("money_or_metric", "warning", text.match(/[$€£]\s?\d[\d,.]*|\d+(\.\d+)?\s?%/g) ?? []);
  if (internalTitle && text.split("\n")[0].trim().toLowerCase() === internalTitle.toLowerCase()) add("internal_title_copy", "warning", [internalTitle]);
  void checked;
  return out;
}

function textOut(ctx: SharesContext, t: TextRow, internal: string): Schemas["PublicTextOut"] {
  const { document_id: _d, source_hash: _s, ...rest } = t;
  void _d;
  void _s;
  return { ...rest, findings: findings(ctx, `${t.title}\n${t.description}\n${t.changelog_url ?? ""}`, internal) };
}

type Review = {
  rows: Schemas["PublicRowOut"][];
  cards: Record<Stage, { title: string; description: string; quarter: string | null; url: string | null }[]>;
  company: string;
  title: string;
  intro: string | null;
  pageFindings: Finding[];
  removed: Record<string, number>;
};

function review(ctx: SharesContext, doc: DocLike, v: VersionLike): Review {
  const texts = new Map(ctx.db.texts.filter((t) => t.document_id === doc.id).map((t) => [t.item_key, t]));
  const cards: Review["cards"] = { shipped: [], in_progress: [], planned: [], exploring: [] };
  const rows = items(v).map((item): Schemas["PublicRowOut"] => {
    const t = texts.get(item.key);
    const state = !t ? "missing" : t.state === "excluded" ? "excluded" : t.source_hash !== sourceHash(item.title) ? "changed" : t.state;
    const text = t ? textOut(ctx, t, item.title) : null;
    const found = text?.findings ?? [];
    const shown = item.serves && state === "approved" && !found.some((f) => f.severity === "blocking");
    const reason = !item.serves ? "no_goal" : state === "excluded" ? "excluded" : shown ? null : "no_approved_text";
    if (shown && t) {
      const quarter = t.announced_quarter ? `${t.announced_quarter.slice(5)} ${t.announced_quarter.slice(0, 4)}` : null;
      cards[t.stage].push({ title: t.title, description: t.description, quarter, url: t.changelog_url ?? null });
    }
    return { item_key: item.key, internal_title: item.title, horizon: item.horizon, state, text, findings: found, shown, left_out_reason: reason };
  });
  const page = ctx.db.pages[doc.id] ?? { public_title: null, public_intro: null };
  const body = v.sections.map((s) => s.body_md).join("\n");
  const goals = v.sections.find((s) => s.section_key === "goals")?.body_md ?? "";
  return {
    rows,
    cards,
    company: ctx.company,
    title: page.public_title || `${ctx.company} roadmap`,
    intro: page.public_intro,
    pageFindings: findings(ctx, `${page.public_title ?? ""}\n${page.public_intro ?? ""}`, null),
    removed: {
      internal_titles: rows.length,
      owners: body.split("Owner:").length - 1,
      goals: goals.split("\n").filter((l) => /^\s*[-*]/.test(l)).length,
      dates_not_announced: (body.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length,
      tracker_links: (body.match(/\b[A-Z]{2,10}-\d+\b/g) ?? []).length,
      dependencies: body.split("Depends on").length - 1,
      economics: 0,
      prose_sections: v.sections.filter((s) => s.level <= 2 && !["now", "next", "later"].includes(s.section_key)).length,
    },
  };
}

function contentHash(r: Review): string {
  return JSON.stringify([r.title, r.intro, COLUMNS.map(([s]) => r.cards[s])]);
}

function notReady(r: Review) {
  const left: { item_key: string | null; reason: string }[] = [];
  for (const row of r.rows) {
    if (row.shown || row.left_out_reason === "excluded" || row.left_out_reason === "no_goal") continue;
    left.push({ item_key: row.item_key, reason: row.state === "approved" ? "findings" : row.state });
  }
  if (r.pageFindings.some((f) => f.severity === "blocking")) left.push({ item_key: null, reason: "page_findings" });
  if (!left.length && !r.rows.some((x) => x.shown)) left.push({ item_key: null, reason: "nothing_shown" });
  return left;
}

/** The Public page (export/templates/public_roadmap.html.j2): allowlisted fields only. */
function renderPublic(r: Review, footer: string): string {
  const columns = COLUMNS.map(([stage, label]) => {
    const cards = r.cards[stage]
      .map(
        (c) =>
          `<article class="card"><h3>${esc(c.title)}</h3>${c.description ? `<p>${esc(c.description)}</p>` : ""}${c.quarter ? `<p class="quarter">Announced for ${esc(c.quarter)}</p>` : ""}${c.url ? `<p><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer nofollow">Read the changelog</a></p>` : ""}</article>`,
      )
      .join("");
    return `<section class="column"><h2>${label}</h2>${cards || '<p class="empty">Nothing here yet.</p>'}</section>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>body{font-family:system-ui,sans-serif;margin:0;color:#0f172a}header,main,footer{max-width:72rem;margin:0 auto;padding:1rem 1.5rem}.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:1rem}.card{border:1px solid #e2e8f0;border-radius:.5rem;padding:.75rem;margin-bottom:.75rem}.card h3{margin:0 0 .25rem;font-size:.95rem}.disclaimer,footer{font-size:.8rem;color:#475569}</style></head><body><header><p class="company">${esc(r.company)}</p><h1>${esc(r.title)}</h1><span class="badge">Public</span>${r.intro ? `<p class="intro">${esc(r.intro)}</p>` : ""}</header><main><div class="columns">${columns}</div><p class="disclaimer">${esc(DISCLAIMER)}</p></main><footer><p>${esc(footer)}</p><p>${ORACLE_MARK}</p></footer></body></html>`;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const HORIZON_STAGE: Record<string, Stage> = { now: "in_progress", next: "planned", later: "exploring" };

/**
 * The public_text job (api/oracle/roadmap/public.py run_job): a draft for each goal-serving
 * item with no text, never with a quarter. The mock's "model" offers the item's own title,
 * which the leak check then flags for the person who approves it.
 */
export function draftPublicTexts(ctx: Omit<SharesContext, "me" | "renderAudience">, documentId: string, number: number): Record<string, unknown> {
  const v = ctx.versions.find((x) => x.document_id === documentId && x.number === number);
  if (!v) return { drafted: 0, item_keys: [] };
  const have = new Set(ctx.db.texts.filter((t) => t.document_id === documentId).map((t) => t.item_key));
  const drafted: string[] = [];
  for (const item of items(v)) {
    if (!item.serves || have.has(item.key)) continue;
    ctx.db.texts.push({
      document_id: documentId, item_key: item.key, title: item.title.slice(0, 80), description: "", stage: HORIZON_STAGE[item.horizon] ?? "exploring",
      announced_quarter: null, changelog_url: null, state: "draft", drafted_by: "oracle", approved_by: null, approved_at: null, checked_warnings: [],
      updated_at: ctx.now(), source_hash: sourceHash(item.title),
    });
    drafted.push(item.key);
  }
  return { drafted: drafted.length, item_keys: drafted };
}

// --------------------------------------------------------------------------- seeds

/** The "sharing" scenario: the Team link with two views, and two links revoked when their creator left. */
export function seedShares(ctx: Omit<SharesContext, "db" | "me" | "renderAudience">, ownerId: string, removedId: string | null, texts = true): SharesDb {
  const db = emptyShares();
  const doc = ctx.documents.find((d) => d.slug === SHARING_ROADMAP_SLUG);
  const pub = doc && ctx.publications.find((p) => p.document_id === doc.id);
  if (!doc || !pub) return db;
  const at = Date.parse(ctx.now());
  const iso = (days: number) => new Date(at + days * 86_400_000).toISOString();
  const link = (over: Partial<LinkRow>): LinkRow => ({
    id: ctx.uuid(), document_id: doc.id, publication_id: pub.id, audience: "team", label: "", token: randomToken(32), passcode: passcode(),
    passcode_version: 1, failures: 0, locked_until: null, created_by: ownerId, created_at: iso(-3), expires_at: iso(11), revoked_at: null,
    revoked_reason: null, allow_download: true, views: 0, last_viewed_at: null, inbox_dismissed_at: null, ...over,
  });
  const team = link({ label: "Team, all-hands", views: 2, last_viewed_at: iso(-1) });
  db.links.push(team);
  db.views.push(
    { link_id: team.id, viewed_at: iso(-2), kind: "page", browser_key: "b1", browser_family: "Chrome", country: null },
    { link_id: team.id, viewed_at: iso(-1), kind: "page", browser_key: "b1", browser_family: "Chrome", country: null },
  );
  if (removedId) {
    for (const [audience, label] of [["board", "Board, September meeting"], ["engineering", "Platform guild"]] as const) {
      db.links.push(link({ audience, label, created_by: removedId, created_at: iso(-10), revoked_at: iso(-4), revoked_reason: "creator removed" }));
    }
  }
  if (!texts) return db;
  const v = ctx.versions.find((x) => x.id === pub.version_id)!;
  const titleOf = (key: string) => items(v).find((i) => i.key === key)!.title;
  const text = (item_key: string, over: Partial<TextRow>): TextRow => ({
    document_id: doc.id, item_key, title: "", description: "", stage: "planned", announced_quarter: null, changelog_url: null, state: "draft",
    drafted_by: "oracle", approved_by: null, approved_at: null, checked_warnings: [], updated_at: iso(-2), source_hash: sourceHash(titleOf(item_key)), ...over,
  });
  db.texts.push(
    text("item-falcon", { title: "Usage alerts", description: "Get a notice before you reach a plan limit.", stage: "in_progress", state: "approved", approved_by: ownerId, approved_at: iso(-2) }),
    text("item-ledger", { title: "Clearer invoices", description: "Invoices that show each charge on its own line.", stage: "planned", state: "approved", approved_by: ownerId, approved_at: iso(-2) }),
    text("item-import", { title: "Bulk import", description: "Bring in many records at once.", stage: "exploring" }),
    text("item-partner", { title: "Partner access", description: "", stage: "exploring", state: "excluded", drafted_by: ownerId }),
  );
  return db;
}

// --------------------------------------------------------------------------- outputs

function linkOut(ctx: SharesContext, link: LinkRow): Schemas["ShareLinkOut"] {
  const pub = ctx.publications.find((p) => p.id === link.publication_id);
  const doc = ctx.documents.find((d) => d.id === link.document_id);
  const newest = ctx.publications.filter((p) => p.document_id === link.document_id).sort((a, b) => b.number - a.number)[0];
  const newer = newest && pub && newest.number > pub.number ? newest : null;
  const at = ctx.now();
  return {
    id: link.id,
    document: doc?.slug ?? "",
    publication_id: link.publication_id,
    publication_number: pub?.number ?? 0,
    version_number: pub?.version_number ?? 0,
    newer_publication: newer?.number ?? null,
    newer_version: newer?.version_number ?? null,
    audience: link.audience,
    label: link.label,
    created_by: link.created_by,
    created_by_name: displayName(ctx.members.find((m) => m.id === link.created_by)),
    created_at: link.created_at,
    expires_at: link.expires_at,
    state: state(link, at),
    revoked_at: link.revoked_at,
    revoked_reason: link.revoked_reason,
    allow_download: link.allow_download,
    views: link.views,
    distinct_browsers: new Set(ctx.db.views.filter((v) => v.link_id === link.id).map((v) => v.browser_key)).size,
    last_viewed_at: link.last_viewed_at,
    locked_until: link.locked_until && link.locked_until > at ? link.locked_until : null,
  };
}

/** Owners' Inbox (O5-Q10), grouped by creator (or document) and reason, as shares.service.inbox_rows. */
export function shareInboxRows(ctx: SharesContext): Schemas["InboxShareRevocation"][] {
  if (ctx.me?.role !== "owner") return [];
  const rows = ctx.db.links
    .filter((l) => l.revoked_at && !l.inbox_dismissed_at && l.revoked_reason && INBOX_REASONS.includes(l.revoked_reason))
    .sort((a, b) => b.revoked_at!.localeCompare(a.revoked_at!));
  const groups = new Map<string, Schemas["InboxShareRevocation"]>();
  for (const l of rows) {
    const doc = ctx.documents.find((d) => d.id === l.document_id);
    const byCreator = l.revoked_reason === "creator removed" || l.revoked_reason === "creator's role changed";
    const key = `${l.revoked_reason}|${byCreator ? l.created_by : l.document_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        title: "",
        reason: l.revoked_reason!,
        creator_id: byCreator ? l.created_by : null,
        creator_name: byCreator ? displayName(ctx.members.find((m) => m.id === l.created_by)) : null,
        document_title: byCreator ? null : (doc?.title ?? null),
        revoked_at: l.revoked_at!,
        links: [],
      };
      groups.set(key, g);
    }
    g.links.push({ id: l.id, label: l.label, document: doc?.slug ?? "", document_title: doc?.title ?? "", audience: l.audience, publication_id: l.publication_id });
  }
  return [...groups.values()].map((g) => {
    const n = g.links.length;
    const who = g.creator_name ?? "A member";
    const what =
      g.reason === "creator removed" ? `${who} left` : g.reason === "creator's role changed" ? `${who}'s role changed` : g.reason === "document moved to Trash" ? `${g.document_title} moved to Trash` : `${g.document_title} limited to owners and approvers`;
    return { ...g, title: `Links revoked: ${what} · ${n} link${n === 1 ? "" : "s"}` };
  });
}

// --------------------------------------------------------------------------- member routes

/**
 * /v1/documents/{doc}/share-links[...], /v1/share-links/..., /v1/roadmaps/{doc}/public-*
 * and the publication's public-check, with the API's roles and refusals.
 */
export async function routeShares(ctx: SharesContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const me = ctx.me;
  if (!me) return null;
  const body = async <T>() => JSON.parse((await req.text()) || "{}") as T;
  const person = (min: Role, refused = RUN_REFUSED) => {
    if (me.run) return json(403, { detail: refused });
    if (!atLeast(me.role, min)) return json(403, { detail: `Requires the ${min} role` });
    return null;
  };
  const roadmap = (slug: string) => ctx.documents.find((d) => d.slug === slug || d.id === slug);
  const versionsOf = (doc: DocLike) => ctx.versions.filter((v) => v.document_id === doc.id).sort((a, b) => a.number - b.number);

  const shareDocs = p[1] === "documents" && p[2] && p[3] === "share-links";
  const shareLinks = p[1] === "share-links";
  const publicRoutes = p[1] === "roadmaps" && p[2] && (["public-texts", "public-page"].includes(p[3]) || (p[3] === "versions" && p[5] === "public-preview") || (p[3] === "publications" && p[5] === "public-check"));
  if (!shareDocs && !shareLinks && !publicRoutes) return null;

  if (publicRoutes) {
    const denied = person("approver", "Public texts are written and approved by people, not a run's agents");
    if (denied) return denied;
    const doc = roadmap(p[2]);
    if (!doc) return json(404, { detail: "Document not found" });
    if (doc.kind !== "roadmap") return json(422, { detail: "Public texts are for roadmaps only" });
    const all = versionsOf(doc);
    const pick = (n: number | null) => (n ? all.find((v) => v.number === n) : all.at(-1));
    if (p[3] === "public-texts" && !p[4] && m === "GET") {
      const v = pick(q.get("version") ? Number(q.get("version")) : null);
      if (!v) return json(404, { detail: "Version not found" });
      const r = review(ctx, doc, v);
      const hash = contentHash(r);
      const check = latestCheck(ctx, v.id);
      const page = ctx.db.pages[doc.id];
      const left = { no_approved_text: 0, excluded: 0, no_goal: 0 } as Record<string, number>;
      for (const row of r.rows) if (row.left_out_reason) left[row.left_out_reason] += 1;
      const out: Schemas["PublicTextsOut"] = {
        document: doc.slug,
        version: v.number,
        public_title: page?.public_title ?? null,
        public_intro: page?.public_intro ?? null,
        page_findings: r.pageFindings,
        rows: r.rows,
        shown: r.rows.filter((x) => x.shown).length,
        left_out: left,
        removed: r.removed,
        content_hash: hash,
        check: { state: !check ? "none" : check.content_hash === hash ? "checked" : "lapsed", check: check ? checkOut(check, v.number, hash) : null },
        not_ready: notReady(r),
      };
      return json(200, out);
    }
    if (p[3] === "public-texts" && p[4] === "draft" && m === "POST") {
      const v = pick(q.get("version") ? Number(q.get("version")) : null);
      if (!v) return json(404, { detail: "Version not found" });
      if (ctx.observesOutside?.() ?? true) {
        return json(409, { detail: "Oracle is set to observe words for people outside (Settings, Autonomy); write the public texts yourself" });
      }
      const job = ctx.queueDraft!(doc, v);
      return typeof job === "string" ? json(409, { detail: job }) : json(202, job);
    }
    if (p[3] === "public-texts" && p[4] && m === "PUT") {
      const v = pick(q.get("version") ? Number(q.get("version")) : null)!;
      const item = items(v).find((i) => i.key === p[4]);
      if (!item) return json(404, { detail: `item '${p[4]}' is not in version ${v.number}` });
      const input = await body<Schemas["PublicTextIn"]>();
      if (!input.title || input.title.length > 80) return json(422, { detail: "A public title is 1 to 80 characters" });
      if ((input.description ?? "").length > 280) return json(422, { detail: "A public description is at most 280 characters" });
      if (input.changelog_url && !input.changelog_url.startsWith("https://")) return json(422, { detail: "a changelog link must be an https address" });
      const found = findings(ctx, `${input.title}\n${input.description ?? ""}\n${input.changelog_url ?? ""}`, item.title);
      if (input.state === "approved") {
        const blocking = found.filter((f) => f.severity === "blocking");
        if (blocking.length) {
          return json(422, {
            detail: {
              code: "leak_blocking",
              message: `This text names something a public reader may not see: ${blocking.map((f) => `${f.code} (${f.words.join(", ")})`).join("; ")}`,
              findings: blocking,
            },
          });
        }
        const unticked = found.filter((f) => f.severity === "warning" && !(input.checked_warnings ?? []).includes(f.code)).map((f) => f.code);
        if (unticked.length) return json(422, { detail: { code: "warnings_unchecked", message: 'Tick "I checked this" for each warning first', warnings: unticked } });
      }
      let row = ctx.db.texts.find((t) => t.document_id === doc.id && t.item_key === item.key);
      if (!row) {
        row = { document_id: doc.id, item_key: item.key, title: "", description: "", stage: "planned", state: "draft", drafted_by: me.id, checked_warnings: [], source_hash: "" };
        ctx.db.texts.push(row);
      }
      Object.assign(row, {
        title: input.title,
        description: input.description ?? "",
        stage: input.stage,
        announced_quarter: input.announced_quarter ?? null,
        changelog_url: input.changelog_url || null,
        state: input.state ?? "draft",
        checked_warnings: input.checked_warnings ?? [],
        source_hash: sourceHash(item.title),
        updated_at: ctx.now(),
        approved_by: input.state === "approved" ? me.id : null,
        approved_at: input.state === "approved" ? ctx.now() : null,
      });
      return json(200, textOut(ctx, row, item.title));
    }
    if (p[3] === "public-page" && m === "PUT") {
      const input = await body<Schemas["PublicPageIn"]>();
      const page = (ctx.db.pages[doc.id] ??= { public_title: null, public_intro: null });
      const title = "public_title" in input ? (input.public_title ?? null) : page.public_title;
      const intro = "public_intro" in input ? (input.public_intro ?? null) : page.public_intro;
      const found = findings(ctx, `${title ?? ""}\n${intro ?? ""}`, null);
      const blocking = found.filter((f) => f.severity === "blocking");
      if (blocking.length) return json(422, { detail: { code: "leak_blocking", message: "The public title or intro names something a public reader may not see", findings: blocking } });
      page.public_title = title || null;
      page.public_intro = intro || null;
      return json(200, { public_title: page.public_title, public_intro: page.public_intro, findings: found });
    }
    if (p[3] === "versions" && p[5] === "public-preview" && m === "GET") {
      const v = pick(Number(p[4]));
      if (!v) return json(404, { detail: "Version not found" });
      return html(200, renderPublic(review(ctx, doc, v), "Preview: a shared link's page shows when it was shared and when it ends here"));
    }
    if (p[3] === "publications" && p[5] === "public-check" && m === "POST") {
      const pub = ctx.publications.find((x) => x.document_id === doc.id && x.number === Number(p[4]));
      if (!pub) return json(404, { detail: `publication ${p[4]} of '${doc.slug}' not found` });
      const v = ctx.versions.find((x) => x.id === pub.version_id)!;
      const r = review(ctx, doc, v);
      const left = notReady(r);
      if (left.length) return json(409, { detail: { code: "not_ready", message: "Approve or exclude every item's public text first", left } });
      const check: CheckRow = {
        id: ctx.uuid(), document_id: doc.id, version_id: v.id, publication_id: pub.id, checked_by: me.id, checked_at: ctx.now(),
        shown_item_keys: r.rows.filter((x) => x.shown).map((x) => x.item_key), content_hash: contentHash(r),
      };
      ctx.db.checks.push(check);
      return json(201, checkOut(check, v.number, check.content_hash));
    }
    return null;
  }

  // Share links: approvers and owners, never a run's token.
  const denied = person("approver");
  if (denied) return denied;
  const at = ctx.now();
  if (shareDocs) {
    const doc = roadmap(p[2]);
    if (!doc) return json(404, { detail: "Document not found" });
    if (!p[4] && m === "GET") {
      const rows = ctx.db.links.filter((l) => l.document_id === doc.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(200, rows.map((l) => linkOut(ctx, l)));
    }
    if (!p[4] && m === "POST") {
      if (doc.kind !== "roadmap") return json(422, { detail: "Only roadmaps are shared by link" });
      if (doc.visibility === "approvers") return json(403, { detail: "An approvers-only document is not shared by link" });
      const input = await body<Schemas["ShareLinkIn"]>();
      if (input.audience === "public" && me.role !== "owner") return json(403, { detail: "Only an owner can share the Public version" });
      if (!input.label?.trim() || input.label.length > 120) return json(422, { detail: "A label is 1 to 120 characters" });
      const expires = input.expires_in ?? "14d";
      if (!(expires in EXPIRY)) return json(422, { detail: "An expiry is 24h, 7d, 14d, 30d or 90d" });
      if (input.passcode != null && (input.passcode.length < 8 || input.passcode.length > 128)) return json(422, { detail: "A passcode is 8 to 128 characters" });
      const pub = ctx.publications.find((x) => x.id === input.publication_id && x.document_id === doc.id);
      if (!pub) return json(409, { detail: { code: "not_published", message: "Publish this version first" } });
      if (input.audience === "public" && !publicChecked(ctx, doc, pub)) {
        return json(409, { detail: { code: "no_public_check", message: "Check the public version of this publication first" } });
      }
      const generated = input.passcode == null;
      const link: LinkRow = {
        id: ctx.uuid(), document_id: doc.id, publication_id: pub.id, audience: input.audience, label: input.label.trim(), token: randomToken(32),
        passcode: generated ? passcode() : input.passcode!, passcode_version: 1, failures: 0, locked_until: null, created_by: me.id, created_at: at,
        expires_at: new Date(Date.parse(at) + EXPIRY[expires] * 86_400_000).toISOString(), revoked_at: null, revoked_reason: null,
        allow_download: input.allow_download ?? true, views: 0, last_viewed_at: null, inbox_dismissed_at: null,
      };
      ctx.db.links.push(link);
      const url = `${typeof location !== "undefined" ? location.origin : "http://localhost"}/s/${link.token}`;
      return json(201, { link: linkOut(ctx, link), url, passcode: link.passcode, passcode_generated: generated, expires_at: link.expires_at });
    }
    if (p[4] === "revoke-all" && m === "POST") {
      if (me.role !== "owner") return json(403, { detail: "Requires the owner role" });
      const live = ctx.db.links.filter((l) => l.document_id === doc.id && !l.revoked_at);
      const { reason } = await body<{ reason: string }>();
      for (const l of live) Object.assign(l, { revoked_at: at, revoked_reason: reason, inbox_dismissed_at: at });
      return json(200, { revoked: live.length });
    }
    return null;
  }
  if (p[2] === "dismiss" && m === "POST") {
    if (me.role !== "owner") return json(403, { detail: "Requires the owner role" });
    const { ids } = await body<{ ids: string[] }>();
    const rows = ctx.db.links.filter((l) => ids.includes(l.id) && l.revoked_at && !l.inbox_dismissed_at);
    for (const l of rows) l.inbox_dismissed_at = at;
    return json(200, { dismissed: rows.length });
  }
  const link = ctx.db.links.find((l) => l.id === p[2]);
  if (!link) return json(404, { detail: "share link not found" });
  const creatorOrOwner = () =>
    me.role === "owner" || me.id === link.created_by ? null : json(403, { detail: "Only the link's creator or an owner can change it" });
  if (!p[3] && m === "PATCH") {
    const refused = creatorOrOwner();
    if (refused) return refused;
    if (link.revoked_at) return json(409, { detail: "This link is revoked; make a new one instead" });
    const input = await body<Schemas["ShareLinkPatch"]>();
    if (input.expires_in) link.expires_at = new Date(Date.parse(at) + EXPIRY[input.expires_in] * 86_400_000).toISOString();
    if (input.publication_id && input.publication_id !== link.publication_id) {
      const pub = ctx.publications.find((x) => x.id === input.publication_id && x.document_id === link.document_id);
      if (!pub) return json(404, { detail: "publication not found" });
      const doc = ctx.documents.find((d) => d.id === link.document_id)!;
      if (link.audience === "public" && !publicChecked(ctx, doc, pub)) return json(409, { detail: { code: "no_public_check", message: "Check the public version of this publication first" } });
      link.publication_id = pub.id;
    }
    return json(200, linkOut(ctx, link));
  }
  if (p[3] === "passcode" && m === "POST") {
    const refused = creatorOrOwner();
    if (refused) return refused;
    if (link.revoked_at) return json(409, { detail: "This link is revoked" });
    const input = await body<{ passcode?: string | null }>();
    const generated = input.passcode == null;
    Object.assign(link, { passcode: generated ? passcode() : input.passcode, passcode_version: link.passcode_version + 1, failures: 0, locked_until: null });
    return json(200, { link: linkOut(ctx, link), passcode: link.passcode, passcode_generated: generated });
  }
  if (p[3] === "revoke" && m === "POST") {
    if (link.audience === "public") {
      const refused = creatorOrOwner();
      if (refused) return refused;
    }
    const { reason } = await body<{ reason?: string | null }>();
    if (!link.revoked_at) Object.assign(link, { revoked_at: at, revoked_reason: reason || null });
    link.inbox_dismissed_at ??= at;
    return json(200, linkOut(ctx, link));
  }
  if (p[3] === "views" && m === "GET") {
    const rows = ctx.db.views.filter((v) => v.link_id === link.id).sort((a, b) => b.viewed_at.localeCompare(a.viewed_at));
    const days = new Map<string, number>();
    for (const r of rows) days.set(r.viewed_at.slice(0, 10), (days.get(r.viewed_at.slice(0, 10)) ?? 0) + 1);
    const out: Schemas["ShareViewsOut"] = {
      link_id: link.id,
      zone: "UTC",
      note: VIEW_NOTE,
      views: rows.length,
      distinct_browsers: new Set(rows.map((r) => r.browser_key)).size,
      entries: rows.map((r) => ({ viewed_at: r.viewed_at, kind: r.kind, browser_family: r.browser_family, country: r.country })),
      days: [...days.entries()].sort().map(([d, views]) => ({ day: d, views })),
    };
    return json(200, out);
  }
  return null;
}

function latestCheck(ctx: SharesContext, versionId: string): CheckRow | undefined {
  return ctx.db.checks.filter((c) => c.version_id === versionId).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
}

function checkOut(c: CheckRow, number: number, current: string): Schemas["PublicCheckOut"] {
  return {
    id: c.id, publication_id: c.publication_id, version_number: number, checked_by: c.checked_by, checked_at: c.checked_at,
    shown_item_keys: c.shown_item_keys, content_hash: c.content_hash, state: c.content_hash === current ? "checked" : "lapsed",
  };
}

function publicChecked(ctx: SharesContext, doc: DocLike, pub: PubLike): boolean {
  const v = ctx.versions.find((x) => x.id === pub.version_id);
  if (!v) return false;
  const check = ctx.db.checks.filter((c) => c.publication_id === pub.id).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
  return !!check && check.content_hash === contentHash(review(ctx, doc, v));
}

// --------------------------------------------------------------------------- a link holder's routes

const page = (title: string, body: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;

/** /v1/public/shares/{token}[/pdf|/status]: no member credential, only the token and the "cookie". */
export async function routePublicShares(ctx: SharesContext, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "public" || p[2] !== "shares" || !p[3]) return null;
  const token = p[3];
  const m = req.method;
  const at = ctx.now();
  const link = ctx.db.links.find((l) => l.token === token);
  const cookie = ctx.db.opened[token];
  const open = !!link && !!cookie && cookie.v === link.passcode_version;
  if (!p[4] && m === "POST") {
    let value = "";
    try {
      const kind = req.headers.get("content-type") ?? "";
      value = kind.startsWith("application/json") ? String((await req.json())?.passcode ?? "") : String(new URLSearchParams(await req.text()).get("passcode") ?? "");
    } catch {
      value = "";
    }
    if (link?.locked_until && link.locked_until > at) {
      return html(429, page("Enter the passcode", "<p>Too many tries.</p>"), { "retry-after": String(Math.ceil((Date.parse(link.locked_until) - Date.parse(at)) / 1000)) });
    }
    const right = !!link && !!value && value === link.passcode;
    if (!link || !right || state(link, at) !== "active") {
      if (link && !right) {
        link.failures += 1;
        if (link.failures >= PASSCODE_TRIES) Object.assign(link, { failures: 0, locked_until: new Date(Date.parse(at) + LOCK_MS).toISOString() });
      }
      return html(404, page("Enter the passcode", "<p><strong>That passcode did not open a link.</strong></p>"));
    }
    link.failures = 0;
    ctx.db.opened[token] = { v: link.passcode_version, b: cookie?.b ?? randomToken(12) };
    return showPage(ctx, link, "page");
  }
  if (p[4] === "status" && m === "GET") {
    if (!open) return json(200, { state: "locked" });
    return json(200, { state: state(link!, at) === "active" ? "active" : "ended" });
  }
  if (!open) return p[4] === "pdf" ? json(404, { reason: "not_found" }) : html(401, page("Enter the passcode", "<h1>Enter the passcode</h1>"));
  if (state(link!, at) !== "active") return html(410, page("Link ended", `<p>${esc(ENDED)}</p>`));
  if (p[4] === "pdf" && m === "GET") {
    if (!link!.allow_download) return json(404, { reason: "not_found" });
    record(ctx, link!, "download");
    return new Response("%PDF-1.4\n% mock shared roadmap\n", { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="roadmap.pdf"' } });
  }
  if (!p[4] && m === "GET") return showPage(ctx, link!, "page");
  return null;
}

function record(ctx: SharesContext, link: LinkRow, kind: "page" | "download") {
  const at = ctx.now();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const family = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Other";
  ctx.db.views.push({ link_id: link.id, viewed_at: at, kind, browser_key: `k:${ctx.db.opened[link.token]?.b ?? "x"}`, browser_family: family, country: null });
  link.views += 1;
  link.last_viewed_at = at;
}

function showPage(ctx: SharesContext, link: LinkRow, kind: "page"): Response {
  const doc = ctx.documents.find((d) => d.id === link.document_id);
  const pub = ctx.publications.find((x) => x.id === link.publication_id);
  const v = pub && ctx.versions.find((x) => x.id === pub.version_id);
  if (!doc || !v) return html(410, page("Link ended", `<p>${esc(ENDED)}</p>`));
  const footer = `Shared with you by ${ctx.company} on ${day(link.created_at)} · link expires ${day(link.expires_at)}`;
  let content: string;
  if (link.audience === "public") {
    if (!publicChecked(ctx, doc, pub!)) content = page(UPDATING, `<p>${UPDATING}.</p>`);
    else content = renderPublic(review(ctx, doc, v), `Shared ${day(link.created_at)} · expires ${day(link.expires_at)}`);
  } else {
    content = ctx.renderAudience(doc, v, link.audience).replace("</body>", `<footer class="share-footer">${esc(footer)}</footer></body>`);
  }
  record(ctx, link, kind);
  return html(200, content, { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" });
}
