/**
 * Mock of the sources API (Lane B1): the signed-in user's sources, sync, uploads,
 * items, snapshots and search. Confidence is a fixed table rather than the real
 * scoring, so the UI's badge and breakdown can be exercised.
 */
import type { Schemas } from "@/lib/api/client";
import { FIREFLIES_CONNECTION_ID } from "./fireflies";
import { mockUuid, seeded } from "./ids";
import { MOCK_NOTION_CONNECTION_ID } from "./notion";

type Source = Schemas["SourceOut"];
// `folder`: the picked Drive folder a Google Doc came from (mock only).
type Item = Schemas["ItemOut"] & { content: string; source_name: string; folder?: string };
type Confidence = Schemas["ConfidenceOut"];

interface SourcesDb {
  sources: Source[];
  items: Item[];
  snapshots: Schemas["SnapshotOut"][];
}

export const SOURCES_STORAGE_KEY = "po-mock-sources-v2";

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

function seed(): SourcesDb {
  const chat: Source = {
    id: "50000000-0000-4000-8000-000000000001",
    kind: "slack",
    name: "Product chat",
    connection_id: CONNECTIONS.slack[0].id,
    config: { channels: ["C0123PRODUCT", "C0456FEEDBACK"] },
    status: "active",
    last_error: null,
    last_synced_at: "2026-10-17T08:00:00Z",
    created_at: "2026-10-10T09:00:00Z",
    updated_at: "2026-10-17T08:00:00Z",
    item_count: 2,
    connector_available: true,
    config_version: 1,
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
    folder?: string,
  ): Item => ({
    id: uuid(),
    source_id: source.id,
    source_kind: source.kind,
    source_name: source.name,
    external_id,
    kind,
    title,
    url: `https://example.com/${external_id}`,
    author: "someone",
    acl: {},
    occurred_at: "2026-10-14T10:00:00Z",
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
      item(repo, "readme", "readme", "README", "The onboarding checklist guides new accounts through setup in five steps.", 0.95),
      item(chat, "m1", "message", "Customer question", "Customers keep asking whether the onboarding checklist can be skipped.", 0.4),
      item(chat, "m2", "message", "Pricing thread", "Annual pricing gets a discount for teams above ten seats.", 0.9),
      item(docs, "1DocPricingExample", "doc", "Pricing strategy", "Annual plans get two months free.", 0.9),
      item(docs, "1DocActivationExample", "doc", "Activation v2 PRD", "New accounts finish setup in under 3 minutes.", 0.8),
      item(docs, "1DocCheckoutSpecExample", "doc", "Checkout spec", "Guests can check out without an account.", 0.8, "1FolderSpecsExample"),
    ],
    snapshots: [],
  };
}

function load(): SourcesDb {
  const raw = localStorage.getItem(SOURCES_STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as SourcesDb;
    } catch {
      // fall through to a fresh seed
    }
  }
  // A new company (the "empty" scenario) has picked no sources yet.
  if (localStorage.getItem("po-mock-scenario") === "empty") return { sources: [], items: [], snapshots: [] };
  return seeded("sources", seed);
}

/** How many sources there are (A1's Pick sources step). */
export function sourceCount(): number {
  return load().sources.length;
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

/** Narrowing takes effect on save (S5, owner 2026-10-20), as the API's
 * update_source does: stored items outside the new channels, repos or date range are
 * soft-deleted at once. */
function sweep(db: SourcesDb, s: Source) {
  const config = s.config as Record<string, unknown>;
  const groups = s.kind === "slack" ? config.channels : s.kind === "github" ? config.repos : null;
  const allowed = Array.isArray(groups) ? new Set(groups.map((g) => String(g).toLowerCase())) : null;
  const from = s.kind === "slack" && typeof config.since === "string" ? `${config.since}T00:00:00Z` : null;
  for (const item of db.items) {
    if (item.source_id !== s.id || item.deleted_at) continue;
    const group = item.external_id.includes(":") ? item.external_id.split(":")[0].toLowerCase() : null;
    const outside = (allowed && group !== null && !allowed.has(group)) || (from && item.occurred_at && item.occurred_at < from);
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
  // As the real connector reads a Notion allowlist: "roots" only.
  if (kind === "notion") {
    return Array.isArray(config.roots) && config.roots.length ? null : "allowlist at least one root page or database";
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

export async function routeSources(req: Request, p: string[], q: URLSearchParams): Promise<Response> {
  const db = load();
  const res = await route(db, req, p, q);
  localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(db));
  return res;
}

async function route(db: SourcesDb, req: Request, p: string[], q: URLSearchParams): Promise<Response> {
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
      config: body.config ?? {},
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
  if (p[2] === "kinds") {
    return json(
      200,
      (Object.keys(PROVIDER) as Source["kind"][]).map((kind) => ({
        kind,
        provider: PROVIDER[kind],
        connector_available: AVAILABLE[kind],
        connections: PROVIDER[kind] ? (CONNECTIONS[PROVIDER[kind]!] ?? []) : [],
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
      const reconfigured =
        patch.config != null && JSON.stringify(patch.config) !== JSON.stringify(s.config);
      // Only a save that changes something bumps the version (as the API does).
      if (renamed || reconfigured) s.config_version += 1;
      if (patch.name) s.name = patch.name;
      if (patch.config) {
        s.config = patch.config;
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
    s.last_synced_at = now();
    // A sync also deletes what left the picks (sources narrowed before narrowing took
    // effect on save).
    const deleted = s.kind === "google_docs" ? hideOutsidePicks(db, s) : 0;
    return json(200, { source_id: s.id, outcome: "completed", upserted: 2, versions_written: 1, deleted, checkpoints: 1, retry_after: null, error: null, source: counted(db, s) });
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
