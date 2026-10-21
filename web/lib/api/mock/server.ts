/**
 * In-browser stand-in for the API, used when NEXT_PUBLIC_API_MOCKS=1. It is plugged
 * into openapi-fetch as its `fetch`, so pages call the typed client exactly as they
 * will against the real API. State lives in localStorage, so it survives reloads.
 */
import type { Schemas } from "@/lib/api/client";
import { sectionDiff } from "@/lib/diff";
import { plainText } from "@/lib/markdown";

import { mockUuid, seeded } from "./ids";
import { enlargeBaseline, routeBaseline, seedBaseline, type BaselineState } from "./baseline";
import { documentGate, routeBlockers, seedBlockers, type BlockersDb } from "./blockers";
import { BIG_PRD, BIG_PRD_COMMENTS, BIG_PRD_REVIEWS, BIG_PRD_SUGGESTIONS } from "./big-prd";
import { deckOut, LAYER_FORMATS, PPTX_TYPE, presenterNotes, resolveBrief } from "./brief";
import { claudeAccountsRoute } from "./claude-accounts";
import { connectionsRoute } from "./connections";
import { DOCUMENTS, FLEET_DOC, FLEET_SUGGESTIONS, MOCK_INVITES, MOCK_LOGIN, MOCK_MEMBERS, roadmapFromPrd, type DocumentSeed, type VersionSeed } from "./fixtures";
import { laneF, type LaneFState } from "./lane-f";
import { llmJobsRoute, onFeedback, seedLlm, tick, withSuggestion, type LlmContext, type LlmDb } from "./llm-jobs";
import { inboxStates, isStaged } from "./next-draft";
import { routeModules, seedModules, type ModulesDb } from "./modules";
import { enlargeRuns, routeRuns, seedRuns, type RunsContext, type RunsDb } from "./runs";
import { routeFirefliesBrowse } from "./fireflies";
import { sourceBrowseRoute } from "./source-browse";
import { routeSources, SOURCES_STORAGE_KEY } from "./sources";
import { routeIntake } from "./intake";
import { routeRequests, seedRequests, type RequestsContext, type RequestsDb } from "./requests";
import { publishRefusal, routeQuality, seedQuality, type QualityContext, type QualityDb } from "./quality";
import { routeReviewV2, seedReviewV2, type ReviewV2Db } from "./review-v2";
import { dateMarks, routeRoadmap, seedRoadmap, trackRunBody, type RoadmapContext, type RoadmapDb } from "./roadmap";
import { routeTrace } from "./trace";
import { emptyV2, routeV2, seedV2, type V2Db } from "./v2";

/** latest_version, approved_version and source are read off the versions. */
export type DocumentRow = Omit<Schemas["DocumentSummary"], "latest_version" | "approved_version" | "source">;
export type VersionRow = Omit<Schemas["VersionOut"], "sections" | "date_marks"> & {
  sections: Omit<Schemas["SectionOut"], "verdict">[];
};
type CommentRow = Omit<Schemas["CommentOut"], "replies">;
/** A stored section review; a spec may mark an approval lapsed (C2). */
type ReviewRow = Schemas["SectionReviewOut"] & { lapsed_at?: string | null; lapse_reason?: string | null };
/** Stored without its derived C1e state (withSuggestion adds it on the way out). */
type FeedbackRow = Omit<Schemas["FeedbackItemOut"], "state" | "staged_for_version">;
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
  /** v2 review state, campaigns, notifications, publications (./review-v2.ts). */
  review_v2?: ReviewV2Db;
  /** Outcome records and learnings (./quality.ts); absent in data saved before CR-08. */
  quality?: QualityDb;
  /** Module catalogue and compositions (./modules.ts); absent in older saved data. */
  modules?: ModulesDb;
  /** Blocker strategies (./blockers.ts) on the v2 rows; absent in older saved data. */
  blockers?: BlockersDb;
  /** C1e: each member's last Inbox visit (what "new" is measured from), by member id. */
  inbox_seen?: Record<string, string>;
  /** Roadmap items, product tracks, schedule bases and tracker records (./roadmap.ts, CR-11). */
  roadmap?: RoadmapDb;
  /** Requests, their themes and the found items of the seed owner (./requests.ts, C1). */
  requests?: RequestsDb;
  /** Per-user preferences (O1f document_view), by member email. */
  preferences?: Record<string, Schemas["Preferences"]>;
  /** Provider revokes a removed member's disable could not make (C2); seeded in the
   * "revoke-failures" scenario only. */
  revoke_failures?: RevokeFailureRow[];
}

type RevokeFailureRow = Schemas["InboxRevokeFailure"] & { dismissed?: boolean };

/** Two revokes still owed: GitHub (24 hours of retries over) and Slack (not configured, still retried). */
function seedRevokeFailures(): RevokeFailureRow[] {
  const member = { member_id: uuid(), member_email: "former.pm@example.com" };
  const item = (provider: string, name: string, extra: Partial<RevokeFailureRow>): RevokeFailureRow => ({
    id: uuid(),
    ...member,
    provider,
    provider_name: name,
    title: `Couldn't revoke ${member.member_email}'s ${name} access at ${name}`,
    status: "pending",
    outcome: "failed",
    last_error: null,
    attempts: 1,
    created_at: "2026-10-18T09:00:00Z",
    next_attempt_at: null,
    retry_until: "2026-10-19T09:00:00Z",
    ...extra,
  });
  return [
    item("github", "GitHub", { status: "failed", attempts: 12, last_error: "the provider did not answer in time" }),
    item("slack", "Slack", {
      outcome: "not_configured",
      attempts: 3,
      created_at: "2026-10-19T20:00:00Z",
      next_attempt_at: "2026-10-19T20:30:00Z",
      retry_until: "2026-10-20T20:00:00Z",
    }),
  ];
}

/** Retry and Dismiss of a revoke a disable owes: owners only, as in the API. A retry succeeds,
 * except while the provider's OAuth app is not configured. */
function followUpsRoute(db: Db, req: Request, p: string[], me: MemberRow): Response | null {
  if (p[1] !== "member-follow-ups" || req.method !== "POST") return null;
  if (!atLeast(me.role, "owner")) return forbidden("owner");
  db.revoke_failures ??= [];
  const row = db.revoke_failures.find((r) => r.id === p[2]);
  if (!row) return notFound("Follow-up");
  if (row.dismissed) return json(409, { detail: "This follow-up is dismissed; nothing to do" });
  const out = (status: string) => ({
    id: row.id,
    member_id: row.member_id,
    kind: "provider_revoke",
    provider: row.provider,
    status,
    attempts: row.attempts,
    outcome: row.outcome,
    last_error: row.last_error,
    created_at: row.created_at,
    next_attempt_at: row.next_attempt_at,
  });
  if (p[3] === "dismiss") {
    row.dismissed = true;
    return json(200, { ...out("dismissed"), dismissed_at: now(), dismissed_by: me.id });
  }
  if (p[3] === "retry") {
    row.attempts += 1;
    if (row.outcome === "not_configured") return json(200, out(row.status));
    db.revoke_failures = db.revoke_failures.filter((r) => r.id !== row.id);
    return json(200, { ...out("done"), outcome: "revoked", last_error: null });
  }
  return notFound("Route");
}

const STORAGE_KEY = "po-mock-db-v2";
/** Tests set this localStorage key (viewer, commenter, approver) to act with another role. */
export const MOCK_ROLE_KEY = "po-mock-role";
/**
 * Tests and screenshots set this localStorage key before the first call: "empty" starts as a
 * new company (members only, no goals, documents, runs or questions); "large" as a big one
 * (30 goals, 50 more active runs, questions asked of the signed-in member); "suggestions" as the
 * default company plus a PRD with three open Oracle suggestions (fleet-next); "big-prd" adds a PRD
 * of 100+ sections in nested chapters (platform-handbook, ./big-prd.ts); "revoke-failures" as the
 * default company plus two provider revokes a removed member's disable could not make (C2);
 * "undelivered" as the default company where SwarmCloud takes no checkpoint decision until the
 * next tick (recorded, the decide call answers 503; ./runs.ts).
 */
export const MOCK_SCENARIO_KEY = "po-mock-scenario";
/** Tests set this localStorage key to a path ("/v1/questions") to make its GETs fail with a 500. */
export const MOCK_FAIL_KEY = "po-mock-fail";
const ROLES: readonly Schemas["Me"]["role"][] = ["viewer", "commenter", "approver", "owner"];

/** The signed-in member, with the role overridden when a test set MOCK_ROLE_KEY. */
function withMockRole<T extends { role: Schemas["Me"]["role"] }>(member: T): T {
  const role = localStorage.getItem(MOCK_ROLE_KEY) as Schemas["Me"]["role"] | null;
  return role && ROLES.includes(role) ? { ...member, role } : member;
}
const LATENCY_MS = 60;

const uuid = mockUuid;

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
    notes: [],
    imported_by: "agent-track",
    approved_at: null,
    approval_lapses: [],
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
      // A mock company has no source items: the writer's item id shows as given.
      item_id: c.item ?? null,
      confidence: c.confidence ?? null,
      confidence_note: c.confidence_note ?? null,
      low_confidence: c.low_confidence ?? false,
    })),
  };
}

/** A new company: the members and their invites, nothing else yet. */
function seedEmpty(): Db {
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
    baseline: { entities: [], edges: [], evidence: [], conflicts: [], proposals: [], revisions: [] },
    runs: { runs: [], artifacts: {} },
    v2: emptyV2(),
  };
  db.members = MOCK_MEMBERS.map((m) => ({
    ...m,
    id: m.email === MOCK_LOGIN.email ? db.user_id : uuid(),
    disabled_at: null,
    disabled_by: null,
    status: "active" as const,
  }));
  return db;
}

/** A big company: Home must stay within a fixed number of calls however much there is. */
function seedLarge(): Db {
  const db = seed();
  enlargeBaseline(db.baseline, uuid, 27);
  db.runs = seeded("runs", () => seedRuns(runsContext(db)));
  enlargeRuns(db.runs, uuid, 50);
  const v2 = ensureV2(db);
  const model = v2.questions[0];
  for (let i = 1; i <= 4; i++) {
    const at = new Date(Date.parse(model.created_at) + i * 60_000).toISOString();
    v2.questions.push({ ...model, id: uuid(), prompt: `Which clinics open first in region ${i}?`, priority: 10 + i, created_at: at, updated_at: at });
  }
  // Asked of someone else: not the signed-in member's to answer.
  const other = db.members.find((m) => m.id !== db.user_id)!;
  v2.questions.push({ ...model, id: uuid(), prompt: "Who owns the pricing page?", asked_to: other.id, created_at: model.created_at, updated_at: model.created_at });
  return db;
}

/**
 * The default company plus a PRD whose open feedback is three Oracle change requests on
 * feature sections (none on the first section) and one item already addressed: what the
 * Inbox's feedback row leads to.
 */
function seedSuggestions(): Db {
  const db = seed();
  const doc: DocumentRow = {
    id: uuid(),
    slug: FLEET_DOC.slug,
    title: FLEET_DOC.title,
    status: "in_review",
    kind: "prd",
    template: FLEET_DOC.template ?? null,
    template_version: FLEET_DOC.template_version ?? null,
    theme: null,
    created_at: FLEET_DOC.versions[0].created_at,
    updated_at: FLEET_DOC.versions.at(-1)!.created_at,
  };
  db.documents.push(doc);
  for (const v of FLEET_DOC.versions) db.versions.push(buildVersion(doc, v));
  const v1 = findVersion(db, doc, 1)!;
  const v2 = findVersion(db, doc, 2)!;
  addComment(db, v1, {
    section_key: "problem",
    anchor: { exact: "so many are out when the driver comes", prefix: "arrive, ", suffix: "." },
    body: "How many first attempts fail today? Put the number in.",
  }, { created_at: "2026-10-17T11:00:00Z" });
  Object.assign(db.feedback.at(-1)!, {
    status: "addressed",
    addressed_in_version: 2,
    resolution_note: "Added the failed first-attempt rate.",
    updated_at: "2026-10-19T09:00:00Z",
  });
  const llm = (db.llm ??= { jobs: [], suggestions: [], disabled: {} });
  FLEET_SUGGESTIONS.forEach((x, i) => {
    const created_at = `2026-10-19T10:0${i}:00Z`;
    const f: FeedbackRow = {
      id: uuid(),
      document_id: doc.id,
      raised_on_version: 2,
      kind: "general",
      comment_id: null,
      section_review_id: null,
      section_key: x.key,
      summary: x.summary,
      anchor: null,
      verdict: null,
      status: "open",
      addressed_in_version: null,
      resolution_note: null,
      created_at,
      updated_at: created_at,
    };
    db.feedback.push(f);
    llm.suggestions.push({
      id: uuid(),
      document_id: doc.id,
      feedback_item_id: f.id,
      job_id: null,
      version_number: v2.number,
      classification: "change_request",
      group_key: null,
      duplicate_of: null,
      kind: "section_text",
      section_key: x.key,
      text: x.text,
      edited_text: null,
      rationale: x.rationale,
      pushback: null,
      status: "open",
      override_reason: null,
      decided_by: null,
      decided_at: null,
      applied_in_version: null,
      created_at,
      updated_at: created_at,
    });
  });
  return db;
}

/** The default seed plus one PRD of 100+ sections in nested chapters (./big-prd.ts). */
function seedBigPrd(): Db {
  const db = seed();
  const row: DocumentRow = {
    id: uuid(),
    slug: BIG_PRD.slug,
    title: BIG_PRD.title,
    status: "in_review",
    kind: "prd",
    template: BIG_PRD.template ?? null,
    template_version: BIG_PRD.template_version ?? null,
    theme: null,
    created_at: BIG_PRD.versions[0].created_at,
    updated_at: BIG_PRD.versions[0].created_at,
  };
  db.documents.push(row);
  const v = buildVersion(row, BIG_PRD.versions[0]);
  db.versions.push(v);
  const at = "2026-10-19T10:00:00Z";
  for (const [key, r] of Object.entries(BIG_PRD_REVIEWS)) addReview(db, v, key, r, { created_at: at });
  const comments = BIG_PRD_COMMENTS.map(([key, exact, text], i) => {
    const plain = v.sections.find((s) => s.section_key === key)!.body_text;
    const start = plain.indexOf(exact);
    const anchor = { exact, prefix: plain.slice(Math.max(0, start - 32), start), suffix: plain.slice(start + exact.length, start + exact.length + 32) };
    return addComment(db, v, { section_key: key, anchor, body: text }, { created_at: `2026-10-19T11:${String(10 + i).padStart(2, "0")}:00Z` });
  });
  const llm = (db.llm ??= { jobs: [], suggestions: [], disabled: {} });
  for (const s of BIG_PRD_SUGGESTIONS) {
    const c = comments.find((x) => x.body === s.comment)!;
    llm.suggestions.push({
      id: uuid(),
      document_id: row.id,
      feedback_item_id: c.feedback_item_id!,
      job_id: null,
      version_number: 1,
      classification: "change_request",
      group_key: null,
      duplicate_of: null,
      kind: "section_text",
      section_key: c.section_key,
      text: s.text,
      edited_text: null,
      rationale: s.rationale,
      pushback: null,
      status: s.status,
      override_reason: null,
      decided_by: s.status === "open" ? null : db.user_id,
      decided_at: s.status === "open" ? null : at,
      applied_in_version: null,
      created_at: at,
      updated_at: at,
    });
    // Dismissed with "decline the feedback".
    if (s.status === "dismissed") Object.assign(db.feedback.find((f) => f.id === c.feedback_item_id)!, { status: "declined", resolution_note: "Kept as written." });
  }
  // One resolved thread: Done.
  comments.find((c) => c.body.startsWith("List the shortcuts"))!.resolved_at = at;
  return db;
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
  db.members = MOCK_MEMBERS.map((m) => ({
    ...m,
    id: m.email === MOCK_LOGIN.email ? db.user_id : uuid(),
    disabled_at: null,
    disabled_by: null,
    status: "active" as const,
  }));
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

  // Clinic outreach (C1e): feedback in every state; the suggestions are in ./llm-jobs.ts.
  addComment(db, ver("clinic-outreach", 3), {
    section_key: "problem",
    anchor: { exact: "in every pilot clinic", prefix: "from paper lists, ", suffix: "." },
    body: "Name the clinics in the pilot.",
  }, at("2026-10-08T12:00:00Z"));
  for (const f of db.feedback) {
    if (f.summary === "Name the clinics in the pilot.") {
      Object.assign(f, { status: "addressed", addressed_in_version: 4, resolution_note: "The three pilot clinics are named in the problem.", updated_at: "2026-10-09T10:00:00Z" });
    }
  }
  addComment(db, ver("clinic-outreach", 4), {
    section_key: "goal-trace",
    anchor: { exact: "Serves G1 activation", prefix: "", suffix: ": more new patients" },
    body: "Trace this to G2 retention, not activation: these are returning patients.",
  }, at("2026-10-09T15:00:00Z"));
  const o5 = ver("clinic-outreach", 5);
  addComment(db, o5, {
    section_key: "f-38",
    anchor: { exact: "After each outbound call", prefix: "", suffix: ", the agent checks" },
    body: "Run the outbound check before the call is placed, not after.",
  }, at("2026-10-18T14:00:00Z"));
  addComment(db, o5, {
    section_key: "problem",
    anchor: { exact: "40% of missed visits", prefix: "", suffix: " are never rebooked" },
    body: "Drop the 40% figure; it is from 2024.",
  }, at("2026-10-18T14:20:00Z"));
  addComment(db, o5, {
    section_key: "metrics",
    anchor: { exact: "Calls per rebooking", prefix: "- ", suffix: ": 3.1 today" },
    body: "Add a metric that shows the outbound check works.",
  }, at("2026-10-19T09:30:00Z"));
  docs.get("clinic-outreach")!.status = "in_review";

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
  db.runs = seeded("runs", () => seedRuns(runsContext(db)));
  db.llm = seeded("llm", () => seedLlm(llmContext(db, db.user_id, "owner")));
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
    importRevision: (doc, base, key, heading, body, resolutions) =>
      importSections(db, doc, base as VersionRow, { [key]: { heading, body } }, resolutions),
    importSections: (doc, base, replace, resolutions) => importSections(db, doc, base as VersionRow, replace, resolutions),
    memberName: (id) => db.members.find((m) => m.id === id)?.email ?? null,
  };
}

/**
 * C1e: the Inbox's feedback by state for approvers (new since my last visit, open, staged,
 * declined, done), the staged rows, and open feedback that leaves staged and settled items out.
 */
function withInboxStates(
  db: Db,
  llm: LlmContext,
  me: { id: string; role: Role },
  base: Schemas["InboxOut"],
  markSeen: boolean,
): Schemas["InboxOut"] {
  db.inbox_seen ??= {};
  const seen = db.inbox_seen[me.id] ?? null;
  if (markSeen) db.inbox_seen[me.id] = now();
  // Decisions not delivered yet show to the review's approver role and above, as the API.
  if (!atLeast(me.role, "approver")) return { ...base, deliveries: [], last_seen_at: seen };
  const states = inboxStates(llm, seen);
  // Open feedback per document comes from ./runs.ts (staged items left out there); its
  // items carry their state here.
  const byId = new Map(states.items.map((i) => [i.id, i]));
  const feedback = base.feedback.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, ...byId.get(i.id), kind: i.kind })) }));
  return {
    ...base,
    feedback,
    // Every new or open item, as the API: = the Inbox's New + Open tabs (owner, 2026-10-20).
    total: base.total + states.needs_me,
    ...states,
    last_seen_at: seen,
  };
}

/** The next version: the base with some sections replaced, and the resolutions recorded. */
function importSections(
  db: Db,
  doc: { id: string },
  from: VersionRow,
  replace: Record<string, { heading: string; body: string }>,
  resolutions: { feedback_id: string; status: "addressed" | "declined"; note: string | null }[],
): VersionRow {
  const row = findDocument(db, doc.id)!;
  const v = buildVersion(row, {
    number: from.number + 1,
    created_at: now(),
    snapshot: from.snapshot ?? undefined,
    sections: from.sections.map((x) => ({
      key: x.section_key,
      level: x.level,
      heading: replace[x.section_key]?.heading ?? x.heading,
      body: replace[x.section_key]?.body ?? x.body_md,
    })),
    citations: from.citations.map((c) => ({
      id: c.cite_key,
      source: c.source,
      ref: c.ref,
      title: c.title ?? "",
      excerpt: c.excerpt ?? "",
      retrieved_at: c.retrieved_at ?? "",
      item: c.item_id ?? undefined,
      confidence: c.confidence,
      confidence_note: c.confidence_note ?? undefined,
      low_confidence: c.low_confidence,
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
}

function runsContext(db: Db): Omit<RunsContext, "db"> & { db?: RunsDb } {
  return {
    db: db.runs,
    userId: db.user_id,
    userName: db.session ?? db.members.find((m) => m.id === db.user_id)?.email ?? null,
    undelivered: localStorage.getItem(MOCK_SCENARIO_KEY) === "undelivered",
    feedback: db.feedback,
    documents: db.documents,
    suggestionStatus: (id) => withSuggestion(db.llm, { id } as FeedbackRow).suggestion?.status ?? null,
    staged: (id) => isStaged(withSuggestion(db.llm, { id } as FeedbackRow).suggestion),
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
  const scenario = localStorage.getItem(MOCK_SCENARIO_KEY);
  const db = seeded(
    "db",
    scenario === "empty" ? seedEmpty : scenario === "large" ? seedLarge : scenario === "suggestions"
        ? seedSuggestions
        : scenario === "big-prd"
          ? seedBigPrd
          : seed,
  );
  // Revokes a disable could not make: none, unless a spec asks for them.
  db.revoke_failures = scenario === "revoke-failures" ? seedRevokeFailures() : [];
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
    notes: v.notes,
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
    date_marks: [],
    sections: v.sections.map((s) => {
      const r = latestReview(db, v.id, s.section_key);
      return {
        ...s,
        verdict: r
          ? {
              verdict: r.verdict,
              note: r.note,
              reviewer_id: r.reviewer_id,
              created_at: r.created_at,
              // An approval that lapsed (C2): set on a stored review by the specs.
              ...(r.lapsed_at ? { lapsed_at: r.lapsed_at, lapse_reason: r.lapse_reason ?? null } : {}),
            }
          : null,
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
        `  - id: ${c.cite_key}\n    source: ${c.source}\n    ref: ${c.ref}\n    title: ${JSON.stringify(c.title ?? "")}\n    excerpt: ${JSON.stringify(c.excerpt ?? "")}` +
        (c.item_id ? `\n    item: ${c.item_id}` : "") +
        (c.confidence != null ? `\n    confidence: ${c.confidence}` : "") +
        (c.confidence_note ? `\n    confidence_note: ${JSON.stringify(c.confidence_note)}` : "") +
        (c.low_confidence ? "\n    low_confidence: true" : ""),
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
    // As the API's export: an "oracle" citation's ref names a baseline item, not a link.
    .map((c) =>
      c.source === "oracle"
        ? `<li>${escapeHtml(c.title ?? c.ref)} <span>${escapeHtml(c.ref)}</span> (${c.source})</li>`
        : `<li><a href="${escapeHtml(c.ref)}">${escapeHtml(c.title ?? c.ref)}</a> (${c.source})</li>`,
    )
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
    // A disabled owner is not another owner.
    const otherOwner = db.members.some((x) => x.id !== target.id && x.role === "owner" && x.status !== "disabled");
    if (m === "PATCH") {
      const { role } = await body<Schemas["MemberPatch"]>();
      if (target.role === "owner" && role !== "owner" && target.status !== "disabled" && !otherOwner) {
        return json(409, { detail: "Cannot demote the last owner; make someone else owner" });
      }
      target.role = role;
      return json(200, target);
    }
    // Removing a member disables them (C2): the row stays; an owner can restore them.
    if ((m === "POST" && p[3] === "disable") || (m === "DELETE" && !p[3])) {
      if (target.status !== "disabled") {
        if (target.role === "owner" && !otherOwner) {
          return json(409, { detail: "Cannot remove the last owner; make someone else owner" });
        }
        Object.assign(target, { status: "disabled", disabled_at: now(), disabled_by: me.id });
        for (const i of db.invites) {
          if (i.email === target.email && i.status === "open") Object.assign(i, { status: "revoked", revoked_at: now() });
        }
      }
      return m === "DELETE" ? json(204, undefined) : json(200, target);
    }
    if (m === "POST" && p[3] === "restore") {
      Object.assign(target, { status: "active", disabled_at: null, disabled_by: null });
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

/** The v2 review mock's view of the db; a section save copies the latest version. */
function reviewV2Context(db: Db, userId: string, role: Role) {
  return {
    db: db.review_v2!,
    documents: db.documents,
    versions: db.versions,
    reviews: db.reviews,
    me: { id: userId, role },
    uuid,
    now,
    hash,
    exportHtml: (doc: { id: string }, v: { id: string }) =>
      exportHtml(db.documents.find((d) => d.id === doc.id)!, db.versions.find((x) => x.id === v.id)!),
    editSection: (doc: { id: string }, key: string, heading: string | null, bodyMd: string) => {
      const latest = docVersions(db, db.documents.find((d) => d.id === doc.id)!).pop()!;
      const sections = latest.sections.map((s) =>
        s.section_key === key
          ? { ...s, id: uuid(), heading: heading ?? s.heading, body_md: bodyMd, body_text: plainText(bodyMd), content_hash: hash(`${s.level}\n${heading ?? s.heading}\n${bodyMd}`) }
          : { ...s, id: uuid() },
      );
      const next: VersionRow = {
        ...latest,
        id: uuid(),
        number: latest.number + 1,
        content_hash: hash(sections.map((s) => s.content_hash).join(":")),
        approved_at: null,
        approval_lapses: [],
        warnings: [],
        created_at: now(),
        sections,
      };
      db.versions.push(next);
      touch(db, doc.id);
      return versionOut(db, next);
    },
  };
}

/**
 * The PRDs in review trace to the baseline: their goal-trace and scope sections link the
 * goals and features they serve, so Home and the trace show goal tags.
 */
function goalLinks(db: Db): V2Db["section_links"] {
  const out: V2Db["section_links"] = [];
  const link = (slug: string, section: string, entityKey: string) => {
    const doc = findDocument(db, slug);
    const v = doc && docVersions(db, doc).at(-1);
    const e = db.baseline.entities.find((x) => x.key === entityKey);
    if (!doc || !v || !e || !v.sections.some((s) => s.section_key === section)) return;
    out.push({
      id: uuid(), document_id: doc.id, version_id: v.id, section_key: section, section_hash: null, composition_revision: null,
      module_key: null, kind: "implements", entity_id: e.id, evidence_id: null, source_item_id: null, precision: "section",
      claim: null, created_by: null, created_at: v.created_at,
    });
  };
  link("checkout-redesign", "goal-trace", "g.activation");
  link("checkout-redesign", "goal-trace", "g.paid-conversion");
  link("team-workspaces", "scope", "f.team-invites");
  return out;
}

/** The v2 rows, seeded on first use against the first mock PRD. */
function ensureV2(db: Db): V2Db {
  if (!db.v2) {
    const prd = db.documents.find((d) => d.kind === "prd");
    const version = db.versions.find((v) => v.document_id === prd?.id) ?? null;
    db.v2 = seeded("v2", () => {
      const v2 = seedV2(prd?.id ?? db.tenant_id, version?.id ?? null, db.user_id);
      v2.section_links.push(...goalLinks(db));
      return v2;
    });
  }
  return db.v2;
}

function requestsContext(db: Db, userId: string, role: Role): RequestsContext {
  return {
    userId,
    role,
    goals: () => db.baseline.entities.filter((e) => e.type === "goal"),
    features: () => db.baseline.entities.filter((e) => e.type === "feature" && e.status !== "rejected"),
    documents: () =>
      db.documents
        .filter((d) => d.kind === "prd")
        .map((d) => {
          const latest = docVersions(db, d).at(-1);
          const sections = latest?.sections.length ?? 0;
          return {
            id: d.id,
            slug: d.slug,
            title: d.title,
            latest_version: latest?.number ?? null,
            sections,
            reviewed_sections: latest?.approved_at ? sections : 0,
          };
        }),
  };
}

/** The requests rows, seeded on first use against the baseline's confirmed goals. */
function ensureRequests(db: Db): RequestsDb {
  db.requests ??= seeded("requests", () =>
    seedRequests({
      ownerId: db.user_id,
      goals: db.baseline.entities.filter((e) => e.type === "goal" && e.status === "confirmed"),
      features: db.baseline.entities.filter((e) => e.type === "feature" && e.status !== "rejected"),
    }),
  );
  return db.requests;
}

function ensureBlockers(db: Db): BlockersDb {
  if (!db.blockers) {
    const v2 = ensureV2(db);
    const deposits = db.documents.find((d) => d.slug === "online-deposits");
    db.blockers = seedBlockers(
      db.documents.find((d) => d.kind === "prd")?.id ?? db.tenant_id,
      db.user_id,
      deposits && { documentId: deposits.id, v2 },
    );
  }
  return db.blockers;
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
    if (!member || member.status === "disabled" || password !== MOCK_LOGIN.password) {
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
  if (!member || member.status === "disabled") return json(401, { detail: "Not authenticated" });
  const me = withMockRole(member);
  // v2 review routes (./review-v2.ts) check roles themselves.
  if (!db.review_v2) {
    const prd = db.documents.find((d) => d.kind === "prd");
    db.review_v2 = seedReviewV2(prd, prd ? docVersions(db, prd).pop() : undefined, db.user_id);
  }
  const reviewV2 = await routeReviewV2(reviewV2Context(db, me.id, me.role), req, p, q);
  if (reviewV2) return reviewV2;
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
  // Trace, impact, staleness and evidence-inspector routes (./trace.ts), on the v2 rows.
  if (["documents", "section-links", "baseline", "trace"].includes(p[1])) {
    const traced = await routeTrace(
      {
        v2: ensureV2(db),
        documents: db.documents,
        versions: db.versions,
        entities: db.baseline.entities,
        edges: db.baseline.edges,
        userId: me.id,
        role: me.role,
        now,
        uuid,
      },
      req,
      p,
      q,
    );
    if (traced) return traced;
  }
  // The baseline mock checks roles itself (commenters propose, approvers decide).
  if (p[1] === "baseline") {
    return routeBaseline(db.baseline, { userId: me.id, role: me.role }, req, p.slice(2), q);
  }
  // Sources and connections belong to each user: every role manages their own.
  if (["sources", "source-items", "snapshots", "search"].includes(p[1])) return routeSources(req, p, q);
  const fireflies = routeFirefliesBrowse(p, q);
  if (fireflies) return fireflies;
  // Company settings are the owner's, as in the API (tenant_settings_api.py).
  if (p[1] === "settings" && !atLeast(me.role, "owner")) return forbidden("owner");
  const browse = sourceBrowseRoute(req, p, q);
  if (browse) return browse;
  const connections = await connectionsRoute(req, p);
  if (connections) return connections;
  // The Claude account pool checks roles itself: every member reads, owners change.
  const pool = await claudeAccountsRoute(req, p, q, me.role);
  if (pool) return pool;
  // Built-in model jobs check roles themselves (approvers decide, owners set them up).
  db.llm ??= seeded("llm", () => seedLlm(llmContext(db, db.user_id, "owner")));
  const llm = llmContext(db, me.id, me.role);
  const jobs = await llmJobsRoute(llm, req, p, q);
  if (jobs) return jobs;
  // PRD quality and readiness, outcomes and learnings (./quality.ts) check roles themselves.
  const v2db = ensureV2(db);
  db.quality ??= seedQuality();
  const qualityCtx: QualityContext = {
    db: db.quality,
    v2: v2db,
    userId: me.id,
    role: me.role,
    findVersion: (ref, n) => {
      const doc = findDocument(db, ref);
      const v = doc && findVersion(db, doc, n);
      return doc && v ? { documentId: doc.id, slug: doc.slug, versionId: v.id } : null;
    },
    blockerGate: (documentId) => documentGate(ensureBlockers(db), documentId),
  };
  const quality = await routeQuality(qualityCtx, req, p, q);
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
  // Intake, gaps, questions and answers (CR-03) check roles themselves: commenters
  // answer and propose, approvers decide, owners accept a critical risk.
  if (["intakes", "gaps", "questions", "intake-proposals"].includes(p[1])) {
    const createRun = (input: Schemas["RunCreate"]) => {
      db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
      const run = new Request(new URL("/v1/runs", req.url), { method: "POST", body: JSON.stringify(input) });
      return routeRuns({ ...runsContext(db), db: db.runs }, run, ["v1", "runs"]).then((r) => r ?? notFound("Route"));
    };
    const intake = await routeIntake(v2db, { userId: me.id, role: me.role, createRun }, req, p, q);
    if (intake) return intake;
  }
  // Requests and their themes (C1) check roles themselves: commenters add, approvers decide.
  if (["requests", "request-themes", "request-candidates"].includes(p[1])) {
    const requests = await routeRequests(ensureRequests(db), requestsContext(db, me.id, me.role), req, p, q);
    if (requests) return requests;
  }
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
    const patch = await body<Schemas["FeedbackPatch"]>();
    // As the API: reopening clears the version it was addressed in, unless one is given.
    if (patch.status === "open" && !("addressed_in_version" in patch)) patch.addressed_in_version = null;
    Object.assign(f, patch, { updated_at: now() });
    return json(200, f);
  }

  // Product Oracle v2 read routes; viewers read (lanes add writes in ./v2.ts).
  const v2Db = ensureV2(db);
  // Blocker strategy routes (CR-04): writes on the v2 option, experiment and event rows.
  const blockerContext = { userId: me.id, role: me.role, v2: v2Db, documents: db.documents, baseline: db.baseline };
  const blockers = await routeBlockers(blockerContext, ensureBlockers(db), req, p, q);
  if (blockers) return blockers;
  const v2 = routeV2(v2Db, req, p, q, me.id);
  if (v2) return v2;

  // Roadmap alignment and product tracks (CR-11).
  const roadmapCtx: RoadmapContext = { userId: me.id, role: me.role, documents: db.documents, versions: db.versions };
  db.roadmap ??= seedRoadmap(roadmapCtx);
  const roadmapRes = await routeRoadmap(roadmapCtx, db.roadmap, req, p, q);
  if (roadmapRes) return roadmapRes;
  if (p[1] === "tracks" && p[3] === "roadmap-run" && m === "POST") {
    if (!atLeast(me.role, "approver")) return json(403, { detail: "Requires the approver role" });
    const run = trackRunBody(roadmapCtx, db.roadmap, p[2]);
    if (!run) return notFound("Track");
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    const forwarded = new Request(new URL("/v1/runs", req.url), { method: "POST", body: JSON.stringify(run), headers: { "Content-Type": "application/json" } });
    return (await routeRuns({ ...runsContext(db), db: db.runs }, forwarded, ["v1", "runs"]))!;
  }

  const handled = await laneF(db, req, p, m);
  if (handled) return handled;

  const followUp = followUpsRoute(db, req, p, me);
  if (followUp) return followUp;

  db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
  const runs = await routeRuns({ ...runsContext(db), db: db.runs }, req, p);
  if (runs && p[1] === "inbox") {
    tick(llm);
    const inbox = withInboxStates(db, llm, me, await runs.json(), q.get("mark_seen") === "true");
    // Owners also see the provider revokes a removed member's disable could not make.
    db.revoke_failures ??= [];
    const failures = atLeast(me.role, "owner")
      ? db.revoke_failures.filter((r) => !r.dismissed).map((r) => ({ ...r, dismissed: undefined }))
      : [];
    return json(200, { ...inbox, revoke_failures: failures, total: inbox.total + failures.length });
  }
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
      // As the API: by the version raised on, then age.
      .sort((a, b) => a.raised_on_version - b.raised_on_version || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((f) => withSuggestion(db.llm, f, docVersions(db, doc).at(-1)?.number ?? null));
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

  if (!sub) {
    // O4 'document dates': a roadmap's dates against its PRD's schedule bases now.
    const marks = doc.kind === "roadmap" && db.roadmap ? dateMarks(db.roadmap, v.source?.document_id, v.sections) : [];
    return json(200, { ...versionOut(db, v), date_marks: marks });
  }
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
      .map((f) => withSuggestion(db.llm, f, docVersions(db, doc).at(-1)?.number ?? null));
    const counts: Record<string, number> = {};
    for (const f of items) counts[f.status] = (counts[f.status] ?? 0) + 1;
    return json(200, { document_id: doc.id, version: v.number, items, counts });
  }
  if (sub === "approve" && m === "POST") {
    // The publish gate (T2 follow-up): a PRD is refused while blocked, or when not the latest.
    if (doc.kind === "prd") {
      const latest = docVersions(db, doc).pop()!.number;
      const refusal = publishRefusal(qualityCtx, { documentId: doc.id, slug: doc.slug, versionId: v.id }, v.number, latest, (id) =>
        ensureBlockers(db).blockers.find((b) => b.id === id)?.statement,
      );
      if (refusal) return json(409, refusal);
    }
    // O4 'document dates' (owner, 2026-10-20): not while a date of the roadmap is marked.
    if (doc.kind === "roadmap" && db.roadmap && !v.approved_at) {
      const marked = dateMarks(db.roadmap, v.source?.document_id, v.sections).filter((d) => d.label);
      if (marked.length) {
        return json(409, {
          detail: `${marked.length} date${marked.length === 1 ? " rests" : "s rest"} on no verified basis: ${marked
            .map((d) => `${d.text} (${d.section_key}: ${d.label})`)
            .join(", ")}`,
          blocking: marked.map((d) => ({ key: "unverified_date", id: `${d.section_key}:${d.text}`, title: d.text, rationale: `${d.text} is marked ${d.label}` })),
          dates: marked,
        });
      }
    }
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

/** One request at a time: each loads the whole db and saves it back, so two in flight would lose a write. */
let queue: Promise<unknown> = Promise.resolve();

export async function mockFetch(req: Request): Promise<Response> {
  // Every call, in order: tests count them (Home's call budget).
  const url = new URL(req.url);
  const log = ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ??= []);
  log.push(`${req.method} ${url.pathname}${url.search}`);
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  if (req.method === "GET" && url.pathname === localStorage.getItem(MOCK_FAIL_KEY)) {
    return new Response(JSON.stringify({ detail: "Mock failure" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const next = queue.then(async () => {
    const db = load();
    const res = await route(db, req);
    save(db);
    return res;
  });
  queue = next.catch(() => undefined);
  return next;
}
