/**
 * Mock of the sources API (Lane B1): the signed-in user's sources, sync, uploads,
 * items, snapshots and search. Confidence is a fixed table rather than the real
 * scoring, so the UI's badge and breakdown can be exercised.
 */
import type { Schemas } from "@/lib/api/client";
import { mockUuid, seeded } from "./ids";

type Source = Schemas["SourceOut"];
type Item = Schemas["ItemOut"] & { content: string; source_name: string };
type Confidence = Schemas["ConfidenceOut"];

interface SourcesDb {
  sources: Source[];
  items: Item[];
  snapshots: Schemas["SnapshotOut"][];
}

export const SOURCES_STORAGE_KEY = "po-mock-sources-v1";

const CONNECTIONS: Record<string, Schemas["ConnectionChoice"][]> = {
  slack: [{ id: "c0000000-0000-4000-8000-000000000001", account_label: "Example Co chat", status: "active" }],
  github: [{ id: "c0000000-0000-4000-8000-000000000002", account_label: "example-org", status: "active" }],
  notion: [],
  fireflies: [],
  google: [],
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
  notion: false,
  fireflies: false,
  google_docs: false,
};
// Source factor per kind, as in oracle.confidence DEFAULTS.
const SOURCE_FACTOR: Record<string, number> = { github: 0.85, upload: 0.7, notion: 0.7, slack: 0.5 };

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
  };
  const item = (source: Source, external_id: string, kind: string, title: string, content: string, freshness: number): Item => ({
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
  });
  return {
    sources: [chat, repo],
    items: [
      item(repo, "readme", "readme", "README", "The onboarding checklist guides new accounts through setup in five steps.", 0.95),
      item(chat, "m1", "message", "Customer question", "Customers keep asking whether the onboarding checklist can be skipped.", 0.4),
      item(chat, "m2", "message", "Pricing thread", "Annual pricing gets a discount for teams above ten seats.", 0.9),
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
  return seeded("sources", seed);
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

/** Handles /v1/sources*, /v1/source-items*, /v1/snapshots* and /v1/search. */
/** The API's date range check (Slack's `{since, until}`), as the connector words it. */
function badRange(config: Record<string, unknown>): string | null {
  const { since, until } = config;
  if (typeof since === "string" && typeof until === "string" && until < since) return "until must be on or after since";
  return null;
}

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
    const invalid = badRange(body.config ?? {});
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
      const invalid = patch.config ? badRange(patch.config) : null;
      if (invalid) return json(422, { detail: invalid });
      if (patch.name) s.name = patch.name;
      if (patch.config) s.config = patch.config;
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
    if (s.status === "error") {
      return json(200, { source_id: s.id, outcome: "error", upserted: 0, versions_written: 0, deleted: 0, checkpoints: 0, retry_after: null, error: s.last_error, source: counted(db, s) });
    }
    s.last_synced_at = now();
    return json(200, { source_id: s.id, outcome: "completed", upserted: 2, versions_written: 1, deleted: 0, checkpoints: 1, retry_after: null, error: null, source: counted(db, s) });
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
