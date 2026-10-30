/**
 * Mock of the sources API (Lane B1): the signed-in user's sources, sync, uploads,
 * items, snapshots and search. Confidence is a fixed table rather than the real
 * scoring, so the UI's badge and breakdown can be exercised.
 */
import type { Schemas } from "@/lib/api/client";
import type { CitedItem } from "./baseline";
import { FIREFLIES_DEFAULT_ENDPOINT, mockConnectionEndpoint } from "./connections";
import { FIREFLIES_CONNECTION_ID } from "./fireflies";
import { mockUuid, PRODUCT_CHAT_ID, seeded, seededItemId } from "./ids";
import { MOCK_NOTION_CONNECTION_ID } from "./notion";

type Source = Schemas["SourceOut"];
// `folder`: the picked Drive folder a Google Doc came from (mock only).
type Item = Schemas["ItemOut"] & { content: string; source_name: string; folder?: string };
type Confidence = Schemas["ConfidenceOut"];

interface SourcesDb {
  sources: Source[];
  items: Item[];
  snapshots: Schemas["SnapshotOut"][];
  /** Other members' sources and items, by email: only the owners' Company coverage counts them. */
  team?: Record<string, { sources: Source[]; items: Item[] }>;
}

type Role = Schemas["Me"]["role"];
type UsedIn = Schemas["UsedIn"];

/** What coverage needs from the rest of the mock: who asks, the members, and every use of an item. */
export type SourcesContext = {
  /** The mock scenario ("empty" starts with no sources). */
  scenario: string | null;
  me: { email: string; role: Role };
  members: { id: string; email: string; role: Role; disabled: boolean }[];
  /** Baseline evidence, citations and section links pointing at source items. */
  uses: () => UsedIn[];
};


export const SOURCES_STORAGE_KEY = "po-mock-sources-v2";
/**
 * Tests set this localStorage key to a source's name to have someone edit that source while
 * its next sync runs: the sync ends superseded and keeps nothing (as the API's does). Read once.
 */
export const MOCK_SYNC_SUPERSEDED_KEY = "po-mock-sync-superseded";

/** A Fireflies connection's endpoint, as Settings > Connections set it (the default otherwise). */
function withEndpoint(c: Schemas["ConnectionChoice"]): Schemas["ConnectionChoice"] {
  if (c.id !== FIREFLIES_CONNECTION_ID) return c;
  return { ...c, endpoint_url: mockConnectionEndpoint(c.id) ?? FIREFLIES_DEFAULT_ENDPOINT };
}

const CONNECTIONS: Record<string, Schemas["ConnectionChoice"][]> = {
  slack: [
    { id: "c0000000-0000-4000-8000-000000000001", account_label: "Example Co chat", status: "active" },
    { id: "c0000000-0000-4000-8000-000000000003", account_label: "Partner workspace", status: "active" },
  ],
  github: [{ id: "c0000000-0000-4000-8000-000000000002", account_label: "example-org", status: "active" }],
  notion: [{ id: MOCK_NOTION_CONNECTION_ID, account_label: "Example Notion", status: "active" }],
  fireflies: [{ id: FIREFLIES_CONNECTION_ID, account_label: "pat@example.com", status: "active" }],
  google: [
    { id: "c0000000-0000-4000-8000-000000000005", account_label: "pat@example.com", status: "active", reconnect_reason: null },
    {
      id: "c0000000-0000-4000-8000-000000000006",
      account_label: "old-drive@example.com",
      status: "active",
      reconnect_reason: "Reconnect to choose files",
    },
  ],
};
const PROVIDER: Record<Source["kind"], string | null> = {
  upload: null,
  github: "github",
  slack: "slack",
  notion: "notion",
  fireflies: "fireflies",
  google_docs: "google",
};
const AVAILABLE: Record<Source["kind"], boolean> = {
  upload: true,
  github: true,
  slack: true,
  notion: true,
  fireflies: true,
  google_docs: true,
};
// Source factor per kind, as in oracle.confidence DEFAULTS.
const SOURCE_FACTOR: Record<string, number> = { github: 0.85, upload: 0.7, notion: 0.7, slack: 0.5 };

// The Slack connector's limits (oracle.sources.connectors.slack).
const MAX_CHANNELS = 100;
// How many page titles a Notion source's labels may hold (oracle.sources.connectors.notion).
const MAX_NOTION_LABELS = 200;
// How long a pick's stored name may be (oracle.sources.base LABEL_LENGTH).
const LABEL_LENGTH = 200;

// The kinds whose picks carry names in `labels`: the config key of the picks, the cap and
// the message for a malformed one (as the connectors word them).
const LABELLED: Partial<Record<Source["kind"], { key: string; max: number; message: string }>> = {
  slack: { key: "channels", max: MAX_CHANNELS, message: "labels must map channel ids to names" },
  notion: { key: "roots", max: MAX_NOTION_LABELS, message: "labels must map page ids to titles" },
};

function mapsStrings(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/** What a config selects: everything but `labels`, which only name things (oracle.sources.base selection). */
function selection(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([k]) => k !== "labels"));
}

/** As the connectors' normalize_config: names kept only for the picks, each cut to length. */
function normalizeLabels(kind: Source["kind"], config: Record<string, unknown>): Record<string, unknown> {
  // GitHub's include is stored sorted, without repeats (the connector's normalize_config).
  if (kind === "github" && Array.isArray(config.include)) config = { ...config, include: [...new Set(config.include.map(String))].sort() };
  const rule = LABELLED[kind];
  const labels = config.labels;
  const picks = config[rule?.key ?? ""];
  if (!rule || !mapsStrings(labels) || Object.keys(labels).length > rule.max || !Array.isArray(picks)) return config;
  const keep = new Set(picks.map((p) => String(p).trim()));
  return {
    ...config,
    labels: Object.fromEntries(Object.entries(labels).filter(([k]) => keep.has(k)).map(([k, v]) => [k, v.slice(0, LABEL_LENGTH)])),
  };
}
const FIRST_DAY = "2000-01-01";
const LAST_DAY = "2100-12-31";

const now = () => new Date().toISOString();
const uuid = mockUuid;

function confidence(kind: string, freshness: number): Confidence {
  const values = { source: SOURCE_FACTOR[kind] ?? 0.5, freshness, mentions: 0.5, goal_impact: 0.5 };
  const weights = { source: 0.35, freshness: 0.25, mentions: 0.2, goal_impact: 0.2 };
  const value = Object.entries(values).reduce((sum, [k, v]) => sum + v * weights[k as keyof typeof weights], 0);
  const breakdown = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, { value: v, weight: weights[k as keyof typeof weights] }]),
  );
  return { value: Math.round(value * 1000) / 1000, breakdown, low: value < 0.4 };
}

/** A Slack channel whose first sync stops on the rate limit part way (#249). */
const RATE_LIMITED_CHANNEL = "C0RATELIMIT";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function seed(): SourcesDb {
  const chat: Source = {
    id: PRODUCT_CHAT_ID,
    kind: "slack",
    name: "Product chat",
    connection_id: CONNECTIONS.slack[0].id,
    // Saved with the channels' names, as the picker saves them: the row reads "#product", not an id.
    config: { channels: ["C0123PRODUCT", "C0456FEEDBACK"], labels: { C0123PRODUCT: "#product", C0456FEEDBACK: "#customer-feedback" } },
    status: "active",
    last_error: null,
    last_synced_at: "2026-10-17T08:00:00Z",
    created_at: "2026-10-10T09:00:00Z",
    updated_at: "2026-10-17T08:00:00Z",
    item_count: 2,
    connector_available: true,
    config_version: 1,
    // A channel shared in from another company: left out on purpose.
    unavailable_items: [
      { external_id: "C0777PARTNER", reason: "Skipped: shared from outside the company", name: "#partner-launch", status: "skipped" },
    ],
  };
  const repo: Source = {
    id: "50000000-0000-4000-8000-000000000002",
    kind: "github",
    name: "Example repo",
    connection_id: CONNECTIONS.github[0].id,
    config: { repos: ["example-org/example-app"] },
    status: "error",
    last_error: "The connection was rejected: token expired",
    last_synced_at: "2026-10-15T08:00:00Z",
    created_at: "2026-10-10T09:05:00Z",
    updated_at: "2026-10-16T08:00:00Z",
    item_count: 1,
    connector_available: true,
    config_version: 1,
  };
  // Saved before the 100-channel rule (as the API's 0016 migration leaves such a source):
  // syncs answer needs_attention until it is edited back within the rules.
  const legacy: Source = {
    id: "50000000-0000-4000-8000-000000000003",
    kind: "slack",
    name: "Legacy all-hands chat",
    connection_id: CONNECTIONS.slack[0].id,
    config: { channels: Array.from({ length: 120 }, (_, i) => `C9${String(i + 1).padStart(3, "0")}LEGACY`) },
    status: "needs_attention",
    last_error: `Allowlist at most ${MAX_CHANNELS} channels: edit this source to sync it again`,
    last_synced_at: "2026-10-01T08:00:00Z",
    created_at: "2026-03-02T09:00:00Z",
    updated_at: "2026-10-18T08:00:00Z",
    item_count: 0,
    connector_available: true,
    config_version: 1,
  };
  // Saved before the meeting picker: a title rule.
  const calls: Source = {
    id: "50000000-0000-4000-8000-000000000004",
    kind: "fireflies",
    name: "Customer calls",
    connection_id: FIREFLIES_CONNECTION_ID,
    config: { from_date: "2026-09-01", title_contains: ["Customer interview"] },
    status: "active",
    last_error: null,
    last_synced_at: "2026-10-17T08:00:00Z",
    created_at: "2026-10-10T09:10:00Z",
    updated_at: "2026-10-17T08:00:00Z",
    item_count: 0,
    connector_available: true,
    config_version: 1,
  };
  // Google Docs and folders picked in the Drive picker. Since: one doc was unshared, Oracle
  // lost access to one folder (its docs are hidden until it can be read again), three docs
  // in a picked folder are owned outside the company and one is in a shared drive outside
  // it, so they were skipped.
  const docs: Source = {
    id: "50000000-0000-4000-8000-000000000005",
    kind: "google_docs",
    name: "Product docs",
    connection_id: CONNECTIONS.google[0].id,
    config: {
      docs: ["1DocPricingExample", "1DocActivationExample", "1DocInterviewsExample"],
      folders: ["1FolderSpecsExample", "1FolderVendorExample"],
      names: {
        "1DocPricingExample": "Pricing strategy",
        "1DocActivationExample": "Activation v2 PRD",
        "1DocInterviewsExample": "Customer interviews Q3",
        "1FolderSpecsExample": "Product specs",
        "1FolderVendorExample": "Vendor research",
      },
    },
    status: "active",
    last_error: null,
    last_synced_at: "2026-10-19T08:00:00Z",
    created_at: "2026-10-19T07:00:00Z",
    updated_at: "2026-10-19T08:00:00Z",
    item_count: 3,
    connector_available: true,
    config_version: 1,
    unavailable_items: [
      {
        external_id: "1FolderVendorExample",
        reason:
          "Lost access to Vendor research: removed, or no longer shared with you. Its docs are hidden until Oracle can read it again",
        name: null,
        status: "unavailable",
      },
      { external_id: "1DocInterviewsExample", reason: "No access: removed, or no longer shared with you", name: null, status: "unavailable" },
      ...["Agency SOW 2026", "Partner pricing sheet", "Contractor onboarding notes"].map((name, i) => ({
        external_id: `1DocOutside${i}Example`,
        reason: "Skipped: owned outside example.com",
        name,
        status: "skipped" as const,
      })),
      // In a picked folder, but in a shared drive that is not on the company's list (S5).
      {
        external_id: "1DocPartnerDriveExample",
        reason: "Skipped: in a shared drive outside the company",
        name: "Joint launch plan",
        status: "skipped" as const,
      },
    ],
    reconnect_reason: null,
  };
  // A folder source on a connection holding only the short-lived drive.file grant, which
  // cannot read folders: "Reconnect to choose files".
  const folders: Source = {
    id: "50000000-0000-4000-8000-000000000006",
    kind: "google_docs",
    name: "Drive folders",
    connection_id: CONNECTIONS.google[1].id,
    config: { folders: ["1FolderProductExample"] },
    status: "active",
    last_error: null,
    last_synced_at: "2026-10-12T08:00:00Z",
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-12T08:00:00Z",
    item_count: 0,
    connector_available: true,
    config_version: 1,
    unavailable_items: [],
    reconnect_reason: "Reconnect to choose files",
  };
  const item = (
    source: Source,
    external_id: string,
    kind: string,
    title: string,
    content: string,
    freshness: number,
    age: number,
    folder?: string,
  ): Item => ({
    id: seededItemId(source.id, external_id),
    source_id: source.id,
    source_kind: source.kind,
    source_name: source.name,
    external_id,
    kind,
    title,
    url: `https://example.com/${external_id}`,
    author: "someone",
    acl: {},
    // Days old when the mock is seeded: "Product chat" holds one fresh and one aging message.
    occurred_at: daysAgo(age),
    source_updated_at: null,
    deleted_at: null,
    version_id: uuid(),
    fetched_at: "2026-10-17T08:00:00Z",
    confidence: confidence(source.kind, freshness),
    content,
    ...(folder ? { folder } : {}),
  });
  return {
    sources: [chat, repo, legacy, calls, docs, folders],
    items: [
      item(repo, "readme", "readme", "README", "The onboarding checklist guides new accounts through setup in five steps.", 0.95, 10),
      item(chat, "m1", "message", "Customer question", "Customers keep asking whether the onboarding checklist can be skipped.", 0.4, 40),
      item(chat, "m2", "message", "Pricing thread", "Annual pricing gets a discount for teams above ten seats.", 0.9, 10),
      item(docs, "1DocPricingExample", "doc", "Pricing strategy", "Annual plans get two months free.", 0.9, 5),
      item(docs, "1DocActivationExample", "doc", "Activation v2 PRD", "New accounts finish setup in under 3 minutes.", 0.8, 5),
      item(docs, "1DocCheckoutSpecExample", "doc", "Checkout spec", "Guests can check out without an account.", 0.8, 5, "1FolderSpecsExample"),
    ],
    snapshots: [],
    team: seedTeam(item),
  };
}

/**
 * Other members' sources, seen only as counts on the owners' Company tab: the approver has one
 * Drive source holding only stale docs, the viewer one GitHub source never synced, the commenter
 * none.
 */
function seedTeam(item: (source: Source, id: string, kind: string, title: string, content: string, f: number, age: number) => Item) {
  const base = { connector_available: true, config_version: 1, last_error: null, status: "active" as const, unavailable_items: [] };
  const drive: Source = {
    ...base,
    id: "50000000-0000-4000-8000-000000000101",
    kind: "google_docs",
    name: "Approver drive",
    connection_id: null,
    config: { docs: ["1DocOldPlanExample", "1DocOldNotesExample"] },
    last_synced_at: "2026-09-01T08:00:00Z",
    created_at: "2025-06-01T08:00:00Z",
    updated_at: "2026-09-01T08:00:00Z",
    item_count: 2,
  };
  const repo: Source = {
    ...base,
    id: "50000000-0000-4000-8000-000000000102",
    kind: "github",
    name: "Viewer repo",
    connection_id: null,
    config: { repos: ["example-org/viewer-tools"] },
    last_synced_at: null,
    created_at: "2026-10-18T08:00:00Z",
    updated_at: "2026-10-18T08:00:00Z",
    item_count: 0,
  };
  return {
    "approver@example.com": {
      sources: [drive],
      items: [
        item(drive, "1DocOldPlanExample", "doc", "Old plan", "Last year's plan.", 0.3, 400),
        item(drive, "1DocOldNotesExample", "doc", "Old notes", "Notes from last year.", 0.3, 420),
      ],
    },
    "viewer@example.com": { sources: [repo], items: [] },
  };
}

/** The mock's sources; ``scenario`` defaults to the stored mock scenario. */
function load(scenario: string | null = localStorage.getItem("po-mock-scenario")): SourcesDb {
  const raw = localStorage.getItem(SOURCES_STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as SourcesDb;
    } catch {
      // fall through to a fresh seed
    }
  }
  // A new company: nobody has connected anything yet.
  if (scenario === "empty") return { sources: [], items: [], snapshots: [], team: {} };
  return seeded("sources", seed);
}

/** A source's kind and repositories (the code map mock, ./engineering.ts); null when there is none. */
export function sourceRepos(id: string): { kind: Source["kind"]; repos: string[] } | null {
  const s = load().sources.find((x) => x.id === id);
  if (!s) return null;
  const repos = (s.config as Record<string, unknown>).repos;
  return { kind: s.kind, repos: Array.isArray(repos) ? repos.map(String) : [] };
}

/** One of the signed-in person's items, as citing it as evidence copies it (#338); null when there is none. */
export function sourceItem(id: string): CitedItem | null {
  const i = load().items.find((x) => x.id === id && !x.deleted_at);
  if (!i) return null;
  const { source_id, source_kind, kind, title, url, content, fetched_at } = i;
  return { id: i.id, source_id, source_kind, kind, title: title ?? null, url: url ?? null, content, fetched_at: fetched_at ?? now() };
}

/** S4: the mock scenario where a sync brings in a new item after a PRD draft (e2e/draft-new-items.spec.ts). */
export const DRAFT_NEW_ITEMS_SCENARIO = "draft-new-items";

/** S4: how many of ``owner``'s items were fetched or deleted after ``since`` (new, changed or deleted since a draft); ``me``: who is signed in, whose items the store holds. */
export function itemsChangedSince(since: string, owner: string, me: string): number {
  const at = Date.parse(since);
  const db = load();
  const items = owner === me ? db.items : (db.team?.[owner]?.items ?? []);
  return items.filter((i) => (i.fetched_at && Date.parse(i.fetched_at) > at) || (i.deleted_at && Date.parse(i.deleted_at) > at)).length;
}

/** The sources holding at least one live item, as oracle.setup's Pick sources step counts
 * them: an empty source (an Uploads source with no files) gives the baseline nothing. */
// qa-onboarding-3: as oracle/setup.py's _sources (the join on SourceItem, deleted_at null);
// Home says the sources with nothing read beside it, from the Sources list itself.
export function sourceCount(): number {
  const db = load();
  return db.sources.filter((s) => db.items.some((i) => i.source_id === s.id && !i.deleted_at)).length;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

function itemOut(i: Item): Schemas["ItemOut"] {
  const { content: _content, source_name: _name, ...out } = i;
  void _content;
  void _name;
  return out;
}

/** GitHub: item kind -> the `include` entry that brings it in (the connector's _KIND_INCLUDE). */
const GITHUB_KIND_INCLUDE: Record<string, string> = {
  readme: "readme",
  doc: "docs",
  issue: "issues",
  pull_request: "pull_requests",
  release: "releases",
  milestone: "milestones",
};
const GITHUB_INCLUDE = Object.values(GITHUB_KIND_INCLUDE);

/** Narrowing takes effect on save (S5, owner 2026-10-20), as the API's
 * update_source does: stored items outside the new channels, repos or date range are
 * soft-deleted at once. */
function sweep(db: SourcesDb, s: Source) {
  const config = s.config as Record<string, unknown>;
  const groups = s.kind === "slack" ? config.channels : s.kind === "github" ? config.repos : null;
  const allowed = Array.isArray(groups) ? new Set(groups.map((g) => String(g).toLowerCase())) : null;
  const from = s.kind === "slack" && typeof config.since === "string" ? `${config.since}T00:00:00Z` : null;
  // GitHub's include: the kinds no longer read go too (all of them read when it is absent).
  const include = Array.isArray(config.include) ? new Set(config.include.map(String)) : null;
  for (const item of db.items) {
    if (item.source_id !== s.id || item.deleted_at) continue;
    const group = item.external_id.includes(":") ? item.external_id.split(":")[0].toLowerCase() : null;
    const unread = s.kind === "github" && include !== null && !include.has(GITHUB_KIND_INCLUDE[item.kind] ?? "");
    const outside = unread || (allowed && group !== null && !allowed.has(group)) || (from && item.occurred_at && item.occurred_at < from);
    if (outside) item.deleted_at = now();
  }
}

function pickedDrive(s: Source, key: "docs" | "folders"): string[] {
  const value = s.config[key];
  return Array.isArray(value) ? value.map(String) : [];
}

/** Deletes a Google Docs source's items no longer picked (on their own, or by their folder). */
function hideOutsidePicks(db: SourcesDb, s: Source): number {
  const docs = new Set(pickedDrive(s, "docs"));
  const folders = new Set(pickedDrive(s, "folders"));
  let deleted = 0;
  for (const i of db.items) {
    if (i.source_id !== s.id || i.deleted_at) continue;
    if (docs.has(i.external_id) || (i.folder && folders.has(i.folder))) continue;
    i.deleted_at = now();
    deleted += 1;
  }
  return deleted;
}

function counted(db: SourcesDb, s: Source): Source {
  return { ...s, item_count: db.items.filter((i) => i.source_id === s.id && !i.deleted_at).length };
}

function search(db: SourcesDb, q: URLSearchParams): Schemas["SearchResults"] {
  const query = q.get("q") ?? "";
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  const kinds = q.getAll("kinds").flatMap((k) => k.split(",")).filter(Boolean);
  const source = q.get("source");
  const hits = db.items
    .filter((i) => !i.deleted_at && (!kinds.length || kinds.includes(i.kind)) && (!source || i.source_id === source))
    .map((i) => {
      const text = `${i.title ?? ""} ${i.content}`.toLowerCase();
      const relevance = words.reduce((n, w) => n + (text.split(w).length - 1), 0) / 10;
      const score = relevance * (0.5 + 0.5 * i.confidence.value);
      let snippet = i.content;
      for (const w of words) snippet = snippet.replace(new RegExp(`\\b(${w})`, "gi"), "<mark>$1</mark>");
      return { item: itemOut(i), snippet, relevance, score };
    })
    .filter((h) => h.relevance > 0)
    .sort((a, b) => b.score - a.score);
  return { query, as_of: q.get("as_of"), hits };
}

/**
 * The API's Slack config rules (oracle.sources.connectors.slack check_config), as the
 * connector words them: at most 100 channels, dates from 2000-01-01 to 2100-12-31, until
 * not before since; Notion needs a root. Other kinds pass.
 */
function badConfig(kind: Source["kind"], config: Record<string, unknown>): string | null {
  const rule = LABELLED[kind];
  if (rule && config.labels !== undefined) {
    if (!mapsStrings(config.labels)) return rule.message;
    if (Object.keys(config.labels).length > rule.max) return `labels takes at most ${rule.max} entries`;
  }
  // As the real connector reads a Notion allowlist: "roots" only.
  if (kind === "notion") {
    return Array.isArray(config.roots) && config.roots.length ? null : "allowlist at least one root page or database";
  }
  // As the GitHub connector's _parse_config reads include: absent (all), or at least one known kind.
  if (kind === "github" && config.include !== undefined) {
    const include = config.include;
    if (!Array.isArray(include) || !include.length) return `include at least one of ${GITHUB_INCLUDE.join(", ")}`;
    const unknown = include.find((i) => !GITHUB_INCLUDE.includes(String(i)));
    if (unknown !== undefined) return `unknown include '${unknown}'; use ${GITHUB_INCLUDE.join(", ")}`;
  }
  if (kind !== "slack") return null;
  const channels = config.channels;
  if (Array.isArray(channels) && channels.length > MAX_CHANNELS) return `allowlist at most ${MAX_CHANNELS} channels`;
  for (const key of ["since", "until"] as const) {
    const v = config[key];
    if (v == null) continue;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < FIRST_DAY || v > LAST_DAY) {
      return `${key} must be a date (YYYY-MM-DD) from ${FIRST_DAY} to ${LAST_DAY}`;
    }
  }
  const { since, until } = config;
  if (typeof since === "string" && typeof until === "string" && until < since) return "until must be on or after since";
  return null;
}

/** Handles /v1/sources*, /v1/source-items*, /v1/snapshots* and /v1/search. */

export async function routeSources(req: Request, p: string[], q: URLSearchParams, ctx: SourcesContext): Promise<Response> {
  const db = load(ctx.scenario);
  const res = await route(db, req, p, q, ctx);
  localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(db));
  return res;
}

async function route(db: SourcesDb, req: Request, p: string[], q: URLSearchParams, ctx: SourcesContext): Promise<Response> {
  const m = req.method;
  if (p[1] === "search") return json(200, search(db, q));
  if (p[1] === "snapshots") {
    if (p.length === 2 && m === "POST") {
      const body = (await req.json()) as Schemas["SnapshotCreate"];
      const s = { id: uuid(), label: body.label ?? null, as_of: body.as_of ?? now(), created_by: null, created_at: now() };
      db.snapshots.push(s);
      return json(201, s);
    }
    if (p.length === 2) return json(200, db.snapshots);
    return json(404, { detail: "Snapshot not found" });
  }
  if (p[1] === "source-items") {
    const i = db.items.find((x) => x.id === p[2]);
    if (!i) return json(404, { detail: "Item not found" });
    return json(200, { ...itemOut(i), content: i.content, version_count: 1 });
  }

  if (p.length === 2) {
    if (m === "GET") return json(200, db.sources.map((s) => counted(db, s)));
    const body = (await req.json()) as Schemas["SourceCreate"];
    if (!AVAILABLE[body.kind]) return json(422, { detail: "connector not available yet" });
    const choice = Object.values(CONNECTIONS).flat().find((c) => c.id === body.connection_id);
    if (body.kind === "google_docs" && choice?.reconnect_reason && body.config?.folders) {
      return json(422, {
        detail: "Reconnect to choose files: this Google connection cannot read folders; reconnect Google to give Oracle read access to your Drive",
      });
    }
    const invalid = badConfig(body.kind, body.config ?? {});
    if (invalid) return json(422, { detail: invalid });
    if (db.sources.some((s) => s.name === body.name.trim())) {
      return json(409, { detail: "You already have a source with this name" });
    }
    const s: Source = {
      id: uuid(),
      kind: body.kind,
      name: body.name.trim(),
      connection_id: body.connection_id ?? null,
      config: normalizeLabels(body.kind, body.config ?? {}),
      status: "active",
      last_error: null,
      last_synced_at: null,
      created_at: now(),
      updated_at: now(),
      item_count: 0,
      connector_available: true,
      config_version: 1,
      unavailable_items: [],
      reconnect_reason: body.kind === "google_docs" ? (choice?.reconnect_reason ?? null) : null,
    };
    db.sources.push(s);
    return json(201, s);
  }
  if (p[2] === "coverage") {
    if (m !== "GET") return json(405, { detail: "Method not allowed" });
    if (p[3] === "company") {
      if (ctx.me.role !== "owner") return json(403, { detail: "Company coverage is for owners" });
      return json(200, companyCoverage(db, ctx));
    }
    const uses = ctx.uses();
    return json(200, { as_of: now(), sources: db.sources.map((s) => coverageOf(s, db.items, uses)) });
  }
  if (p[2] === "kinds") {
    return json(
      200,
      (Object.keys(PROVIDER) as Source["kind"][]).map((kind) => ({
        kind,
        provider: PROVIDER[kind],
        connector_available: AVAILABLE[kind],
        connections: PROVIDER[kind] ? (CONNECTIONS[PROVIDER[kind]!] ?? []).map(withEndpoint) : [],
      })),
    );
  }

  const s = db.sources.find((x) => x.id === p[2]);
  if (!s) return json(404, { detail: "Source not found" });
  const sub = p[3];
  if (!sub) {
    if (m === "DELETE") {
      db.sources = db.sources.filter((x) => x.id !== s.id);
      db.items = db.items.filter((i) => i.source_id !== s.id);
      return json(204, undefined);
    }
    if (m === "PATCH") {
      const patch = (await req.json()) as Schemas["SourcePatch"];
      // A form that loaded an older version is refused, nothing changed (as the API does).
      if (patch.base_version != null && patch.base_version !== s.config_version) {
        return json(409, {
          code: "source_changed",
          message: "This source changed since you opened it. Reload to see the current picks.",
        });
      }
      // A config or connection change says which version it read (owner 2026-10-20).
      if ((patch.config != null || "connection_id" in patch) && patch.base_version == null) {
        return json(422, {
          code: "base_version_required",
          message: "Say which version of the source you read (base_version); get it from the source.",
        });
      }
      const invalid = patch.config ? badConfig(s.kind, patch.config) : null;
      if (invalid) return json(422, { detail: invalid });
      const renamed = patch.name != null && patch.name.trim() !== s.name;
      const config = patch.config ? normalizeLabels(s.kind, patch.config) : null;
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const reconfigured = config != null && !same(selection(config), selection(s.config));
      // New names alone: stored, nothing else changes (no sweep; the "not read" list stays).
      const relabelled = config != null && !reconfigured && !same(config, s.config);
      // Only a save that changes something bumps the version (as the API does).
      if (renamed || reconfigured || relabelled) s.config_version += 1;
      if (patch.name) s.name = patch.name;
      if (config && relabelled) s.config = config;
      if (config && reconfigured) {
        s.config = config;
        if (s.kind === "google_docs") {
          const choice = Object.values(CONNECTIONS).flat().find((c) => c.id === s.connection_id);
          s.reconnect_reason = choice?.reconnect_reason ?? null;
          // Narrowing takes effect on save (S5, owner 2026-10-20): what left the picks is
          // deleted now, and what the last sync said about what is still picked stays.
          const picked = new Set([...pickedDrive(s, "docs"), ...pickedDrive(s, "folders")]);
          hideOutsidePicks(db, s);
          s.unavailable_items = (s.unavailable_items ?? []).filter((u) => picked.has(u.external_id));
        } else {
          sweep(db, s);
          s.unavailable_items = [];
        }
        // A changed selection takes a source in error or needing attention back to active.
        if (s.status === "error" || s.status === "needs_attention") {
          s.status = "active";
          s.last_error = null;
        }
      }
      s.updated_at = now();
    }
    return json(200, counted(db, s));
  }
  if (sub === "pause" || sub === "resume") {
    s.status = sub === "pause" ? "paused" : "active";
    if (sub === "resume") s.last_error = null;
    return json(200, counted(db, s));
  }
  if (sub === "sync") {
    if (s.kind === "upload") return json(409, { detail: "Upload sources have nothing to sync: upload files instead" });
    if (s.status === "paused") return json(409, { detail: "This source is paused: resume it first" });
    const broken = badConfig(s.kind, s.config);
    if (broken) {
      s.status = "needs_attention";
      s.last_error = `${broken[0].toUpperCase()}${broken.slice(1)}: edit this source to sync it again`;
      return json(200, { source_id: s.id, outcome: "needs_attention", upserted: 0, versions_written: 0, deleted: 0, checkpoints: 0, retry_after: null, error: s.last_error, source: counted(db, s) });
    }
    if (s.status === "error") {
      return json(200, { source_id: s.id, outcome: "error", upserted: 0, versions_written: 0, deleted: 0, checkpoints: 0, retry_after: null, error: s.last_error, source: counted(db, s) });
    }
    // Edited while it synced (MOCK_SYNC_SUPERSEDED_KEY): nothing kept, the source unchanged.
    if (localStorage.getItem(MOCK_SYNC_SUPERSEDED_KEY) === s.name) {
      localStorage.removeItem(MOCK_SYNC_SUPERSEDED_KEY);
      return json(200, { source_id: s.id, outcome: "superseded", upserted: 0, versions_written: 0, deleted: 0, checkpoints: 0, retry_after: null, error: null, source: counted(db, s) });
    }
    // Slack rate-limits the first sync of channel C0RATELIMIT after its first checkpoint:
    // what it stored is kept and the next sync resumes (and finishes).
    const channels = s.kind === "slack" ? ((s.config.channels as string[] | undefined) ?? []) : [];
    if (channels.includes(RATE_LIMITED_CHANNEL) && !s.partly_synced_at && !s.last_synced_at) {
      s.partly_synced_at = now();
      s.last_error = "Rate limited by slack; the next sync resumes (retry after 30s)";
      return json(200, { source_id: s.id, outcome: "rate_limited", upserted: 1, versions_written: 1, deleted: 0, checkpoints: 1, retry_after: 30, error: null, source: counted(db, s) });
    }
    s.last_synced_at = now();
    s.partly_synced_at = null;
    s.last_error = null;
    // A sync also deletes what left the picks (sources narrowed before narrowing took
    // effect on save).
    const deleted = s.kind === "google_docs" ? hideOutsidePicks(db, s) : 0;
    // S4 "draft-new-items" scenario: Product chat's sync brings in one new message.
    if (ctx.scenario === DRAFT_NEW_ITEMS_SCENARIO && s.id === PRODUCT_CHAT_ID && !db.items.some((i) => i.external_id === "m-new")) {
      db.items.push({
        id: uuid(),
        source_id: s.id,
        source_kind: s.kind,
        source_name: s.name,
        external_id: "m-new",
        kind: "message",
        title: "Alert thresholds",
        url: "https://example.com/m-new",
        author: "someone",
        acl: {},
        occurred_at: now(),
        source_updated_at: null,
        deleted_at: null,
        version_id: uuid(),
        fetched_at: now(),
        confidence: confidence(s.kind, 1),
        content: "Teams want to set their own alert thresholds.",
      });
    }
    // qa-onboarding-3: a source the mock holds nothing for (one just added) read nothing, and
    // says so, as Home's Pick sources does ("nothing read yet"): never "2 items seen" with none kept.
    const read = counted(db, s).item_count > 0;
    return json(200, { source_id: s.id, outcome: "completed", upserted: read ? 2 : 0, versions_written: read ? 1 : 0, deleted, checkpoints: 1, retry_after: null, error: null, source: counted(db, s) });
  }
  if (sub === "coverage" && m === "GET") {
    const limit = Number(q.get("limit") ?? 50);
    const offset = Number(q.get("offset") ?? 0);
    if (!(limit >= 1 && limit <= 100) || !(offset >= 0)) return json(422, { detail: "limit runs from 1 to 100" });
    return json(200, coverageDetail(s, db.items, ctx.uses(), limit, offset));
  }
  if (sub === "items") return json(200, db.items.filter((i) => i.source_id === s.id && !i.deleted_at).map(itemOut));
  if (sub === "uploads" && m === "POST") {
    if (s.kind !== "upload") return json(409, { detail: "Only upload sources take files" });
    const form = await req.formData();
    const out: Item[] = [];
    for (const f of form.getAll("files")) {
      if (typeof f === "string") continue;
      if (!/\.(md|markdown|txt|pdf)$/i.test(f.name)) {
        return json(422, { detail: `${f.name}: only .md, .txt and .pdf files can be uploaded` });
      }
      const content = f.name.toLowerCase().endsWith(".pdf") ? `PDF text of ${f.name}` : await f.text();
      db.items = db.items.filter((i) => !(i.source_id === s.id && i.external_id === f.name));
      const item: Item = {
        id: uuid(),
        source_id: s.id,
        source_kind: "upload",
        source_name: s.name,
        external_id: f.name,
        kind: "file",
        title: f.name,
        url: null,
        author: null,
        acl: { visibility: "owner" },
        occurred_at: null,
        source_updated_at: null,
        deleted_at: null,
        version_id: uuid(),
        fetched_at: now(),
        confidence: confidence("upload", 1),
        content,
      };
      db.items.push(item);
      out.push(item);
    }
    s.last_synced_at = now();
    return json(201, { items: out.map(itemOut), unchanged: [] });
  }
  return json(404, { detail: "Route not found" });
}

// --- coverage (A2) -----------------------------------------------------------------

// Freshness halves every N days per source kind or "kind:item kind" (oracle.confidence DEFAULTS).
const HALF_LIFE: Record<string, number> = {
  slack: 30,
  fireflies: 45,
  "github:issue": 60,
  "github:pull_request": 60,
  notion: 90,
  google_docs: 90,
  upload: 90,
  github: 180,
};
const halfLife = (sourceKind: string, itemKind: string) => HALF_LIFE[`${sourceKind}:${itemKind}`] ?? HALF_LIFE[sourceKind] ?? 90;
const DAY = 86_400_000;

/** The item's latest own timestamp, else its fetch (as the API's coverage reads it). */
function itemTime(i: Item): string | null {
  const own = [i.source_updated_at, i.occurred_at].filter((t): t is string => !!t).sort();
  return own.length ? own[own.length - 1] : (i.fetched_at ?? null);
}

type Tally = {
  items: number;
  removed: number;
  fresh: number;
  aging: number;
  newest_at: string | null;
  oldest_at: string | null;
  by_kind: Schemas["KindCoverage"][];
};

/** Live and removed items, and fresh (up to one half-life) or aging (up to two) live items. */
function tally(sourceKind: string, items: Item[]): Tally {
  const t: Tally = { items: 0, removed: 0, fresh: 0, aging: 0, newest_at: null, oldest_at: null, by_kind: [] };
  const kinds = new Map<string, Schemas["KindCoverage"]>();
  const at = Date.now();
  for (const i of items) {
    if (i.deleted_at) {
      t.removed += 1;
      continue;
    }
    t.items += 1;
    const hl = halfLife(sourceKind, i.kind);
    const k = kinds.get(i.kind) ?? { kind: i.kind, items: 0, newest_at: null, half_life_days: hl };
    k.items += 1;
    kinds.set(i.kind, k);
    const ts = itemTime(i);
    if (!ts) continue;
    if (!t.newest_at || ts > t.newest_at) t.newest_at = ts;
    if (!t.oldest_at || ts < t.oldest_at) t.oldest_at = ts;
    if (!k.newest_at || ts > k.newest_at) k.newest_at = ts;
    const age = (at - new Date(ts).getTime()) / DAY;
    if (age <= hl) t.fresh += 1;
    else if (age <= 2 * hl) t.aging += 1;
  }
  t.by_kind = [...kinds.values()].sort((a, b) => b.items - a.items || a.kind.localeCompare(b.kind));
  return t;
}

const freshness = (t: Tally) => ({ fresh: t.fresh, aging: t.aging, stale: t.items - t.fresh - t.aging });

function notRead(s: Source): Schemas["NotReadCounts"] {
  const counts = { skipped: 0, unavailable: 0, flagged: 0, limited: 0 };
  for (const u of s.unavailable_items ?? []) counts[u.status && u.status in counts ? u.status : "unavailable"] += 1;
  return counts;
}

function usesOf(s: Source, items: Item[], uses: UsedIn[]): UsedIn[] {
  const mine = new Set(items.filter((i) => i.source_id === s.id).map((i) => i.id));
  return uses.filter((u) => mine.has(u.item.id)).sort((a, b) => b.at.localeCompare(a.at));
}

function coverageOf(s: Source, items: Item[], uses: UsedIn[]): Schemas["SourceCoverage"] {
  const t = tally(s.kind, items.filter((i) => i.source_id === s.id));
  const used = usesOf(s, items, uses);
  const count = (kind: UsedIn["kind"]) => used.filter((u) => u.kind === kind).length;
  return {
    source_id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    last_synced_at: s.last_synced_at,
    items: t.items,
    removed: t.removed,
    not_read: notRead(s),
    newest_at: t.newest_at,
    oldest_at: t.oldest_at,
    freshness: freshness(t),
    used: {
      evidence: count("evidence"),
      citations: count("citation"),
      section_links: count("section_link"),
      documents: new Set(used.filter((u) => u.document).map((u) => u.document!.slug)).size,
    },
  };
}

function coverageDetail(s: Source, items: Item[], uses: UsedIn[], limit: number, offset: number): Schemas["SourceCoverageDetail"] {
  const used = usesOf(s, items, uses);
  return {
    ...coverageOf(s, items, uses),
    by_kind: tally(s.kind, items.filter((i) => i.source_id === s.id)).by_kind,
    not_read_items: (s.unavailable_items ?? []).map((u) => ({ ...u, name: u.name ?? null, status: u.status ?? "unavailable" })),
    used_in: used.slice(offset, offset + limit),
    used_in_total: used.length,
  };
}

/** Owners only: counts per active member and source kind, never a name, id or item. */
function companyCoverage(db: SourcesDb, ctx: SourcesContext): Schemas["CompanyCoverage"] {
  const active = ctx.members.filter((m) => !m.disabled);
  const rows = active.map((m) => {
    const own = m.email === ctx.me.email ? { sources: db.sources, items: db.items } : (db.team?.[m.email] ?? { sources: [], items: [] });
    const kinds = [...new Set(own.sources.map((s) => s.kind))].sort().map((kind) => {
      const sources = own.sources.filter((s) => s.kind === kind);
      const ids = new Set(sources.map((s) => s.id));
      const t = tally(kind, own.items.filter((i) => ids.has(i.source_id)));
      const synced = sources.map((s) => s.last_synced_at).filter((x): x is string => !!x).sort();
      return {
        kind,
        sources: sources.length,
        items: t.items,
        fresh_share: t.items ? Math.round((t.fresh / t.items) * 1000) / 1000 : null,
        freshness: freshness(t),
        last_synced_at: synced.length ? synced[synced.length - 1] : null,
      };
    });
    const items = kinds.reduce((n, k) => n + k.items, 0);
    const share = items ? kinds.reduce((n, k) => n + k.freshness.fresh, 0) / items : -1;
    return { member: { id: m.id, email: m.email, name: null, role: m.role }, kinds, order: [kinds.length ? 1 : 0, share] as const };
  });
  // Setup first (no source), then the lowest fresh share.
  rows.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.member.email.localeCompare(b.member.email));
  return {
    as_of: now(),
    members_total: active.length,
    members_with_sources: rows.filter((r) => r.kinds.length).length,
    members: rows.map(({ member, kinds }) => ({ member, kinds })),
  };
}
