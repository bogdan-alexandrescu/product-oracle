/**
 * Mock of the trace lane's routes (api/oracle/trace/router.py) for NEXT_PUBLIC_API_MOCKS=1:
 * version and baseline-node traces, the evidence inspector, impact reports with their
 * regeneration plan, the staleness list and actions, section links and dependencies.
 * Built from the v2 mock rows (./v2.ts); synthetic placeholders only. Reads need a
 * viewer; writes an approver, as in the API.
 */
import type { Schemas } from "@/lib/api/client";
import type { V2Db } from "./v2";

type Role = "viewer" | "commenter" | "approver" | "owner";
type Freshness = Schemas["ArtifactDependencyOut"]["freshness"];
const ROLE_ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const ORDER: Record<Freshness, number> = { fresh: 0, reconciled: 1, under_review: 2, potentially_stale: 3 };
const CATEGORY: Record<string, Schemas["TraceOutput"]["category"]> = {
  tech_brief: "engineering_spec",
  engineering_spec: "engineering_spec",
  user_flow: "wireframe",
  wireframe: "wireframe",
  figma_design: "wireframe",
  prototype: "prototype",
  acceptance_tests: "acceptance_tests",
};

interface TraceDoc {
  id: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  template?: string | null;
  template_version?: string | null;
}
interface TraceVersion {
  id: string;
  document_id: string;
  number: number;
  content_hash: string;
  snapshot?: string | null;
  approved_at?: string | null;
  source_version_id?: string | null;
  sections: { section_key: string; heading: string; level: number; layer: string; content_hash: string; citation_keys: string[] }[];
  /** The draft's own citations ([c:id] markers), as GET version serves them. */
  citations?: { cite_key: string; source: string; ref: string; title?: string | null; excerpt?: string | null; retrieved_at?: string | null }[];
}
/** A baseline evidence row (./baseline.ts), a section link's evidence target. */
interface TraceEvidence {
  id: string;
  url?: string | null;
  ref?: string | null;
  excerpt?: string | null;
  source_kind: string;
  source_removed: boolean;
  confidence?: number | null;
}
interface TraceEntity {
  id: string;
  type: string;
  key: string;
  title: string;
  status: string;
  locked: boolean;
  confidence?: number | null;
}

export interface TraceContext {
  v2: V2Db;
  documents: TraceDoc[];
  versions: TraceVersion[];
  entities: TraceEntity[];
  /** Baseline edges, to walk a linked entity up to the goals it serves. */
  edges?: { src_id: string; dst_id: string; type: string; status: string }[];
  /** Baseline evidence rows, the evidence a section link may point at. */
  evidence?: TraceEvidence[];
  userId: string;
  role: Role;
  now: () => string;
  uuid: () => string;
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "Content-Type": "application/json" },
  });
}
const notFound = (what: string) => json(404, { detail: `${what} not found` });
const atLeast = (role: Role, min: Role) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);

/** Edges that lead towards goals, as the API's trace walks them (oracle.trace.graph). */
const UPSTREAM = new Set(["supports", "derives_from", "part_of", "verifies"]);

/** A section's goals: linked goals, and the confirmed goals its linked entities serve, by key. */
function sectionGoals(ctx: TraceContext, linked: TraceEntity[]): Schemas["TraceEntityRef"][] {
  const goals = new Map<string, TraceEntity>();
  for (const start of linked) {
    if (start.type === "goal") goals.set(start.id, start);
    const seen = new Set([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of ctx.edges ?? []) {
        if (e.src_id !== at || e.status === "rejected" || !UPSTREAM.has(e.type) || seen.has(e.dst_id)) continue;
        seen.add(e.dst_id);
        queue.push(e.dst_id);
        const dst = ctx.entities.find((x) => x.id === e.dst_id);
        if (dst?.type === "goal" && dst.status === "confirmed") goals.set(dst.id, dst);
      }
    }
  }
  return [...goals.values()].sort((a, b) => a.key.localeCompare(b.key)).map(entityRef);
}

function entityRef(e: TraceEntity): Schemas["TraceEntityRef"] {
  return { id: e.id, type: e.type, key: e.key, title: e.title, status: e.status, locked: e.locked, confidence: e.confidence ?? null };
}

function findVersion(ctx: TraceContext, doc: string, n: number) {
  const d = ctx.documents.find((x) => x.slug === doc || x.id === doc);
  const v = d && ctx.versions.find((x) => x.document_id === d.id && x.number === n);
  return d && v ? { d, v } : null;
}

function upstreamOf(ctx: TraceContext, dep: Schemas["ArtifactDependencyOut"]): Schemas["TraceUpstream"] {
  const v = ctx.versions.find((x) => x.id === dep.upstream_version_id);
  const d = v && ctx.documents.find((x) => x.id === v.document_id);
  const e = ctx.entities.find((x) => x.id === dep.upstream_entity_id);
  // A deleted item: what it was when it went (oracle.trace keeps it).
  const gone = e ? undefined : ctx.v2.deleted_entities?.find((x) => x.id === dep.upstream_entity_id);
  return {
    document_id: d?.id ?? null,
    document_slug: d?.slug ?? null,
    document_kind: d?.kind ?? null,
    version_id: v?.id ?? null,
    version_number: v?.number ?? null,
    section_key: dep.upstream_section_key ?? null,
    section_hash: dep.upstream_section_hash ?? null,
    composition_revision: dep.composition_revision ?? null,
    entity: e ? entityRef(e) : gone ? entityRef(gone) : null,
    deleted: Boolean(gone),
    deleted_at: gone?.deleted_at ?? null,
  };
}

function reasonOf(ctx: TraceContext, dep: Schemas["ArtifactDependencyOut"]): string[] {
  if (dep.freshness !== "potentially_stale") return [];
  const up = upstreamOf(ctx, dep);
  if (up.section_key) return [`section ${up.section_key} changed in ${up.document_slug ?? "the PRD"}`];
  // As oracle.trace.staleness._label: the item by its title, never its baseline key (qa-plan-10).
  if (up.entity) return [`${up.entity.title || `${up.entity.type.replace("_", " ")} ${up.entity.key}`} ${up.deleted ? "was deleted" : "changed"}`];
  return [`${up.document_slug ?? "the PRD"} has a newer version (depends on all of it)`];
}

/** One output per downstream of ``deps``, stalest first (as oracle.trace.outputs.describe). */
export function describe(ctx: TraceContext, deps: Schemas["ArtifactDependencyOut"][], withReasons = false): Schemas["TraceOutput"][] {
  const views = new Map<string, Schemas["TraceOutput"]>();
  for (const dep of deps) {
    const key = dep.artifact_version_id ?? dep.document_version_id ?? "";
    let view = views.get(key);
    if (!view) {
      if (dep.artifact_version_id) {
        const av = ctx.v2.artifact_versions.find((x) => x.id === dep.artifact_version_id);
        const req = av && ctx.v2.artifact_requests.find((x) => x.id === av.request_id);
        if (!av || !req) continue;
        view = {
          kind: "artifact_version", category: CATEGORY[req.kind] ?? "engineering_spec", artifact_kind: req.kind,
          document_kind: null, artifact_version_id: av.id, request_id: req.id, document_version_id: null,
          document_id: req.source_document_id, document_slug: null, number: av.number, title: req.title,
          status: av.status, approved: av.status === "approved", freshness: av.freshness, dependencies: [], reasons: [],
        };
      } else {
        const v = ctx.versions.find((x) => x.id === dep.document_version_id);
        const d = v && ctx.documents.find((x) => x.id === v.document_id);
        if (!v || !d) continue;
        const mine = ctx.v2.artifact_dependencies.filter((x) => x.document_version_id === v.id).map((x) => x.freshness);
        view = {
          kind: "document_version", category: d.kind === "roadmap" ? "roadmap" : "document", artifact_kind: null,
          document_kind: d.kind, artifact_version_id: null, request_id: null, document_version_id: v.id,
          document_id: d.id, document_slug: d.slug, number: v.number, title: d.title,
          status: v.approved_at ? "approved" : d.status, approved: Boolean(v.approved_at),
          freshness: mine.reduce<Freshness>((a, b) => (ORDER[b] > ORDER[a] ? b : a), "fresh"),
          dependencies: [], reasons: [],
        };
      }
      views.set(key, view);
    }
    const reasons = withReasons ? reasonOf(ctx, dep) : [];
    view.dependencies!.push({
      id: dep.id, freshness: dep.freshness, upstream: upstreamOf(ctx, dep), caused_by_change_id: dep.caused_by_change_id ?? null,
      stale_since: dep.stale_since ?? null, reconciled_by: dep.reconciled_by ?? null, reconciled_at: dep.reconciled_at ?? null,
      note: dep.note ?? null, reasons,
    });
    for (const r of reasons) if (!view.reasons!.includes(r)) view.reasons!.push(r);
  }
  return [...views.values()].sort((a, b) => ORDER[b.freshness] - ORDER[a.freshness] || a.title.localeCompare(b.title));
}

/** "these acceptance tests", "this user flow" (oracle.trace.impact, qa-plan-43). */
function thisOf(v: Schemas["TraceOutput"]): string {
  const label = (v.artifact_kind ?? v.category).replace("_", " ");
  return `${label.endsWith("tests") ? "these" : "this"} ${label}`;
}

function plan(views: Schemas["TraceOutput"][], subjectKind: string): Schemas["RegenerationProposal"][] {
  return views
    .filter((v) => v.status !== "superseded" && v.status !== "rejected")
    .map((v) => {
      const sections = [...new Set((v.dependencies ?? []).map((d) => d.upstream.section_key).filter((k): k is string => Boolean(k)))].sort();
      const keeps = `the current version (v${v.number}${v.approved ? ", approved" : ""}) stays as it is`;
      const scope = sections.length ? `sections ${sections.join(", ")}` : "what changed";
      // A source's permission changed (oracle.trace.impact): review the claims, regenerate only if they fail.
      const review = subjectKind === "source_permission";
      return {
        kind: v.kind, category: v.category, artifact_version_id: v.artifact_version_id ?? null,
        document_version_id: v.document_version_id ?? null, title: v.title, action: review ? ("review" as const) : ("regenerate" as const),
        section_keys: sections, entity_ids: [], reasons: v.reasons ?? [], approved: v.approved, keeps_approved_version: true,
        how: review
          ? `Check the claims that relied on the changed source (${scope}); regenerate only if they no longer hold. Nothing changes until you decide; ${keeps}.`
          : v.category === "roadmap"
          ? `Start a roadmap run from the approved PRD version (flow prd_to_roadmap), focused on ${scope}; it imports a new version for review, and ${keeps} until a reviewer approves the new one.`
          : `Propose a new version of ${thisOf(v)} covering only ${scope}, from the current upstream; ${keeps} until a reviewer approves the new one.`,
      };
    });
}

function report(
  ctx: TraceContext,
  subject: Schemas["ImpactSubject"],
  deps: Schemas["ArtifactDependencyOut"][],
  extra: { change?: Schemas["ChangeEventOut"] | null; changes?: Schemas["ChangeEventOut"][]; preview: boolean },
): Schemas["ImpactReport"] {
  const affected = describe(ctx, deps, true);
  const counts: Record<string, number> = { total: affected.length, approved: affected.filter((a) => a.approved).length };
  for (const a of affected) counts[a.category] = (counts[a.category] ?? 0) + 1;
  return { subject, change: extra.change ?? null, changes: extra.changes ?? [], preview: extra.preview, affected, affected_entities: [], plan: plan(affected, subject.kind), counts, truncated: Boolean(ctx.v2.walk_truncated) };
}

/** A link's target as oracle.trace.evidence.targets resolves it; null when it no longer exists (the API drops it). */
function linkTarget(ctx: TraceContext, l: V2Db["section_links"][number]): Schemas["SectionLinkTarget"] | null {
  if (l.evidence_id) {
    const ev = ctx.evidence?.find((x) => x.id === l.evidence_id);
    if (!ev) return null;
    return {
      type: "evidence", id: ev.id, title: ev.ref || ev.url || null, confidence: ev.confidence ?? null, url: ev.url ?? null,
      ref: ev.ref ?? null, excerpt: ev.excerpt ?? null, source_kind: ev.source_kind, restricted: false, source_removed: ev.source_removed,
    };
  }
  // Only a source's owner reads its items (AUD-9); the mock's linked items are someone else's.
  if (l.source_item_id) return { type: "source_item", id: l.source_item_id, title: null, url: null, source_kind: "gdocs", restricted: true, source_removed: false };
  const e = ctx.entities.find((x) => x.id === l.entity_id);
  if (!e) return null;
  return { type: "entity", id: e.id, title: e.title, entity_type: e.type, status: e.status, locked: e.locked, confidence: e.confidence ?? null, ref: `${e.type}:${e.key}`, restricted: false, source_removed: false };
}

/** Strongest source first (B3): by confidence, unscored last, then oldest first. */
function byStrength(a: Schemas["SectionLinkView"], b: Schemas["SectionLinkView"]): number {
  const ca = a.target.confidence;
  const cb = b.target.confidence;
  if ((ca == null) !== (cb == null)) return ca == null ? 1 : -1;
  if (ca != null && cb != null && ca !== cb) return cb - ca;
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

function linkViews(ctx: TraceContext, version: TraceVersion, key: string): Schemas["SectionLinkView"][] {
  const hash = version.sections.find((s) => s.section_key === key)?.content_hash;
  return ctx.v2.section_links
    .filter((l) => l.document_id === version.document_id && (l.version_id === version.id || l.version_id === null) && l.section_key === key)
    .flatMap((l) => {
      const target = linkTarget(ctx, l);
      if (!target) return [];
      return [{
        id: l.id, kind: l.kind, precision: l.precision, claim: l.claim ?? null, module_key: l.module_key ?? null,
        composition_revision: l.composition_revision ?? null, current: !l.section_hash || l.section_hash === hash, target,
        created_by: l.created_by ?? null, created_at: l.created_at,
      }];
    })
    .sort(byStrength);
}

/** Handles the trace routes; null when the path is not one of them. */
export async function routeTrace(ctx: TraceContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const v2 = ctx.v2;
  const approver = () => atLeast(ctx.role, "approver");
  const forbidden = () => json(403, { detail: "Requires the approver role" });

  // /v1/documents/{doc}/versions/{n}/(trace|evidence|impact|section-links)
  if (p[1] === "documents" && p[3] === "versions" && p.length === 6 && ["trace", "evidence", "impact", "section-links"].includes(p[5])) {
    const found = findVersion(ctx, p[2], Number(p[4]));
    if (!found) {
      // As oracle.docs.service words it.
      const known = ctx.documents.some((x) => x.slug === p[2] || x.id === p[2]);
      return json(404, { detail: known ? `version ${p[4]} of '${p[2]}' not found` : `document '${p[2]}' not found` });
    }
    const { d, v } = found;
    const onVersion = v2.artifact_dependencies.filter((x) => x.upstream_version_id === v.id);
    if (p[5] === "trace" && m === "GET") {
      const comp = v2.compositions.find((c) => c.document_id === d.id);
      const rev = comp && v2.composition_revisions.find((r) => r.composition_id === comp.id && r.number === comp.current_revision);
      const out: Schemas["VersionTrace"] = {
        truncated: false,
        anchors: {
          document_id: d.id, document_slug: d.slug, document_kind: d.kind, version_id: v.id, number: v.number,
          content_hash: v.content_hash, template: comp?.template ?? d.template ?? null,
          template_version: comp?.template_version ?? d.template_version ?? null, composition_revision: rev?.number ?? null,
          composition_status: rev?.status ?? null, baseline_snapshot_id: rev?.inputs.baseline_snapshot_id ?? null,
          source_snapshot_ids: rev?.inputs.source_snapshot_ids ?? [], snapshot: v.snapshot ?? null,
          approved_at: v.approved_at ?? null, source_version_id: v.source_version_id ?? null,
        },
        sections: v.sections.map((s) => {
          const links = linkViews(ctx, v, s.section_key);
          return {
            section_key: s.section_key, heading: s.heading, level: s.level, layer: s.layer, section_hash: s.content_hash, links,
            entities: ctx.entities.filter((e) => links.some((l) => l.target.type === "entity" && l.target.id === e.id)).map(entityRef),
            goals: sectionGoals(ctx, ctx.entities.filter((e) => links.some((l) => l.target.type === "entity" && l.target.id === e.id))),
            downstream: describe(ctx, onVersion.filter((x) => x.upstream_section_key === s.section_key)),
          };
        }),
        whole_version_downstream: describe(ctx, onVersion.filter((x) => !x.upstream_section_key)),
        upstream: describe(ctx, v2.artifact_dependencies.filter((x) => x.document_version_id === v.id)).flatMap((o) => o.dependencies ?? []),
      };
      return json(200, out);
    }
    if (p[5] === "evidence" && m === "GET") {
      const only = q.get("section");
      const out: Schemas["EvidenceInspector"] = {
        document_id: d.id, document_slug: d.slug, version_id: v.id, number: v.number, approved: Boolean(v.approved_at),
        snapshot: v.snapshot ?? null,
        sections: v.sections
          .filter((s) => !only || s.section_key === only)
          .map((s) => ({
            section_key: s.section_key, heading: s.heading, level: s.level, layer: s.layer, section_hash: s.content_hash,
            links: linkViews(ctx, v, s.section_key),
            citations: s.citation_keys.flatMap((k) => {
              const c = v.citations?.find((x) => x.cite_key === k);
              return c ? [{ cite_key: k, source: c.source, ref: c.ref, title: c.title ?? null, excerpt: c.excerpt ?? null, retrieved_at: c.retrieved_at ?? null }] : [];
            }),
          })),
      };
      return json(200, out);
    }
    if (p[5] === "impact" && m === "GET") {
      const earlier = ctx.versions.filter((x) => x.document_id === d.id && x.number < v.number).map((x) => x.id);
      const deps = v2.artifact_dependencies.filter((x) => earlier.includes(x.upstream_version_id ?? "") && x.freshness !== "fresh");
      const changes = v2.change_events.filter((c) => c.subject_kind === "document_version" && c.subject_id === v.id);
      return json(200, report(ctx, { kind: "document_version", id: v.id, ref: `${d.slug}@${v.number}`, title: `${d.title} v${v.number}`, document_id: d.id }, deps, { changes, preview: true }));
    }
    if (p[5] === "section-links" && m === "POST") {
      if (!approver()) return forbidden();
      if (v.approved_at) return json(409, { detail: "an approved version's evidence links are pinned" });
      const { links } = await body<Schemas["SectionLinksCreate"]>();
      const created: Schemas["DocumentSectionLinkOut"][] = [];
      for (const l of links) {
        const section = v.sections.find((s) => s.section_key === l.section_key);
        if (!section) return json(422, { detail: `version ${v.number} has no section '${l.section_key}'` });
        if (l.entity_id && !ctx.entities.some((e) => e.id === l.entity_id)) return json(422, { detail: `unknown baseline entity ${l.entity_id}` });
        if (l.evidence_id && !ctx.evidence?.some((e) => e.id === l.evidence_id)) return json(422, { detail: `unknown evidence ${l.evidence_id}` });
        if (l.precision === "claim" && !(l.claim ?? "").trim()) return json(422, { detail: "a claim link needs the claim" });
        created.push({
          id: ctx.uuid(), document_id: d.id, version_id: v.id, section_key: l.section_key, section_hash: section.content_hash,
          composition_revision: v2.compositions.find((c) => c.document_id === d.id)?.current_revision ?? null, module_key: l.module_key ?? null, kind: l.kind, entity_id: l.entity_id ?? null,
          evidence_id: l.evidence_id ?? null, source_item_id: l.source_item_id ?? null, precision: l.precision ?? "section",
          claim: l.claim ?? null, created_by: ctx.userId, created_at: ctx.now(),
        });
      }
      v2.section_links.push(...created);
      return json(201, created);
    }
    return null;
  }

  if (p[1] === "section-links" && p[2] && p.length === 3 && m === "DELETE") {
    if (!approver()) return forbidden();
    const i = v2.section_links.findIndex((l) => l.id === p[2]);
    if (i < 0) return notFound("Section link");
    const version = ctx.versions.find((x) => x.id === v2.section_links[i].version_id);
    if (version?.approved_at) return json(409, { detail: "an approved version's evidence links are pinned" });
    v2.section_links.splice(i, 1);
    return json(204, null);
  }

  // /v1/baseline/entities/{id}/(trace|impact)
  if (p[1] === "baseline" && p[2] === "entities" && p.length === 5 && (p[4] === "trace" || p[4] === "impact") && m === "GET") {
    const e = ctx.entities.find((x) => x.id === p[3]);
    if (!e) return notFound("Entity");
    const sectionKeys = new Set(v2.section_links.filter((l) => l.entity_id === e.id).map((l) => `${l.version_id}#${l.section_key}`));
    const deps = v2.artifact_dependencies.filter(
      (x) => x.upstream_entity_id === e.id || sectionKeys.has(`${x.upstream_version_id}#${x.upstream_section_key}`),
    );
    if (p[4] === "impact") {
      const kind = e.type === "requirement" || e.type === "decision" ? e.type : "entity";
      return json(200, report(ctx, { kind, id: e.id, ref: `${e.type}:${e.key}`, title: e.title, document_id: null }, deps, { preview: true }));
    }
    const out: Schemas["EntityTrace"] = {
      truncated: false,
      entity: entityRef(e),
      flags: [],
      goals: [],
      upstream: [],
      downstream: [],
      related: {
        assumptions: [], blockers: [], alternatives: [], experiments: [], decisions: [], owners: [], risks: [],
        depends_on: [], assumption_decisions: [],
      },
      evidence: [],
      sections: v2.section_links
        .filter((l) => l.entity_id === e.id)
        .map((l) => {
          const v = ctx.versions.find((x) => x.id === l.version_id);
          const d = ctx.documents.find((x) => x.id === l.document_id);
          return {
            document_id: l.document_id, document_slug: d?.slug ?? "", document_kind: d?.kind ?? "prd", version_id: l.version_id ?? null,
            version_number: v?.number ?? null, section_key: l.section_key, link_id: l.id, link_kind: l.kind, entity_id: e.id,
          };
        }),
      outputs: describe(ctx, deps),
      priority: null,
    };
    return json(200, out);
  }

  if (p[1] !== "trace") return null;

  if (p[2] === "changes" && p[3] && p[4] === "impact" && m === "GET") {
    const change = v2.change_events.find((c) => c.id === p[3]);
    if (!change) return notFound("Change event");
    const deps = v2.artifact_dependencies.filter((x) => x.caused_by_change_id === change.id);
    // As oracle.trace.impact._subject_of_event: an entity change names the item by its title (a
    // deleted one by the title it had), a version by "<document> v<n>".
    let title: string | null = null;
    if (change.subject_id && ["requirement", "decision", "entity", "blocker_status"].includes(change.subject_kind)) {
      const e = ctx.entities.find((x) => x.id === change.subject_id) ?? v2.deleted_entities?.find((x) => x.id === change.subject_id);
      const recorded = (change.data as { entity?: { title?: string } } | null)?.entity?.title;
      title = e?.title ?? recorded ?? null;
    } else if (change.subject_id && change.subject_kind === "document_version") {
      const v = ctx.versions.find((x) => x.id === change.subject_id);
      const d = v && ctx.documents.find((x) => x.id === v.document_id);
      title = v && d ? `${d.title} v${v.number}` : null;
    }
    const subject = { kind: change.subject_kind, id: change.subject_id ?? null, ref: change.subject_ref ?? null, title, document_id: change.document_id ?? null };
    return json(200, report(ctx, subject, deps, { change, preview: false }));
  }
  if (p[2] === "staleness" && p.length === 3 && m === "GET") {
    const states = q.get("freshness") ? [q.get("freshness")] : ["potentially_stale", "under_review"];
    const doc = q.get("document_id");
    const deps = v2.artifact_dependencies.filter((x) => {
      if (!states.includes(x.freshness)) return false;
      if (!doc) return true;
      return ctx.versions.find((v) => v.id === x.upstream_version_id)?.document_id === doc;
    });
    // Paged by output, as the API (limit 1-200, default 50).
    const limit = Number(q.get("limit") ?? 50);
    const offset = Number(q.get("offset") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
      return json(422, { detail: "limit is 1-200 and offset 0 or more" });
    }
    const all = describe(ctx, deps, true);
    const next = offset + limit;
    return json(200, { items: all.slice(offset, next), total: all.length, limit, offset, next_offset: next < all.length ? next : null });
  }
  if (p[2] === "staleness" && p[3] === "actions" && m === "POST") {
    if (!approver()) return forbidden();
    const a = await body<Schemas["StalenessAction"]>();
    if (!a.artifact_version_id === !a.document_version_id) return json(422, { detail: "give exactly one output" });
    if (a.action === "reconcile" && !a.reason?.trim()) return json(422, { detail: "reconciling needs a reason" });
    const id = a.artifact_version_id ?? a.document_version_id;
    let deps = v2.artifact_dependencies.filter((x) => (x.artifact_version_id ?? x.document_version_id) === id);
    if (!deps.length) return notFound("Output");
    if (a.dependency_ids?.length) deps = deps.filter((x) => a.dependency_ids!.includes(x.id));
    const from: Freshness[] = a.action === "review" ? ["potentially_stale"] : ["potentially_stale", "under_review"];
    const targets = deps.filter((x) => from.includes(x.freshness));
    if (!targets.length) return json(409, { detail: `nothing to ${a.action.replace("_", " ")}` });
    for (const dep of targets) {
      dep.freshness = a.action === "reconcile" ? "reconciled" : "under_review";
      dep.note = a.reason ?? dep.note;
      dep.updated_at = ctx.now();
      if (a.action === "reconcile") Object.assign(dep, { reconciled_by: ctx.userId, reconciled_at: ctx.now() });
    }
    const av = v2.artifact_versions.find((x) => x.id === a.artifact_version_id);
    if (av) {
      av.freshness = v2.artifact_dependencies
        .filter((x) => x.artifact_version_id === av.id)
        .map((x) => x.freshness)
        .reduce<Freshness>((acc, f) => (ORDER[f] > ORDER[acc] ? f : acc), "fresh");
      v2.artifact_review_events.push({
        id: ctx.uuid(), version_id: av.id, kind: a.action === "reconcile" ? "reconciled" : "comment", body: a.reason ?? null,
        actor: `user:${ctx.userId}`, data: { action: a.action }, created_at: ctx.now(),
      });
    }
    return json(200, describe(ctx, v2.artifact_dependencies.filter((x) => (x.artifact_version_id ?? x.document_version_id) === id))[0]);
  }
  if (p[2] === "dependencies" && p.length === 3 && m === "POST") {
    if (!approver()) return forbidden();
    const b = await body<Schemas["DependenciesCreate"]>();
    const out: Schemas["ArtifactDependencyOut"][] = [];
    for (const up of b.upstream) {
      const existing = v2.artifact_dependencies.find(
        (x) =>
          x.artifact_version_id === (b.artifact_version_id ?? null) && x.document_version_id === (b.document_version_id ?? null) &&
          x.upstream_version_id === (up.version_id ?? null) && x.upstream_section_key === (up.section_key ?? null) &&
          x.upstream_entity_id === (up.entity_id ?? null),
      );
      if (existing) {
        out.push(existing);
        continue;
      }
      const version = ctx.versions.find((x) => x.id === up.version_id);
      const hash = version?.sections.find((s) => s.section_key === up.section_key)?.content_hash ?? null;
      if (up.section_key && !hash) return json(422, { detail: `version has no section '${up.section_key}'` });
      const row: Schemas["ArtifactDependencyOut"] = {
        id: ctx.uuid(), artifact_version_id: b.artifact_version_id ?? null, document_version_id: b.document_version_id ?? null,
        upstream_version_id: up.version_id ?? null, upstream_section_key: up.section_key ?? null, upstream_section_hash: hash,
        upstream_entity_id: up.entity_id ?? null, composition_revision: null, freshness: "fresh", caused_by_change_id: null,
        stale_since: null, reconciled_by: null, reconciled_at: null, note: null, created_at: ctx.now(), updated_at: ctx.now(),
      };
      v2.artifact_dependencies.push(row);
      out.push(row);
    }
    return json(201, out);
  }
  return null;
}
