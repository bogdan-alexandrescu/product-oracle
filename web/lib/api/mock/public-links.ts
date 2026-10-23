/**
 * Mock of public-link evidence (POST /v1/baseline/evidence/link, .../link/preview,
 * /v1/baseline/evidence/{id}/refresh). No page is fetched: links resolve against a few
 * made-up pages, with the API's refusals (not https, private address, not public).
 * Commenters and up may use it, as in the API.
 */
import type { Schemas } from "@/lib/api/client";

import { scored, type BaselineCaller, type BaselineState } from "./baseline";

type Kind = Schemas["LinkPreviewOut"]["kind"];
type Page = { url: string; kind: Kind; title: string; text: string; last_modified: string | null };
type Refusal = { status: number; code: string; detail: string };

const ROLE_ORDER = ["viewer", "commenter", "approver", "owner"] as const;
const SOURCE: Record<Kind, number> = { notion: 0.7, google_docs: 0.7, web: 0.55 };
const HALF_LIFE_DAYS: Record<Kind, number> = { notion: 90, google_docs: 90, web: 90 };
const NOT_PUBLIC =
  "This link is not public: the page asks for a sign-in. Share it publicly (a public Notion page, or a Google Doc shared with anyone with the link) and try again.";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (r: Refusal) => json(r.status, { detail: r.detail, code: r.code });

/** The made-up page behind a link, or why it cannot be used. */
function resolve(raw: string): Page | Refusal {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { status: 422, code: "invalid_url", detail: "That is not a valid URL." };
  }
  if (u.protocol !== "https:") return { status: 422, code: "not_https", detail: "Only https:// links can be added as evidence." };
  const host = u.hostname.toLowerCase();
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(host) || host.endsWith(".internal")) {
    return {
      status: 422,
      code: "blocked_address",
      detail: "This link points to a private, local or internal network address, which Product Oracle does not fetch.",
    };
  }
  if (/private|login|signin/i.test(u.pathname)) return { status: 422, code: "not_public", detail: NOT_PUBLIC };
  u.hash = "";
  const url = u.toString();
  if (host === "docs.google.com") {
    if (!u.pathname.startsWith("/document/")) {
      return {
        status: 422,
        code: "unsupported_link",
        detail: "Only Google Docs documents can be added from docs.google.com (not Sheets, Slides or Forms).",
      };
    }
    return {
      url,
      kind: "google_docs",
      title: "Pricing page refresh",
      text: "Pricing page refresh. Goal: raise trial-to-paid conversion from 4% to 6% by Q2. Visitors compare plans on mobile; the table is unreadable there.",
      last_modified: null,
    };
  }
  if (host === "notion.so" || host === "www.notion.so" || host.endsWith(".notion.site")) {
    return {
      url,
      kind: "notion",
      title: "Onboarding research summary",
      text: "We interviewed 24 new accounts in September about their first week. 17 of 24 asked for a guided setup that connects their first data source.",
      last_modified: null,
    };
  }
  return {
    url,
    kind: "web",
    title: "Why activation beats acquisition",
    text: "Teams that fixed their first-week experience grew twice as fast as teams that spent the same on ads.",
    last_modified: "2026-09-15T10:30:00Z",
  };
}

function score(s: BaselineState, entityId: string | null, edgeId: string | null, page: Page, fetchedAt: string) {
  const rows = s.evidence.filter((e) => (entityId ? e.entity_id === entityId : e.edge_id === edgeId));
  const keys = new Set(rows.map((r) => (r.source_item ? `item:${r.source_item.id}` : r.kind ? `link:${r.url}` : null)));
  keys.delete(null);
  keys.add(`link:${page.url}`);
  const latest = page.last_modified ?? fetchedAt;
  const age = Math.max(0, (Date.parse(fetchedAt) - Date.parse(latest)) / 86_400_000);
  const freshness = Math.max(0.2, 0.5 ** (age / HALF_LIFE_DAYS[page.kind]));
  const supports = s.edges.some((e) => e.src_id === entityId && e.type === "supports");
  const r = scored(
    {
      source: SOURCE[page.kind],
      freshness: Math.round(freshness * 1000) / 1000,
      mentions: 1 - 0.5 ** keys.size,
      goal_impact: supports ? 0.85 : 0.5,
    },
    latest,
  );
  return { ...r, scored_at: fetchedAt };
}

/** Handles the link routes, or returns null for any other baseline route. */
export async function routeEvidenceLinks(
  s: BaselineState,
  caller: BaselineCaller,
  req: Request,
  rest: string[],
): Promise<Response | null> {
  const [head, id, action] = rest;
  const isLink = head === "evidence" && req.method === "POST" && (id === "link" || action === "refresh");
  if (!isLink) return null;
  if (ROLE_ORDER.indexOf(caller.role) < ROLE_ORDER.indexOf("commenter")) {
    return json(403, { detail: "Requires the commenter role" });
  }
  const fetchedAt = new Date().toISOString();

  if (action === "refresh") {
    const ev = s.evidence.find((e) => e.id === id);
    if (!ev) return json(404, { detail: "Evidence not found" });
    if (!ev.kind || !ev.url) return json(422, { detail: "Only evidence added from a public link can be refreshed" });
    const page = resolve(ev.url);
    if ("code" in page) return refuse(page);
    Object.assign(ev, score(s, ev.entity_id ?? null, ev.edge_id ?? null, page, fetchedAt), {
      retrieved_at: fetchedAt,
      link: { ...ev.link!, fetched_at: fetchedAt },
    });
    return json(200, ev);
  }

  const body = JSON.parse((await req.text()) || "{}") as Schemas["EvidenceLinkCreate"];
  const entityId = body.entity_id ?? null;
  const edgeId = body.edge_id ?? null;
  if (!entityId === !edgeId) return json(422, { detail: "pass exactly one of entity_id or edge_id" });
  if (entityId && !s.entities.some((e) => e.id === entityId)) return json(404, { detail: "Entity not found" });
  if (edgeId && !s.edges.some((e) => e.id === edgeId)) return json(404, { detail: "Edge not found" });
  const page = resolve(body.url);
  if ("code" in page) return refuse(page);
  const cited = s.evidence.some(
    (e) => e.kind && e.url === page.url && (entityId ? e.entity_id === entityId : e.edge_id === edgeId),
  );
  const result = score(s, entityId, edgeId, page, fetchedAt);
  const excerpt = page.text.slice(0, 500);

  if (action === "preview") {
    const out: Schemas["LinkPreviewOut"] = {
      url: page.url,
      kind: page.kind,
      final_url: page.url,
      title: page.title,
      excerpt,
      fetched_at: fetchedAt,
      last_modified: page.last_modified,
      confidence: result.confidence,
      confidence_factors: result.confidence_factors,
      already_cited: cited,
    };
    return json(200, out);
  }
  if (cited) return json(409, { detail: "This link is already cited here; refresh it instead." });
  const row: Schemas["EvidenceOut"] = {
    id: crypto.randomUUID(),
    entity_id: entityId,
    edge_id: edgeId,
    url: page.url,
    excerpt,
    ref: page.title,
    retrieved_at: fetchedAt,
    source_kind: page.kind,
    source_item: null,
    source_item_private: false,
    source_removed: false,
    ...result,
    created_at: fetchedAt,
    kind: page.kind,
    note: body.note?.trim() || null,
    link: {
      kind: page.kind,
      final_url: page.url,
      title: page.title,
      fetched_at: fetchedAt,
      last_modified: page.last_modified,
      text_chars: page.text.length,
    },
  };
  s.evidence.push({ ...row, added_by: caller.userId });
  // The entity's confidence: independent support raises it (confidence.aggregate).
  const target = s.entities.find((e) => e.id === entityId);
  if (target) {
    const scores = s.evidence.filter((e) => e.entity_id === target.id).map((e) => e.confidence ?? 0);
    target.confidence = Math.round((1 - scores.reduce((p, c) => p * (1 - c), 1)) * 1000) / 1000;
  }
  return json(201, row);
}
