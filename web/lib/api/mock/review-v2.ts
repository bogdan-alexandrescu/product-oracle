/**
 * Mock of the v2 review routes (api/oracle/review/v2_router.py, lane v2-review) for
 * NEXT_PUBLIC_API_MOCKS=1: section review state per revision, assignments and due
 * dates, the review policy, section edits with 409 conflicts, section patches,
 * feedback campaigns, in-app notifications, the publish check and publications.
 * No screen uses them yet (the UI wave builds them on the design system); the fixtures
 * let it start against the mock. Synthetic placeholders only.
 */
import type { Schemas } from "@/lib/api/client";

type Role = "viewer" | "commenter" | "approver" | "owner";
type SectionRow = { section_key: string; heading: string; ordinal: number; layer: "brief" | "detail"; content_hash: string; body_md: string; body_text: string; level: number };
type VersionLike = { id: string; document_id: string; number: number; content_hash: string; approved_at?: string | null; markdown?: string; sections: SectionRow[] };
type DocumentLike = { id: string; slug: string; title: string };
type ReviewLike = { version_id: string; section_key: string; verdict: string; reviewer_id?: string | null; created_at: string; id: string };

export interface ReviewV2Db {
  assignments: Schemas["SectionAssignmentOut"][];
  policies: Schemas["ReviewPolicyOut"][];
  patches: Schemas["SectionPatchOut"][];
  campaigns: Schemas["CampaignOut"][];
  notifications: (Schemas["NotificationOut"] & { user_id: string })[];
  publications: (Schemas["PublicationOut"] & { html: string })[];
}

export interface ReviewV2Context {
  db: ReviewV2Db;
  documents: DocumentLike[];
  versions: VersionLike[];
  reviews: ReviewLike[];
  me: { id: string; role: Role };
  uuid: () => string;
  now: () => string;
  hash: (text: string) => string;
  /** Imports the latest version of `doc` with one section replaced; returns VersionOut. */
  editSection: (doc: DocumentLike, key: string, heading: string | null, body: string) => unknown;
  exportHtml: (doc: DocumentLike, v: VersionLike) => string;
}

const ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ORDER.indexOf(role) >= ORDER.indexOf(min);
const AT = "2026-10-19T09:00:00Z";

/** A copy of `row` without `keys` (fields the API does not return). */
function without<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Seeded for the first PRD: one assignment due soon, an open campaign and patch, two notifications. */
export function seedReviewV2(doc: DocumentLike | undefined, latest: VersionLike | undefined, userId: string): ReviewV2Db {
  const db: ReviewV2Db = { assignments: [], policies: [], patches: [], campaigns: [], notifications: [], publications: [] };
  if (!doc || !latest || !latest.sections.length) return db;
  const target = latest.sections.find((s) => s.section_key !== "title") ?? latest.sections[0];
  db.assignments.push({
    document_id: doc.id, section_key: target.section_key, owner_id: userId, reviewer_ids: [userId],
    due_at: "2026-10-24T17:00:00Z", overdue: false, lock_version: 1, updated_at: AT,
  });
  const campaign = "c0000000-0000-4000-8000-000000000001";
  db.campaigns.push({
    id: campaign, document_id: doc.id, version_number: latest.number, title: "Company-wide feedback",
    message: "Comment on anything that looks wrong; the decider approves.", due_at: "2026-10-26T17:00:00Z",
    audience_roles: ["commenter", "approver", "owner"], status: "open", created_by: userId, closed_by: null,
    closed_at: null, lock_version: 1, created_at: AT, updated_at: AT, invited: 4, comments: 2, participants: 2,
    open_change_requests: 1,
  });
  db.patches.push({
    id: "p0000000-0000-4000-8000-000000000001", document_id: doc.id, section_key: target.section_key,
    base_version: latest.number, base_hash: target.content_hash, heading: target.heading,
    body_md: `${target.body_md}\n\nAn agent proposed this added sentence.`, origin: "run", action: "replace", run_id: null,
    rationale: "An agent draft rewrote this approved section; the approved text was kept. Review the rewrite as a diff.",
    status: "open", created_by: userId, decided_by: null, decided_at: null, decision_note: null, applied_version: null,
    lock_version: 1, created_at: AT, updated_at: AT,
  });
  db.notifications.push(
    { id: "n0000000-0000-4000-8000-000000000001", user_id: userId, kind: "assignment", title: `You were asked to review ${target.section_key} in ${doc.title}`, document_id: doc.id, version_number: latest.number, section_key: target.section_key, comment_id: null, campaign_id: null, actor: "system", data: {}, read_at: null, created_at: AT },
    { id: "n0000000-0000-4000-8000-000000000002", user_id: userId, kind: "campaign", title: `Feedback wanted on ${doc.title} v${latest.number}`, document_id: doc.id, version_number: latest.number, section_key: null, comment_id: null, campaign_id: campaign, actor: "system", data: {}, read_at: null, created_at: AT },
  );
  return db;
}

function policyOf(ctx: ReviewV2Context, doc: DocumentLike): Schemas["ReviewPolicyOut"] {
  return (
    ctx.db.policies.find((p) => p.document_id === doc.id) ?? {
      document_id: doc.id, decider_id: null, mandatory_reviewer_ids: [], required_section_keys: [],
      section_approval: "required_sections", rereview_on_change: true, source: "default", lock_version: null,
    }
  );
}

function statesOf(ctx: ReviewV2Context, doc: DocumentLike, v: VersionLike): Schemas["SectionStatesOut"] {
  const versions = ctx.versions.filter((x) => x.document_id === doc.id && x.number <= v.number);
  const policy = policyOf(ctx, doc);
  const counts: Record<string, number> = {};
  const sections = v.sections.map((s): Schemas["SectionStateOut"] => {
    const hashOf = (r: ReviewLike) => versions.find((x) => x.id === r.version_id)?.sections.find((y) => y.section_key === s.section_key)?.content_hash;
    const verdicts = ctx.reviews.filter((r) => r.section_key === s.section_key && versions.some((x) => x.id === r.version_id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const onRev = verdicts.filter((r) => hashOf(r) === s.content_hash);
    const last = onRev[onRev.length - 1] ?? verdicts[verdicts.length - 1];
    let status: Schemas["SectionStateOut"]["status"] = "unreviewed";
    if (last) {
      const same = hashOf(last) === s.content_hash;
      status = last.verdict === "approved" ? (same ? "approved" : "approval_stale") : same ? (last.verdict as "rejected" | "changes_requested") : "revised";
    }
    counts[status] = (counts[status] ?? 0) + 1;
    const a = ctx.db.assignments.find((x) => x.document_id === doc.id && x.section_key === s.section_key);
    const approver = last && last.verdict === "approved" ? last : null;
    return {
      section_key: s.section_key, heading: s.heading, ordinal: s.ordinal, layer: s.layer, revision: s.content_hash,
      revision_since_version: v.number, status,
      approval: approver ? { review_id: approver.id, reviewer_id: approver.reviewer_id ?? null, version: versions.find((x) => x.id === approver.version_id)?.number ?? v.number, revision: hashOf(approver) ?? null, approved_at: approver.created_at } : null,
      invalidated: status === "approval_stale" ? { at: AT, change_id: null, revision: approver ? hashOf(approver) ?? null : null } : null,
      rereview_requested: status === "approval_stale" && policy.rereview_on_change,
      required: policy.required_section_keys.includes(s.section_key),
      approval_required: policy.section_approval === "all_sections" || (policy.section_approval === "required_sections" && policy.required_section_keys.includes(s.section_key)),
      mandatory_approvals: policy.mandatory_reviewer_ids.map((id) => ({ reviewer_id: id, approved: false })),
      owner_id: a?.owner_id ?? null, reviewer_ids: a?.reviewer_ids ?? [], due_at: a?.due_at ?? null,
      overdue: !!a?.due_at && a.due_at < ctx.now() && status !== "approved", open_feedback: 0, open_by_severity: {},
      lock_version: a?.lock_version ?? null,
    };
  });
  const latest = Math.max(...ctx.versions.filter((x) => x.document_id === doc.id).map((x) => x.number));
  return { document_id: doc.id, version: v.number, latest_version: latest, sections, counts };
}

function publishCheck(ctx: ReviewV2Context, doc: DocumentLike, v: VersionLike): Schemas["PublishCheckOut"] {
  const states = statesOf(ctx, doc, v);
  const policy = policyOf(ctx, doc);
  const blockers: Schemas["PublishProblem"][] = [];
  if (!v.approved_at) blockers.push({ code: "version_not_approved", message: `Version ${v.number} needs an approver's approval`, section_keys: [], check_key: null, ids: [] });
  const missing = policy.required_section_keys.filter((k) => !v.sections.some((s) => s.section_key === k));
  if (missing.length) blockers.push({ code: "missing_required_section", message: `Required sections are missing: ${missing.join(", ")}`, section_keys: missing, check_key: null, ids: [] });
  const stale = states.sections.filter((s) => s.approval_required && s.status === "approval_stale").map((s) => s.section_key);
  if (stale.length) blockers.push({ code: "stale_approval", message: `These sections changed after they were approved: ${stale.join(", ")}`, section_keys: stale, check_key: null, ids: [] });
  const unapproved = states.sections.filter((s) => s.approval_required && !["approved", "approval_stale"].includes(s.status)).map((s) => s.section_key);
  if (unapproved.length) blockers.push({ code: "missing_approval", message: `These sections need an approval of their current text: ${unapproved.join(", ")}`, section_keys: unapproved, check_key: null, ids: [] });
  if (ctx.db.publications.some((p) => p.version_id === v.id)) blockers.push({ code: "already_published", message: `Version ${v.number} is already published`, section_keys: [], check_key: null, ids: [] });
  return {
    document_id: doc.id, version: v.number, content_hash: v.content_hash, can_publish: blockers.length === 0, blockers,
    warnings: [], required_sections: policy.required_section_keys,
    approval_required_sections: states.sections.filter((s) => s.approval_required).map((s) => s.section_key),
    decider_id: policy.decider_id ?? null, approved_at: v.approved_at ?? null, approved_by: null, readiness: [],
  };
}

function summaryOf(p: ReviewV2Db["publications"][number]): Schemas["PublicationSummary"] {
  return without(p, "manifest", "markdown", "html");
}

/** Handles the v2 review routes (each checks its own role); null for other routes. */
export async function routeReviewV2(ctx: ReviewV2Context, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const need = (role: Role) => (atLeast(ctx.me.role, role) ? null : json(403, { detail: `Requires the ${role} role` }));
  const conflict = (current: number | null) => json(409, { detail: "Someone else changed this since you loaded it; reload and try again", code: "stale_lock_version", current_lock_version: current, sections: [] });

  if (p[1] === "me" && p[2] === "notifications") {
    const mine = ctx.db.notifications.filter((n) => n.user_id === ctx.me.id);
    if (p[3] === "read-all" && m === "POST") {
      const unread = mine.filter((n) => !n.read_at);
      unread.forEach((n) => (n.read_at = ctx.now()));
      return json(200, { marked: unread.length });
    }
    if (m === "GET") {
      const unread = q.get("unread") === "true";
      return json(200, mine.filter((n) => !unread || !n.read_at).map((n) => without(n, "user_id")).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }
  }
  if (p[1] === "notifications" && p[3] === "read" && m === "POST") {
    const n = ctx.db.notifications.find((x) => x.id === p[2] && x.user_id === ctx.me.id);
    if (!n) return json(404, { detail: "Notification not found" });
    n.read_at ??= ctx.now();
    return json(200, without(n, "user_id"));
  }
  if (p[1] === "me" && p[2] === "review-queue" && m === "GET") {
    const items: Schemas["ReviewQueueItem"][] = [];
    for (const a of ctx.db.assignments) {
      const role = a.owner_id === ctx.me.id ? "owner" : a.reviewer_ids.includes(ctx.me.id) ? "reviewer" : null;
      const doc = ctx.documents.find((d) => d.id === a.document_id);
      const latest = ctx.versions.filter((v) => v.document_id === a.document_id).sort((x, y) => y.number - x.number)[0];
      const state = doc && latest ? statesOf(ctx, doc, latest).sections.find((s) => s.section_key === a.section_key) : undefined;
      if (!role || !doc || !latest || !state) continue;
      items.push({ document_id: doc.id, slug: doc.slug, title: doc.title, version: latest.number, section_key: a.section_key, heading: state.heading, role, status: state.status, rereview_requested: state.rereview_requested ?? false, due_at: a.due_at ?? null, overdue: state.overdue ?? false });
    }
    return json(200, items);
  }

  if (p[1] === "section-patches" && p[2]) {
    const patch = ctx.db.patches.find((x) => x.id === p[2]);
    if (!patch) return json(404, { detail: "Section patch not found" });
    const doc = ctx.documents.find((d) => d.id === patch.document_id)!;
    const latest = ctx.versions.filter((v) => v.document_id === doc.id).sort((x, y) => y.number - x.number)[0];
    const current = latest.sections.find((s) => s.section_key === patch.section_key);
    if (!p[3] && m === "GET") {
      const words = [
        ...(current?.body_text ?? "").split(/\s+/).filter(Boolean).map((text) => ({ op: "equal" as const, text })),
        ...["An", "agent", "proposed", "this", "added", "sentence."].map((text) => ({ op: "insert" as const, text })),
      ];
      return json(200, { ...patch, latest_version: latest.number, current_revision: current?.content_hash ?? null, current_heading: current?.heading ?? null, current_body_md: current?.body_md ?? null, rebase_needed: current?.content_hash !== patch.base_hash, words });
    }
    const denied = need("approver");
    if (denied) return denied;
    const input = await body<{ lock_version: number; base_revision?: string; body_md?: string | null; heading?: string | null; note?: string | null }>();
    if (input.lock_version !== patch.lock_version) return conflict(patch.lock_version);
    if (patch.status !== "open") return json(409, { detail: `an ${patch.status} patch cannot be decided` });
    if (p[3] === "reject" && m === "POST") {
      Object.assign(patch, { status: "rejected", decided_by: ctx.me.id, decided_at: ctx.now(), decision_note: input.note ?? null, lock_version: patch.lock_version + 1 });
      return json(200, patch);
    }
    if (p[3] === "accept" && m === "POST") {
      if (input.base_revision !== current?.content_hash) {
        return json(409, { detail: `section ${patch.section_key} changed since you loaded it`, code: "section_conflict", base_version: patch.base_version, latest_version: latest.number, sections: [{ section_key: patch.section_key, base_revision: input.base_revision, current_revision: current?.content_hash ?? null, current_heading: current?.heading ?? null, current_body_md: current?.body_md ?? null }] });
      }
      const out = ctx.editSection(doc, patch.section_key, input.heading ?? patch.heading, input.body_md ?? patch.body_md);
      Object.assign(patch, { status: "accepted", decided_by: ctx.me.id, decided_at: ctx.now(), decision_note: input.note ?? null, applied_version: latest.number + 1, lock_version: patch.lock_version + 1 });
      return json(201, out);
    }
  }

  if (p[1] === "campaigns" && p[2]) {
    const c = ctx.db.campaigns.find((x) => x.id === p[2]);
    if (!c) return json(404, { detail: "Campaign not found" });
    if (m === "GET") return json(200, c);
    if (m === "PATCH") {
      const denied = need("approver");
      if (denied) return denied;
      const input = await body<Schemas["CampaignPatch"]>();
      if (input.lock_version !== c.lock_version) return conflict(c.lock_version);
      Object.assign(c, { status: input.status, closed_at: input.status === "closed" ? ctx.now() : null, closed_by: input.status === "closed" ? ctx.me.id : null, lock_version: c.lock_version + 1, updated_at: ctx.now() });
      return json(200, c);
    }
  }

  if (p[1] !== "documents" || !p[2]) return null;
  const doc = ctx.documents.find((d) => d.slug === p[2] || d.id === p[2]);
  if (!doc) return null;
  const versions = ctx.versions.filter((v) => v.document_id === doc.id).sort((a, b) => a.number - b.number);
  const latest = versions[versions.length - 1];

  if (p[3] === "versions" && p[4] && (p[5] === "section-states" || p[5] === "publish-check" || p[5] === "publish")) {
    const v = versions.find((x) => x.number === Number(p[4]));
    if (!v) return json(404, { detail: "Version not found" });
    if (p[5] === "section-states" && m === "GET") return json(200, statesOf(ctx, doc, v));
    if (p[5] === "publish-check" && m === "GET") return json(200, publishCheck(ctx, doc, v));
    if (p[5] === "publish" && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      const check = publishCheck(ctx, doc, v);
      if (!check.can_publish) return json(409, { detail: `publish refused: ${check.blockers.map((b) => b.code).join(", ")}`, check });
      const number = ctx.db.publications.filter((x) => x.document_id === doc.id).length + 1;
      const pub = {
        id: ctx.uuid(), document_id: doc.id, number, version_id: v.id, version_number: v.number, content_hash: v.content_hash,
        manifest_hash: ctx.hash(`${v.content_hash}:${number}`), published_by: ctx.me.id, created_at: ctx.now(), has_brief: v.sections.some((s) => s.layer === "brief"),
        manifest: { format: 1, document: { id: doc.id, slug: doc.slug, title: doc.title }, version: { id: v.id, number: v.number, content_hash: v.content_hash }, approval: { approved_at: v.approved_at ?? null, decider_id: check.decider_id }, sections: statesOf(ctx, doc, v).sections.map((s) => ({ section_key: s.section_key, revision: s.revision, status: s.status })) },
        markdown: v.markdown ?? "", html: ctx.exportHtml(doc, v),
      };
      ctx.db.publications.push(pub);
      return json(201, without(pub, "html"));
    }
  }
  if (p[3] === "section-assignments" && m === "GET") return json(200, ctx.db.assignments.filter((a) => a.document_id === doc.id));
  if (p[3] === "sections" && p[4] && p[5] === "assignment" && m === "PUT") {
    const denied = need("approver");
    if (denied) return denied;
    const input = await body<Schemas["SectionAssignmentIn"]>();
    let row = ctx.db.assignments.find((a) => a.document_id === doc.id && a.section_key === p[4]);
    if ((row?.lock_version ?? null) !== (input.lock_version ?? null)) return conflict(row?.lock_version ?? null);
    if (!row) {
      row = { document_id: doc.id, section_key: p[4], owner_id: null, reviewer_ids: [], due_at: null, overdue: false, lock_version: 0, updated_at: ctx.now() };
      ctx.db.assignments.push(row);
    }
    Object.assign(row, { owner_id: input.owner_id ?? null, reviewer_ids: input.reviewer_ids ?? [], due_at: input.due_at ?? null, lock_version: row.lock_version + 1, updated_at: ctx.now() });
    return json(200, row);
  }
  if (p[3] === "sections" && p[4] && !p[5] && m === "PUT") {
    const denied = need("commenter");
    if (denied) return denied;
    const input = await body<Schemas["SectionEditIn"]>();
    const current = latest?.sections.find((s) => s.section_key === p[4]);
    if (!current || current.content_hash !== input.base_revision) {
      return json(409, { detail: `section ${p[4]} changed since you loaded it (version ${input.base_version}); merge it and save again`, code: "section_conflict", base_version: input.base_version, latest_version: latest?.number ?? null, sections: [{ section_key: p[4], base_revision: input.base_revision, current_revision: current?.content_hash ?? null, current_heading: current?.heading ?? null, current_body_md: current?.body_md ?? null }] });
    }
    return json(201, ctx.editSection(doc, p[4], input.heading ?? null, input.body_md));
  }
  if (p[3] === "review-policy") {
    if (m === "GET") return json(200, policyOf(ctx, doc));
    if (m === "PUT") {
      const denied = need("owner");
      if (denied) return denied;
      const input = await body<Schemas["ReviewPolicyIn"]>();
      const existing = ctx.db.policies.find((x) => x.document_id === doc.id);
      if ((existing?.lock_version ?? null) !== (input.lock_version ?? null)) return conflict(existing?.lock_version ?? null);
      const next: Schemas["ReviewPolicyOut"] = { document_id: doc.id, decider_id: input.decider_id ?? null, mandatory_reviewer_ids: input.mandatory_reviewer_ids ?? [], required_section_keys: input.required_section_keys ?? [], section_approval: input.section_approval ?? "required_sections", rereview_on_change: input.rereview_on_change ?? true, source: "document", lock_version: (existing?.lock_version ?? 0) + 1 };
      ctx.db.policies = [...ctx.db.policies.filter((x) => x.document_id !== doc.id), next];
      return json(200, next);
    }
  }
  if (p[3] === "section-patches" && m === "GET") {
    const status = q.get("status");
    return json(200, ctx.db.patches.filter((x) => x.document_id === doc.id && (!status || x.status === status)));
  }
  if (p[3] === "campaigns") {
    if (m === "GET") return json(200, ctx.db.campaigns.filter((c) => c.document_id === doc.id));
    if (m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      const input = await body<Schemas["CampaignCreate"]>();
      const c: Schemas["CampaignOut"] = { id: ctx.uuid(), document_id: doc.id, version_number: input.version ?? latest?.number ?? 1, title: input.title, message: input.message ?? null, due_at: input.due_at ?? null, audience_roles: input.audience_roles ?? ["commenter", "approver", "owner"], status: "open", created_by: ctx.me.id, closed_by: null, closed_at: null, lock_version: 1, created_at: ctx.now(), updated_at: ctx.now(), invited: 0, comments: 0, participants: 0, open_change_requests: 0 };
      ctx.db.campaigns.unshift(c);
      return json(201, c);
    }
  }
  if (p[3] === "publications") {
    const mine = ctx.db.publications.filter((x) => x.document_id === doc.id);
    if (!p[4] && m === "GET") return json(200, mine.map(summaryOf));
    const pub = mine.find((x) => x.number === Number(p[4]));
    if (!pub) return json(404, { detail: `Publication ${p[4]} not found` });
    if (!p[5] && m === "GET") return json(200, without(pub, "html"));
    if (p[5] === "export" && m === "GET") {
      if (q.get("format") === "md") return new Response(pub.markdown, { status: 200, headers: { "Content-Type": "text/markdown" } });
      return new Response(pub.html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  }
  return null;
}
