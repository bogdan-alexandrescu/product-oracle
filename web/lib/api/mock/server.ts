/**
 * In-browser stand-in for the API, used when NEXT_PUBLIC_API_MOCKS=1. It is plugged
 * into openapi-fetch as its `fetch`, so pages call the typed client exactly as they
 * will against the real API. State lives in localStorage, so it survives reloads.
 */
import type { Schemas } from "@/lib/api/client";
import { sectionDiff } from "@/lib/diff";
import { plainText } from "@/lib/markdown";

import { routeBaseline, seedBaseline, type BaselineState } from "./baseline";
import { deckOut, LAYER_FORMATS, PPTX_TYPE, presenterNotes, resolveBrief } from "./brief";
import { claudeAccountsRoute } from "./claude-accounts";
import { connectionsRoute } from "./connections";
import { DOCUMENTS, MOCK_INVITES, MOCK_LOGIN, MOCK_MEMBERS, roadmapFromPrd, type DocumentSeed, type VersionSeed } from "./fixtures";
import { laneF, type LaneFState } from "./lane-f";
import { llmJobsRoute, onFeedback, seedLlm, tick, withSuggestion, type LlmContext, type LlmDb } from "./llm-jobs";
import { routeModules, seedModules, type ModulesDb } from "./modules";
import { routeRuns, seedRuns, type RunsContext, type RunsDb } from "./runs";
import { routeSources, SOURCES_STORAGE_KEY } from "./sources";
import { routeQuality, seedQuality, type QualityDb } from "./quality";
import { routeV2, seedV2, type V2Db } from "./v2";

/** latest_version, approved_version and source are read off the versions. */
export type DocumentRow = Omit<Schemas["DocumentSummary"], "latest_version" | "approved_version" | "source">;
export type VersionRow = Omit<Schemas["VersionOut"], "sections"> & {
  sections: Omit<Schemas["SectionOut"], "verdict">[];
};
type CommentRow = Omit<Schemas["CommentOut"], "replies">;
type ReviewRow = Schemas["SectionReviewOut"];
type FeedbackRow = Schemas["FeedbackItemOut"];
type MemberRow = Schemas["MemberOut"];
type InviteRow = Schemas["InviteOut"];
type Role = MemberRow["role"];

export interface Db {
  /** Email of the signed-in mock member. */
  session: string | null;
  tenant_id: string;
  /** The seed owner (admin@example.com): author of the seeded comments and verdicts. */
  user_id: string;
  members: MemberRow[];
  invites: InviteRow[];
  documents: DocumentRow[];
  versions: VersionRow[];
  comments: CommentRow[];
  reviews: ReviewRow[];
  feedback: FeedbackRow[];
  baseline: BaselineState;
  /** Priorities, templates, themes and draft defaults (lane-f.ts), seeded on first use. */
  lane_f?: LaneFState;
  /** Runs, checkpoints and their artifacts (./runs.ts); absent in data saved before runs existed. */
  runs?: RunsDb;
  /** Built-in model jobs and suggestions (./llm-jobs.ts); absent in older saved data. */
  llm?: LlmDb;
  /** Product Oracle v2 tables (./v2.ts); absent in data saved before v2. */
  v2?: V2Db;
  /** Outcome records and learnings (./quality.ts); absent in data saved before CR-08. */
  quality?: QualityDb;
  /** Module catalogue and compositions (./modules.ts); absent in older saved data. */
  modules?: ModulesDb;
  /** Per-user preferences (O1f document_view), by member email. */
  preferences?: Record<string, Schemas["Preferences"]>;
}

const STORAGE_KEY = "po-mock-db-v2";
/** Tests set this localStorage key (viewer, commenter, approver) to act with another role. */
export const MOCK_ROLE_KEY = "po-mock-role";
const ROLES: readonly Schemas["Me"]["role"][] = ["viewer", "commenter", "approver", "owner"];

/** The signed-in member, with the role overridden when a test set MOCK_ROLE_KEY. */
function withMockRole<T extends { role: Schemas["Me"]["role"] }>(member: T): T {
  const role = localStorage.getItem(MOCK_ROLE_KEY) as Schemas["Me"]["role"] | null;
  return role && ROLES.includes(role) ? { ...member, role } : member;
}
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
  const layered = resolveBrief(seed.sections.map((s) => ({ section_key: s.key, level: s.level })), seed.brief);
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
    layer: layered.brief.has(s.key) ? ("brief" as const) : ("detail" as const),
    notes: layered.brief.has(s.key) ? presenterNotes(s.body) : null,
  }));
  return {
    id,
    brief_source: layered.brief_source,
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
    members: [],
    invites: [],
    documents: [],
    versions: [],
    comments: [],
    reviews: [],
    feedback: [],
    baseline: seedBaseline(uuid),
  };
  db.members = MOCK_MEMBERS.map((m) => ({ ...m, id: m.email === MOCK_LOGIN.email ? db.user_id : uuid() }));
  db.invites = MOCK_INVITES.map((i) => ({
    ...i,
    id: uuid(),
    status: "open",
    invited_by: db.user_id,
    accepted_at: null,
    revoked_at: null,
  }));
  const docs = new Map<string, DocumentRow>();
  for (const d of DOCUMENTS as DocumentSeed[]) {
    const last = d.versions[d.versions.length - 1];
    const row: DocumentRow = {
      id: uuid(),
      slug: d.slug,
      title: d.title,
      status: "draft",
      kind: d.kind ?? "prd",
      template: d.template ?? null,
      template_version: d.template_version ?? null,
      theme: d.theme ?? null,
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
  // Review comments on v2, which Oracle's review job has already handled (./llm-jobs.ts).
  const w2 = ver("team-workspaces", 2);
  addComment(db, w2, {
    section_key: "problem",
    anchor: { exact: "Requests for shared editing come up in most sales conversations", prefix: "around. ", suffix: " with teams" },
    body: "Say how many teams asked for this; a number would make the case.",
  }, at("2026-10-13T10:50:00Z"));
  addComment(db, w2, {
    section_key: "problem",
    anchor: { exact: "People share work by exporting files", prefix: "", suffix: " and sending" },
    body: "Can we quantify the demand from the sales calls?",
  }, at("2026-10-13T10:55:00Z"));
  addComment(db, w2, {
    section_key: "roles",
    anchor: { exact: "Three fixed roles", prefix: "", suffix: ": owner" },
    body: "Add custom roles to the first release; big teams will ask for them.",
  }, at("2026-10-13T11:00:00Z"));
  docs.get("team-workspaces")!.status = "in_review";

  // Usage alerts: fully approved.
  const a1 = ver("usage-alerts", 1);
  for (const s of a1.sections) addReview(db, a1, s.section_key, { verdict: "approved", note: null }, at("2026-10-03T10:00:00Z"));
  a1.approved_at = "2026-10-03T10:05:00Z";
  docs.get("usage-alerts")!.status = "approved";

  // Provenance (O4b): roadmap versions record the approved PRD version they came from.
  for (const d of DOCUMENTS as DocumentSeed[]) {
    for (const v of d.versions) {
      if (v.source) ver(d.slug, v.number).source = versionSource(docs.get(v.source.slug)!, ver(v.source.slug, v.source.version));
    }
  }
  docs.get("usage-alerts-roadmap")!.status = "in_review";
  db.runs = seedRuns(runsContext(db));
  db.llm = seedLlm(llmContext(db, db.user_id, "owner"));
  return db;
}

function llmContext(db: Db, userId: string, role: Role): LlmContext {
  return {
    db: db.llm ?? { jobs: [], suggestions: [], disabled: {} },
    userId,
    role,
    documents: db.documents,
    versions: db.versions,
    feedback: db.feedback,
    uuid,
    now,
    lockedKeys: (v) => lockedKeys(db, v as VersionRow),
    reply: (feedbackId, body) => {
      const parent = db.comments.find((c) => c.id === db.feedback.find((f) => f.id === feedbackId)?.comment_id);
      if (!parent) return;
      db.comments.push({ ...parent, id: uuid(), anchor: null, body, author_id: userId, parent_id: parent.id, created_at: now(), feedback_item_id: null });
    },
    importRevision: (doc, base, key, heading, body, resolutions) => {
      const row = findDocument(db, doc.id)!;
      const from = base as VersionRow;
      const v = buildVersion(row, {
        number: base.number + 1,
        created_at: now(),
        snapshot: from.snapshot ?? undefined,
        sections: from.sections.map((x) =>
          x.section_key === key
            ? { key, level: x.level, heading, body }
            : { key: x.section_key, level: x.level, heading: x.heading, body: x.body_md },
        ),
        citations: from.citations.map((c) => ({
          id: c.cite_key,
          source: c.source,
          ref: c.ref,
          title: c.title ?? "",
          excerpt: c.excerpt ?? "",
          retrieved_at: c.retrieved_at ?? "",
        })),
      });
      db.versions.push(v);
      for (const r of resolutions) {
        const f = db.feedback.find((x) => x.id === r.feedback_id);
        if (f && f.status === "open") Object.assign(f, { status: r.status, resolution_note: r.note, addressed_in_version: v.number, updated_at: now() });
      }
      // Duplicates of what was resolved go with it.
      for (const s of db.llm?.suggestions ?? []) {
        const f = db.feedback.find((x) => x.id === s.feedback_item_id);
        if (s.kind === "duplicate" && f?.status === "open" && resolutions.some((r) => r.feedback_id === s.duplicate_of)) {
          Object.assign(f, { status: "addressed", resolution_note: "Addressed with the item it duplicates", addressed_in_version: v.number, updated_at: now() });
        }
      }
      touch(db, doc.id);
      return v;
    },
  };
}

function runsContext(db: Db): Omit<RunsContext, "db"> & { db?: RunsDb } {
  return {
    db: db.runs,
    userId: db.user_id,
    feedback: db.feedback,
    documents: db.documents,
    latestVersion: (id) => {
      const doc = db.documents.find((d) => d.id === id);
      const vs = doc ? docVersions(db, doc) : [];
      return vs.length ? vs[vs.length - 1].number : null;
    },
    sectionKeys: (versionId) => db.versions.find((v) => v.id === versionId)?.sections.map((s) => s.section_key) ?? [],
    // The approved version a roadmap is built from: the one named, else the latest approved.
    sourceVersion: (documentId, number) => {
      const doc = findDocument(db, documentId)!;
      const vs = docVersions(db, doc);
      if (number != null) {
        const v = vs.find((x) => x.number === number);
        if (!v) return `version ${number} of '${doc.slug}' not found`;
        if (!v.approved_at) return `version ${number} of '${doc.slug}' is not approved: a roadmap is built from an approved PRD version`;
        return versionSource(doc, v);
      }
      const v = vs.filter((x) => x.approved_at).pop();
      return v ? versionSource(doc, v) : `'${doc.slug}' has no approved version: approve a version of the PRD before building its roadmap`;
    },
    // A run's draft becomes the next version: a copy of the latest one (or of the first
    // fixture for a new document); a roadmap draft is built from its PRD version. So the
    // review screens have something to show.
    importDraft: (slug, run) => {
      const prd = run.source ? db.versions.find((v) => v.id === run.source!.version_id) : undefined;
      const fromPrd =
        prd &&
        roadmapFromPrd({
          slug: run.source!.slug,
          title: run.source!.title,
          version: prd.number,
          sections: prd.sections.map((s) => ({ key: s.section_key, level: s.level, heading: s.heading })),
        });
      let doc = findDocument(db, slug);
      if (!doc) {
        doc = {
          id: uuid(),
          slug,
          title: fromPrd?.title ?? "Example product PRD",
          status: "draft",
          kind: run.document_kind ?? "prd",
          template: run.template ?? null,
          template_version: run.template ? "1" : null,
          theme: run.theme ?? null,
          created_at: now(),
          updated_at: now(),
        };
        db.documents.push(doc);
      }
      const latest = docVersions(db, doc).pop();
      const seed = (DOCUMENTS as DocumentSeed[])[0].versions[0];
      const number = (latest?.number ?? 0) + 1;
      const base = fromPrd
        ? { number, created_at: now(), sections: fromPrd.sections, citations: [], brief: fromPrd.brief }
        : latest
          ? { number, created_at: now(), sections: latest.sections.map((x) => ({ key: x.section_key, level: x.level, heading: x.heading, body: x.body_md })), citations: [] }
          : { ...seed, number, created_at: now() };
      const v = buildVersion(doc, base);
      v.source = run.source ?? null;
      db.versions.push(v);
      touch(db, doc.id);
      return {
        document_id: doc.id,
        slug: doc.slug,
        kind: doc.kind,
        version: v.number,
        source: v.source,
        prd_links: prd ? prdLinks(v, run.source!.slug, prd) : null,
      };
    },
    uuid,
    now,
  };
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

function versionSource(doc: DocumentRow, v: VersionRow): Schemas["VersionSource"] {
  return {
    document_id: doc.id,
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    version: v.number,
    version_id: v.id,
    approved_at: v.approved_at,
  };
}

const DOC_LINK = /\]\((\/documents\/([A-Za-z0-9][\w.-]*)\/v\/(\d+)(?:#([A-Za-z0-9][\w.:-]*))?)\)/g;

/** A roadmap draft's links to its PRD version's sections, resolved or not (O4b). */
function prdLinks(v: VersionRow, slug: string, prd: VersionRow): Schemas["PrdLinks"] {
  const keys = new Set(prd.sections.map((s) => s.section_key));
  const out: Schemas["PrdLinks"] = { resolved: 0, unresolved: [] };
  for (const s of v.sections) {
    for (const m of s.body_md.matchAll(DOC_LINK)) {
      if (m[2] === slug && Number(m[3]) === prd.number && (!m[4] || keys.has(m[4]))) out.resolved += 1;
      else out.unresolved.push(m[1]);
    }
  }
  return out;
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
    brief_source: v.brief_source ?? "none",
    source: v.source ?? null,
    created_at: v.created_at,
  };
}

function sectionLayer(db: Db, versionId: string, key: string): Schemas["SectionOut"]["layer"] | null {
  return db.versions.find((v) => v.id === versionId)?.sections.find((s) => s.section_key === key)?.layer ?? null;
}

function documentSummary(db: Db, d: DocumentRow): Schemas["DocumentSummary"] {
  const vs = docVersions(db, d);
  const latest = vs[vs.length - 1];
  return {
    ...d,
    kind: d.kind ?? "prd",
    latest_version: latest?.number ?? null,
    approved_version: vs.filter((v) => v.approved_at).pop()?.number ?? null,
    source: latest?.source ?? null,
  };
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
    layer: sectionLayer(db, c.version_id, c.section_key),
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

function addComment(
  db: Db,
  v: VersionRow,
  body: Schemas["CommentCreate"],
  opts?: { created_at?: string; author_id?: string },
) {
  const created_at = opts?.created_at ?? now();
  const feedbackId = uuid();
  const c: CommentRow = {
    id: uuid(),
    version_id: v.id,
    section_key: body.section_key,
    anchor: body.anchor,
    body: body.body,
    author_id: opts?.author_id ?? db.user_id,
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
  opts?: { created_at?: string; reviewer_id?: string },
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
    reviewer_id: opts?.reviewer_id ?? db.user_id,
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

const ROLE_ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
const forbidden = (min: Role) => json(403, { detail: `Requires the ${min} role` });

function meOut(db: Db, m: MemberRow): Schemas["Me"] {
  return { kind: "user", tenant_id: db.tenant_id, user_id: m.id, email: m.email, role: m.role };
}

/** Members, invites: owners only, as in the API. */
async function membersRoute(db: Db, req: Request, p: string[], me: MemberRow): Promise<Response> {
  if (!atLeast(me.role, "owner")) return forbidden("owner");
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  if (p[1] === "members") {
    if (!p[2] && m === "GET") return json(200, db.members);
    const target = db.members.find((x) => x.id === p[2]);
    if (!target) return notFound("Member");
    if (m === "PATCH") {
      const { role } = await body<Schemas["MemberPatch"]>();
      if (target.role === "owner" && role !== "owner" && db.members.filter((x) => x.role === "owner").length <= 1) {
        return json(409, { detail: "Cannot demote the last owner; make someone else owner" });
      }
      target.role = role;
      return json(200, target);
    }
  }
  if (p[1] === "invites") {
    if (!p[2] && m === "GET") {
      const status = new URL(req.url).searchParams.get("status") ?? "open";
      return json(
        200,
        db.invites.filter((i) => status === "all" || i.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    }
    if (!p[2] && m === "POST") {
      const input = await body<Schemas["InviteCreate"]>();
      const email = input.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(422, { detail: "Not an email address" });
      if (db.members.some((x) => x.email === email)) return json(409, { detail: `${email} is already a member` });
      if (db.invites.some((i) => i.email === email && i.status === "open")) {
        return json(409, { detail: `${email} already has an open invite; revoke it first` });
      }
      const invite: InviteRow = {
        id: uuid(),
        email,
        role: input.role,
        status: "open",
        invited_by: me.id,
        created_at: now(),
        accepted_at: null,
        revoked_at: null,
      };
      db.invites.push(invite);
      return json(201, invite);
    }
    const invite = db.invites.find((i) => i.id === p[2]);
    if (!invite) return notFound("Invite");
    if (m === "DELETE") {
      if (invite.status === "accepted") return json(409, { detail: "This invite was already accepted" });
      if (invite.status === "open") Object.assign(invite, { status: "revoked", revoked_at: now() });
      return json(204, undefined);
    }
  }
  return notFound("Route");
}

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
    const member = db.members.find((x) => x.email === email.trim().toLowerCase());
    if (!member || password !== MOCK_LOGIN.password) {
      return json(401, { detail: "Invalid credentials" });
    }
    db.session = member.email;
    return json(200, meOut(db, withMockRole(member)));
  }
  if (p[1] === "auth" && p[2] === "logout" && m === "POST") {
    db.session = null;
    return json(204, undefined);
  }
  const member = db.members.find((x) => x.email === db.session);
  if (!member) return json(401, { detail: "Not authenticated" });
  const me = withMockRole(member);
  if (p[1] === "me" && p[2] === "preferences") {
    db.preferences ??= {};
    const mine = (db.preferences[me.email] ??= { document_view: "brief" });
    if (m === "PATCH") {
      const patch = await body<Schemas["PreferencesUpdate"]>();
      if (patch.document_view && !["brief", "full"].includes(patch.document_view)) return json(422, { detail: "document_view" });
      if (patch.document_view) mine.document_view = patch.document_view;
    }
    return json(200, mine);
  }
  if (p[1] === "me") return json(200, meOut(db, me));
  if (p[1] === "members" || p[1] === "invites") return membersRoute(db, req, p, me);
  // The baseline mock checks roles itself (commenters propose, approvers decide).
  if (p[1] === "baseline") {
    return routeBaseline(db.baseline, { userId: me.id, role: me.role }, req, p.slice(2), q);
  }
  // Sources and connections belong to each user: every role manages their own.
  if (["sources", "source-items", "snapshots", "search"].includes(p[1])) return routeSources(req, p, q);
  const connections = await connectionsRoute(req, p);
  if (connections) return connections;
  // The Claude account pool checks roles itself: every member reads, owners change.
  const pool = await claudeAccountsRoute(req, p, q, me.role);
  if (pool) return pool;
  // Built-in model jobs check roles themselves (approvers decide, owners set them up).
  db.llm ??= seedLlm(llmContext(db, db.user_id, "owner"));
  const llm = llmContext(db, me.id, me.role);
  const jobs = await llmJobsRoute(llm, req, p, q);
  if (jobs) return jobs;
  // PRD quality and readiness, outcomes and learnings (./quality.ts) check roles themselves.
  if (!db.v2) {
    const prd = db.documents.find((d) => d.kind === "prd");
    const version = db.versions.find((v) => v.document_id === prd?.id) ?? null;
    db.v2 = seedV2(prd?.id ?? db.tenant_id, version?.id ?? null, db.user_id);
  }
  db.quality ??= seedQuality();
  const quality = await routeQuality(
    {
      db: db.quality,
      v2: db.v2,
      userId: me.id,
      role: me.role,
      findVersion: (ref, n) => {
        const doc = findDocument(db, ref);
        const v = doc && findVersion(db, doc, n);
        return doc && v ? { documentId: doc.id, slug: doc.slug, versionId: v.id } : null;
      },
    },
    req,
    p,
    q,
  );
  if (quality) return quality;
  // Modules and compositions check roles themselves (viewers may ask for a recommendation).
  if (!db.modules) {
    const prd = db.documents.find((d) => d.kind === "prd");
    db.modules = seedModules(prd?.id ?? null, db.user_id);
  }
  const modules = await routeModules(
    db.modules,
    {
      userId: me.id,
      role: me.role,
      document: (ref) => {
        const doc = findDocument(db, ref);
        return doc && doc.kind === "prd" ? { id: doc.id, slug: doc.slug, template: doc.template ?? null } : null;
      },
      approvedVersion: (documentId, n) =>
        db.versions.find((v) => v.document_id === documentId && v.number === n && v.approved_at)?.id ?? null,
    },
    req,
    p,
    q,
  );
  if (modules) return modules;
  // The API's role checks: viewers read, commenters comment, approvers decide.
  const need: Role | null =
    m === "GET"
      ? null
      : p[1] === "comments" || (p[5] === "comments" && m === "POST")
        ? "commenter"
        : "approver";
  if (need && !atLeast(me.role, need)) return forbidden(need);

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
        author_id: me.id,
        parent_id: c.id,
        resolved_at: null,
        created_at: now(),
        feedback_item_id: null,
      };
      db.comments.push(r);
      return json(201, commentOut(db, r));
    }
    if (m === "PATCH") {
      if (c.author_id !== me.id && !atLeast(me.role, "approver")) {
        return json(403, { detail: "Only the author or an approver can change this comment" });
      }
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

  // Product Oracle v2 read routes; viewers read (lanes add writes in ./v2.ts).
  if (!db.v2) {
    const prd = db.documents.find((d) => d.kind === "prd");
    const version = db.versions.find((v) => v.document_id === prd?.id) ?? null;
    db.v2 = seedV2(prd?.id ?? db.tenant_id, version?.id ?? null, db.user_id);
  }
  const v2 = routeV2(db.v2, req, p, q);
  if (v2) return v2;

  const handled = await laneF(db, req, p, m);
  if (handled) return handled;

  db.runs ??= seedRuns(runsContext(db));
  const runs = await routeRuns({ ...runsContext(db), db: db.runs }, req, p);
  if (runs) return runs;

  if (p[1] !== "documents") return notFound("Route");
  if (p.length === 2) {
    const kind = q.get("kind");
    return json(200, db.documents.map((d) => documentSummary(db, d)).filter((d) => !kind || d.kind === kind));
  }

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
    tick(llm);
    const items = db.feedback
      .filter((f) => f.document_id === doc.id)
      .filter((f) => !status || f.status === status)
      .filter((f) => !version || f.raised_on_version === Number(version))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((f) => withSuggestion(db.llm, f));
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
      const c = addComment(db, v, input, { author_id: me.id });
      touch(db, doc.id);
      onFeedback(llm, doc.id, v.number);
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
    const r = addReview(db, v, p[6], await body<Schemas["SectionReviewIn"]>(), { reviewer_id: me.id });
    touch(db, doc.id);
    if (r.feedback_item_id) onFeedback(llm, doc.id, v.number);
    return json(200, { ...r, layer: sectionLayer(db, v.id, r.section_key) });
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
    const items = db.feedback
      .filter((f) => f.document_id === doc.id && f.raised_on_version < v.number)
      .map((f) => withSuggestion(db.llm, f));
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
  if (sub === "deck" || (sub === "export" && (q.get("layer") ?? "full") !== "full")) {
    if (!v.sections.some((s) => s.layer === "brief")) {
      return json(422, { detail: `version ${v.number} of '${doc.slug}' has no brief sections; export the full document instead` });
    }
  }
  if (sub === "deck") {
    const versions = docVersions(db, doc);
    return json(
      200,
      deckOut({
        document_id: doc.id,
        slug: doc.slug,
        title: doc.title,
        number: v.number,
        latest: versions[versions.length - 1].number,
        status: v.approved_at ? "approved" : doc.status,
        created_at: v.created_at,
        source: v.source ?? null,
        sections: v.sections,
        citations: v.citations,
      }),
    );
  }
  if (sub === "export") {
    const format = q.get("format") ?? "html";
    const layer = q.get("layer") ?? "full";
    if (!LAYER_FORMATS[layer]?.includes(format)) {
      return json(422, { detail: `the ${layer} layer exports as ${LAYER_FORMATS[layer]?.join(", ")}, not ${format}` });
    }
    if (layer === "deck") {
      if (format === "pptx") return new Response(`PK mock deck: ${banner(doc, v)}`, { headers: { "content-type": PPTX_TYPE } });
      return new Response(exportPdf(doc, { ...v, sections: v.sections.filter((s) => s.layer === "brief") }), {
        headers: { "content-type": "application/pdf" },
      });
    }
    if (layer === "brief") {
      const brief = { ...v, sections: v.sections.filter((s) => s.layer === "brief") };
      if (format === "pdf") return new Response(exportPdf(doc, brief), { headers: { "content-type": "application/pdf" } });
      return new Response(exportHtml(doc, brief), { headers: { "content-type": "text/html" } });
    }
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
