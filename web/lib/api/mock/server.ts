/**
 * In-browser stand-in for the API, used when NEXT_PUBLIC_API_MOCKS=1. It is plugged
 * into openapi-fetch as its `fetch`, so pages call the typed client exactly as they
 * will against the real API. State lives in localStorage, so it survives reloads.
 */
import type { Schemas } from "@/lib/api/client";
import { sectionDiff } from "@/lib/diff";
import { plainText } from "@/lib/markdown";

import { DOCUMENTS, MOCK_LOGIN, type DocumentSeed, type VersionSeed } from "./fixtures";
import { routeSources, SOURCES_STORAGE_KEY } from "./sources";

type DocumentRow = Omit<Schemas["DocumentSummary"], "latest_version">;
type VersionRow = Omit<Schemas["VersionOut"], "sections"> & {
  sections: Omit<Schemas["SectionOut"], "verdict">[];
};
type CommentRow = Omit<Schemas["CommentOut"], "replies">;
type ReviewRow = Schemas["SectionReviewOut"];
type FeedbackRow = Schemas["FeedbackItemOut"];

interface Db {
  session: string | null;
  tenant_id: string;
  user_id: string;
  documents: DocumentRow[];
  versions: VersionRow[];
  comments: CommentRow[];
  reviews: ReviewRow[];
  feedback: FeedbackRow[];
}

const STORAGE_KEY = "po-mock-db-v1";
const LATENCY_MS = 60;

let counter = 0;
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  counter += 1;
  return `00000000-0000-4000-8000-${String(Date.now() + counter).padStart(12, "0").slice(-12)}`;
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const now = () => new Date().toISOString();

function buildVersion(doc: DocumentRow, seed: VersionSeed): VersionRow {
  const id = uuid();
  const sections = seed.sections.map((s, ordinal) => ({
    id: uuid(),
    section_key: s.key,
    ordinal,
    level: s.level,
    heading: s.heading,
    body_md: s.body,
    body_text: plainText(s.body),
    content_hash: hash(s.heading + "\n" + s.body),
    citation_keys: [...new Set([...s.body.matchAll(/\[c:([\w.-]+)\]/g)].map((m) => m[1]))],
  }));
  return {
    id,
    document_id: doc.id,
    number: seed.number,
    content_hash: hash(sections.map((s) => s.content_hash).join("")),
    snapshot: seed.snapshot ?? null,
    warnings: [],
    imported_by: "agent-track",
    approved_at: null,
    created_at: seed.created_at,
    front_matter: { document: doc.slug, title: doc.title, template: doc.template ?? undefined },
    sections,
    citations: seed.citations.map((c) => ({
      id: uuid(),
      cite_key: c.id,
      source: c.source,
      ref: c.ref,
      title: c.title,
      excerpt: c.excerpt,
      retrieved_at: c.retrieved_at,
    })),
  };
}

function seed(): Db {
  const db: Db = {
    session: null,
    tenant_id: uuid(),
    user_id: uuid(),
    documents: [],
    versions: [],
    comments: [],
    reviews: [],
    feedback: [],
  };
  const docs = new Map<string, DocumentRow>();
  for (const d of DOCUMENTS as DocumentSeed[]) {
    const last = d.versions[d.versions.length - 1];
    const row: DocumentRow = {
      id: uuid(),
      slug: d.slug,
      title: d.title,
      status: "draft",
      template: d.template ?? null,
      template_version: d.template_version ?? null,
      created_at: d.versions[0].created_at,
      updated_at: last.created_at,
    };
    db.documents.push(row);
    docs.set(d.slug, row);
    for (const v of d.versions) db.versions.push(buildVersion(row, v));
  }

  const ver = (slug: string, n: number) => findVersion(db, docs.get(slug)!, n)!;
  const at = (iso: string) => ({ created_at: iso });

  // Checkout redesign: v1 was reviewed, v2 answered that feedback.
  const c1 = ver("checkout-redesign", 1);
  addComment(db, c1, {
    section_key: "problem",
    anchor: {
      exact: "Most abandonment happens at the shipping step",
      prefix: "Buyers leave checkout when the total changes late in the flow. ",
      suffix: ", right after shipping cost appears",
    },
    body: "Can we put a number on this? A funnel figure would make the case much stronger.",
  }, at("2026-10-16T15:02:00Z"));
  addComment(db, c1, {
    section_key: "s-5-2",
    anchor: {
      exact: "Each option shows its price and delivery window",
      prefix: "Replace the free-text shipping options with three clear choices: standard, express and pickup. ",
      suffix: " before it is selected.",
    },
    body: "Which option is preselected? Defaulting to the cheapest one would match the cart estimate.",
  }, at("2026-10-16T15:10:00Z"));
  addReview(db, c1, "goal-trace", { verdict: "approved", note: "Clear link to G1." }, at("2026-10-16T15:20:00Z"));
  addReview(db, c1, "metrics", {
    verdict: "changes_requested",
    note: "Add a guardrail metric so we notice if a faster checkout increases refunds.",
  }, at("2026-10-16T15:24:00Z"));
  addReview(db, c1, "rollout", {
    verdict: "rejected",
    note: "Rollout belongs in the launch plan, not in this PRD.",
  }, at("2026-10-16T15:26:00Z"));
  const notes: Record<string, string> = {
    problem: "Added the September funnel numbers to §2.",
    "s-5-2": "The cheapest option is now preselected, see §5.2.",
    metrics: "Added a refund-rate guardrail and a stop rule.",
    rollout: "Removed; the rollout now lives in the launch plan.",
  };
  for (const f of db.feedback) {
    if (f.raised_on_version === 1 && f.document_id === c1.document_id && f.section_key && notes[f.section_key]) {
      Object.assign(f, {
        status: "addressed",
        addressed_in_version: 2,
        resolution_note: notes[f.section_key],
        updated_at: "2026-10-17T09:20:00Z",
      });
    }
  }
  addComment(db, ver("checkout-redesign", 2), {
    section_key: "s-5-3",
    anchor: {
      exact: "Choosing a card fills the form",
      prefix: "eir saved addresses as cards on the shipping step. ",
      suffix: " and recalculates the shipping options in place.",
    },
    body: "Should the most recently used address be selected by default?",
  }, at("2026-10-17T09:40:00Z"));
  docs.get("checkout-redesign")!.status = "in_review";

  // Team workspaces: an approved section changed in v2.
  const w1 = ver("team-workspaces", 1);
  addReview(db, w1, "roles", { verdict: "approved", note: null }, at("2026-10-12T16:00:00Z"));
  addReview(db, w1, "scope", { verdict: "approved", note: null }, at("2026-10-12T16:02:00Z"));
  ver("team-workspaces", 2).warnings = [
    {
      code: "locked_section_changed",
      message: "Sections approved in v1 changed in this version: scope",
      section_keys: ["scope"],
    },
  ];
  docs.get("team-workspaces")!.status = "in_review";

  // Usage alerts: fully approved.
  const a1 = ver("usage-alerts", 1);
  for (const s of a1.sections) addReview(db, a1, s.section_key, { verdict: "approved", note: null }, at("2026-10-03T10:00:00Z"));
  a1.approved_at = "2026-10-03T10:05:00Z";
  docs.get("usage-alerts")!.status = "approved";
  return db;
}

function load(): Db {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Db;
    } catch {
      // fall through to a fresh seed
    }
  }
  const db = seed();
  save(db);
  return db;
}

function save(db: Db) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

/** Drops all mock state (used by the "Reset mock data" control). */
export function resetMockData() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SOURCES_STORAGE_KEY);
}

// ---------------------------------------------------------------- domain helpers

function findDocument(db: Db, ref: string) {
  return db.documents.find((d) => d.slug === ref || d.id === ref);
}

function findVersion(db: Db, doc: DocumentRow, n: number) {
  return db.versions.find((v) => v.document_id === doc.id && v.number === n);
}

function docVersions(db: Db, doc: DocumentRow) {
  return db.versions.filter((v) => v.document_id === doc.id).sort((a, b) => a.number - b.number);
}

function summary(v: VersionRow): Schemas["VersionSummary"] {
  return {
    id: v.id,
    document_id: v.document_id,
    number: v.number,
    content_hash: v.content_hash,
    snapshot: v.snapshot,
    warnings: v.warnings,
    imported_by: v.imported_by,
    approved_at: v.approved_at,
    created_at: v.created_at,
  };
}

function documentSummary(db: Db, d: DocumentRow): Schemas["DocumentSummary"] {
  const vs = docVersions(db, d);
  return { ...d, latest_version: vs.length ? vs[vs.length - 1].number : null };
}

function latestReview(db: Db, versionId: string, key: string): ReviewRow | undefined {
  return db.reviews
    .filter((r) => r.version_id === versionId && r.section_key === key)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .pop();
}

function versionOut(db: Db, v: VersionRow): Schemas["VersionOut"] {
  return {
    ...v,
    sections: v.sections.map((s) => {
      const r = latestReview(db, v.id, s.section_key);
      return {
        ...s,
        verdict: r ? { verdict: r.verdict, note: r.note, reviewer_id: r.reviewer_id, created_at: r.created_at } : null,
      };
    }),
  };
}

function commentOut(db: Db, c: CommentRow): Schemas["CommentOut"] {
  return {
    ...c,
    replies: db.comments
      .filter((r) => r.parent_id === c.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => commentOut(db, r)),
  };
}

function truncate(text: string, n = 140) {
  return text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
}

function touch(db: Db, documentId: string) {
  const d = db.documents.find((x) => x.id === documentId);
  if (!d) return;
  d.updated_at = now();
  if (d.status === "draft") d.status = "in_review";
}

function addComment(db: Db, v: VersionRow, body: Schemas["CommentCreate"], opts?: { created_at?: string }) {
  const created_at = opts?.created_at ?? now();
  const feedbackId = uuid();
  const c: CommentRow = {
    id: uuid(),
    version_id: v.id,
    section_key: body.section_key,
    anchor: body.anchor,
    body: body.body,
    author_id: db.user_id,
    parent_id: null,
    resolved_at: null,
    created_at,
    feedback_item_id: feedbackId,
  };
  db.comments.push(c);
  db.feedback.push({
    id: feedbackId,
    document_id: v.document_id,
    raised_on_version: v.number,
    kind: "comment",
    comment_id: c.id,
    section_key: body.section_key,
    summary: truncate(body.body),
    anchor: body.anchor,
    verdict: null,
    status: "open",
    addressed_in_version: null,
    resolution_note: null,
    created_at,
    updated_at: created_at,
  });
  return c;
}

function addReview(
  db: Db,
  v: VersionRow,
  key: string,
  body: Schemas["SectionReviewIn"],
  opts?: { created_at?: string },
): ReviewRow {
  const created_at = opts?.created_at ?? now();
  // As the API does: a later verdict on the same section supersedes the open verdict
  // items raised on this or an earlier version.
  for (const f of db.feedback) {
    if (
      f.kind === "section_review" &&
      f.document_id === v.document_id &&
      f.raised_on_version <= v.number &&
      f.section_key === key &&
      f.status === "open"
    ) {
      f.status = "superseded";
      f.resolution_note = `Superseded by a later '${body.verdict}' verdict on version ${v.number}`;
      f.updated_at = created_at;
    }
  }
  const r: ReviewRow = {
    id: uuid(),
    version_id: v.id,
    section_key: key,
    verdict: body.verdict,
    note: body.note ?? null,
    reviewer_id: db.user_id,
    created_at,
    feedback_item_id: null,
  };
  if (body.verdict !== "approved") {
    const heading = v.sections.find((s) => s.section_key === key)?.heading ?? key;
    r.feedback_item_id = uuid();
    db.feedback.push({
      id: r.feedback_item_id,
      document_id: v.document_id,
      raised_on_version: v.number,
      kind: "section_review",
      comment_id: null,
      section_review_id: r.id,
      section_key: key,
      summary: truncate(
        body.note?.trim() || `${body.verdict === "rejected" ? "Rejected" : "Changes requested on"} ${heading}`,
      ),
      anchor: null,
      verdict: body.verdict,
      status: "open",
      addressed_in_version: null,
      resolution_note: null,
      created_at,
      updated_at: created_at,
    });
  }
  db.reviews.push(r);
  return r;
}

function lockedKeys(db: Db, v: VersionRow): string[] {
  return v.sections
    .filter((s) => latestReview(db, v.id, s.section_key)?.verdict === "approved")
    .map((s) => s.section_key);
}

function versionMarkdown(doc: DocumentRow, v: VersionRow): string {
  const cites = v.citations
    .map(
      (c) =>
        `  - id: ${c.cite_key}\n    source: ${c.source}\n    ref: ${c.ref}\n    title: ${JSON.stringify(c.title ?? "")}\n    excerpt: ${JSON.stringify(c.excerpt ?? "")}`,
    )
    .join("\n");
  const head = `---\ndocument: ${doc.slug}\ntitle: ${doc.title}\n${v.snapshot ? `snapshot: ${v.snapshot}\n` : ""}citations:\n${cites || "  []"}\n---\n`;
  const body = v.sections
    .map((s) => `${"#".repeat(s.level)} ${s.heading} {#${s.section_key}}\n\n${s.body_md}\n`)
    .join("\n");
  return `${head}\n${body}`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function banner(doc: DocumentRow, v: VersionRow) {
  const status = v.approved_at ? "approved" : doc.status;
  return `${doc.title} · version ${v.number} · ${status} · ${(v.approved_at ?? v.created_at).slice(0, 10)}`;
}

function exportHtml(doc: DocumentRow, v: VersionRow): string {
  const sections = v.sections
    .map((s) => {
      const tag = `h${Math.min(s.level, 3)}`;
      const paras = s.body_text
        .split(/\n\n+/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      return `<section id="${s.section_key}"><${tag}>${escapeHtml(s.heading)}</${tag}>${paras}</section>`;
    })
    .join("\n");
  const notes = v.citations
    .map((c) => `<li><a href="${escapeHtml(c.ref)}">${escapeHtml(c.title ?? c.ref)}</a> (${c.source})</li>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)} v${v.number}</title></head><body><p class="banner">${escapeHtml(banner(doc, v))} · mock export</p>${sections}<ol class="citations">${notes}</ol></body></html>`;
}

/** A tiny single-page PDF (Helvetica, ASCII only) so the download flow can be exercised. */
function exportPdf(doc: DocumentRow, v: VersionRow): string {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1");
  const lines = [banner(doc, v), "Mock export: the API renders the real PDF.", "", ...v.sections.map((s) => s.heading)];
  const text = lines.map((l, i) => `${i ? "T* " : ""}(${ascii(l)}) Tj`).join("\n");
  const stream = `BT /F1 11 Tf 16 TL 72 740 Td\n${text}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

// ---------------------------------------------------------------- routing

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

const notFound = (what: string) => json(404, { detail: `${what} not found` });

async function route(db: Db, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const q = url.searchParams;
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (p[0] === "healthz") return json(200, { status: "ok", database: "mock" });
  if (p[0] !== "v1") return notFound("Route");

  if (p[1] === "auth" && p[2] === "login" && m === "POST") {
    const { email, password } = await body<Schemas["LoginRequest"]>();
    if (email.trim().toLowerCase() !== MOCK_LOGIN.email || password !== MOCK_LOGIN.password) {
      return json(401, { detail: "Invalid credentials" });
    }
    db.session = email;
    return json(200, { kind: "user", tenant_id: db.tenant_id, user_id: db.user_id, email, role: "owner" });
  }
  if (p[1] === "auth" && p[2] === "logout" && m === "POST") {
    db.session = null;
    return json(204, undefined);
  }
  if (!db.session) return json(401, { detail: "Not authenticated" });
  if (p[1] === "me") return json(200, { kind: "user", tenant_id: db.tenant_id, user_id: db.user_id, email: db.session, role: "owner" });

  if (["sources", "source-items", "snapshots", "search"].includes(p[1])) return routeSources(req, p, q);

  if (p[1] === "comments" && p[2]) {
    const c = db.comments.find((x) => x.id === p[2]);
    if (!c) return notFound("Comment");
    if (p[3] === "replies" && m === "POST") {
      const { body: text } = await body<Schemas["ReplyCreate"]>();
      const r: CommentRow = {
        id: uuid(),
        version_id: c.version_id,
        section_key: c.section_key,
        anchor: null,
        body: text,
        author_id: db.user_id,
        parent_id: c.id,
        resolved_at: null,
        created_at: now(),
        feedback_item_id: null,
      };
      db.comments.push(r);
      return json(201, commentOut(db, r));
    }
    if (m === "PATCH") {
      const patch = await body<Schemas["CommentPatch"]>();
      if (patch.resolved != null) c.resolved_at = patch.resolved ? now() : null;
      if (patch.body != null) c.body = patch.body;
      return json(200, commentOut(db, c));
    }
  }

  if (p[1] === "feedback" && p[2] && m === "PATCH") {
    const f = db.feedback.find((x) => x.id === p[2]);
    if (!f) return notFound("Feedback item");
    Object.assign(f, await body<Schemas["FeedbackPatch"]>(), { updated_at: now() });
    return json(200, f);
  }

  if (p[1] !== "documents") return notFound("Route");
  if (p.length === 2) return json(200, db.documents.map((d) => documentSummary(db, d)));

  const doc = findDocument(db, p[2]);
  if (!doc) return notFound("Document");
  if (p.length === 3) {
    return json(200, { ...documentSummary(db, doc), versions: docVersions(db, doc).map(summary) });
  }

  if (p[3] === "diff") {
    const from = findVersion(db, doc, Number(q.get("from")));
    const to = findVersion(db, doc, Number(q.get("to")));
    if (!from || !to) return notFound("Version");
    return json(200, {
      document_id: doc.id,
      from_version: from.number,
      to_version: to.number,
      sections: sectionDiff(from.sections, to.sections),
    });
  }

  if (p[3] === "feedback") {
    const status = q.get("status");
    const version = q.get("version");
    const items = db.feedback
      .filter((f) => f.document_id === doc.id)
      .filter((f) => !status || f.status === status)
      .filter((f) => !version || f.raised_on_version === Number(version))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json(200, items);
  }

  if (p[3] !== "versions") return notFound("Route");
  if (p.length === 4) {
    if (m === "GET") return json(200, docVersions(db, doc).map(summary));
    return json(501, { detail: "Importing drafts is not available in mock mode" });
  }

  const v = findVersion(db, doc, Number(p[4]));
  if (!v) return notFound("Version");
  const sub = p[5];

  if (!sub) return json(200, versionOut(db, v));
  if (sub === "markdown") {
    return new Response(versionMarkdown(doc, v), { headers: { "content-type": "text/markdown" } });
  }
  if (sub === "comments") {
    if (m === "POST") {
      const input = await body<Schemas["CommentCreate"]>();
      if (!v.sections.some((s) => s.section_key === input.section_key)) return notFound("Section");
      const c = addComment(db, v, input);
      touch(db, doc.id);
      return json(201, commentOut(db, c));
    }
    return json(
      200,
      db.comments
        .filter((c) => c.version_id === v.id && !c.parent_id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((c) => commentOut(db, c)),
    );
  }
  if (sub === "sections" && p[7] === "review" && m === "PUT") {
    if (!v.sections.some((s) => s.section_key === p[6])) return notFound("Section");
    const r = addReview(db, v, p[6], await body<Schemas["SectionReviewIn"]>());
    touch(db, doc.id);
    return json(200, r);
  }
  if (sub === "feedback-package") {
    return json(200, {
      document_id: doc.id,
      slug: doc.slug,
      title: doc.title,
      version: v.number,
      markdown: versionMarkdown(doc, v),
      open_items: db.feedback.filter(
        (f) => f.document_id === doc.id && f.status === "open" && f.raised_on_version <= v.number,
      ),
      locked_section_keys: lockedKeys(db, v),
      generated_at: now(),
    });
  }
  if (sub === "resolution-report") {
    const items = db.feedback.filter((f) => f.document_id === doc.id && f.raised_on_version < v.number);
    const counts: Record<string, number> = {};
    for (const f of items) counts[f.status] = (counts[f.status] ?? 0) + 1;
    return json(200, { document_id: doc.id, version: v.number, items, counts });
  }
  if (sub === "approve" && m === "POST") {
    v.approved_at = now();
    doc.status = "approved";
    doc.updated_at = v.approved_at;
    return json(200, { document_id: doc.id, document_status: doc.status, version: summary(v) });
  }
  if (sub === "export") {
    const format = q.get("format") ?? "html";
    if (format === "md") {
      return new Response(`<!-- ${banner(doc, v)} -->\n${versionMarkdown(doc, v)}`, {
        headers: { "content-type": "text/markdown" },
      });
    }
    if (format === "pdf") return new Response(exportPdf(doc, v), { headers: { "content-type": "application/pdf" } });
    return new Response(exportHtml(doc, v), { headers: { "content-type": "text/html" } });
  }
  return notFound("Route");
}

export async function mockFetch(req: Request): Promise<Response> {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  const db = load();
  const res = await route(db, req);
  save(db);
  return res;
}
