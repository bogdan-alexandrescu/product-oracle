/**
 * The "impact" and "impact-large" scenarios (v2 screen 2, the Impact explorer): outputs
 * built on checkout-redesign v1, in every category and freshness, a roadmap version among
 * them, one resting on a baseline item that was since deleted. "impact-large" adds enough
 * outputs to group the lineage by category, and a walk cut off at its limit. Invented
 * data only; the trace mock (./trace.ts) turns these rows into ImpactReports.
 */
import type { Schemas } from "@/lib/api/client";
import type { V2Db } from "./v2";

type Dep = Schemas["ArtifactDependencyOut"];
const AT = "2026-10-20T10:00:00Z";

export interface ImpactSeedContext {
  /** checkout-redesign v1: what the outputs were built from. */
  versionId: string;
  /** usage-alerts-roadmap v1, whose plan row is a roadmap run. */
  roadmapVersionId: string | null;
  /** A live baseline item one output rests on. */
  entity: { id: string } | null;
  userId: string;
  uuid: () => string;
}

/** A baseline item that was deleted after an output was built on it (as oracle.trace keeps it). */
export interface DeletedEntity {
  id: string;
  type: string;
  key: string;
  title: string;
  status: string;
  locked: boolean;
  confidence: number | null;
  deleted_at: string;
}

export function seedImpact(v2: V2Db, ctx: ImpactSeedContext, large: boolean): void {
  const dep = (over: Partial<Dep>): Dep => ({
    id: ctx.uuid(), artifact_version_id: null, document_version_id: null, upstream_version_id: ctx.versionId,
    upstream_section_key: null, upstream_section_hash: null, upstream_entity_id: null, composition_revision: 1,
    freshness: "potentially_stale", caused_by_change_id: null, stale_since: AT, reconciled_by: null, reconciled_at: null,
    note: null, created_at: AT, updated_at: AT, ...over,
  });
  const output = (
    kind: string,
    title: string,
    status: Schemas["ArtifactVersionOut"]["status"],
    freshness: Dep["freshness"],
    ups: Partial<Dep>[],
  ) => {
    const request = ctx.uuid();
    const version = ctx.uuid();
    v2.artifact_requests.push({
      id: request, kind: kind as Schemas["ArtifactRequestOut"]["kind"], title, source_document_id: v2.artifact_requests[0]?.source_document_id ?? null,
      source_version_id: ctx.versionId, requirement_ids: [], section_keys: ups.flatMap((u) => (u.upstream_section_key ? [u.upstream_section_key] : [])), params: {}, status: "succeeded", run_id: null,
      requested_by: ctx.userId, lock_version: 1, created_at: AT, updated_at: AT,
    } as Schemas["ArtifactRequestOut"]);
    v2.artifact_versions.push({
      id: version, request_id: request, number: 1, status, freshness, source_version_id: ctx.versionId, composition_revision: 1,
      content_hash: null, summary: title, provenance: {}, created_by: null, approved_by: status === "approved" ? ctx.userId : null,
      approved_at: status === "approved" ? AT : null, created_at: AT,
    } as Schemas["ArtifactVersionOut"]);
    for (const up of ups) v2.artifact_dependencies.push(dep({ artifact_version_id: version, freshness, ...up }));
  };

  const deleted: DeletedEntity = {
    id: ctx.uuid(), type: "requirement", key: "R-90", title: "Guest checkout keeps the cart", status: "confirmed",
    locked: false, confidence: 0.82, deleted_at: "2026-10-21T09:00:00Z",
  };
  v2.deleted_entities = [deleted];

  output("tech_brief", "Early shipping cost brief", "approved", "potentially_stale", [
    { upstream_section_key: "problem" },
    { upstream_section_key: "users" },
  ]);
  output("user_flow", "Checkout flow (user flow)", "draft", "potentially_stale", [
    { upstream_section_key: "scope" },
    ...(ctx.entity ? [{ upstream_version_id: null, upstream_entity_id: ctx.entity.id }] : []),
  ]);
  output("wireframe", "Cart wireframes", "draft", "under_review", [{ upstream_section_key: "scope" }]);
  // Recorded: deleting R-90 marked the tests built on it, and on the risks section that linked it.
  const change = ctx.uuid();
  v2.change_events.push({
    id: change, subject_kind: "entity", subject_id: deleted.id, subject_ref: "requirement:R-90", document_id: null,
    cause: "entity_deleted", actor: `user:${ctx.userId}`, data: {}, handled_by: ["trace.mark_stale"], created_at: deleted.deleted_at,
  } as Schemas["ChangeEventOut"]);
  output("acceptance_tests", "Acceptance tests", "draft", "potentially_stale", [
    { upstream_section_key: "risks", caused_by_change_id: change },
    { upstream_version_id: null, upstream_entity_id: deleted.id, caused_by_change_id: change },
  ]);
  output("prototype", "Checkout prototype", "superseded", "reconciled", [{ upstream_section_key: "rollout", reconciled_by: ctx.userId, reconciled_at: AT }]);
  if (ctx.roadmapVersionId) {
    v2.artifact_dependencies.push(dep({ document_version_id: ctx.roadmapVersionId, upstream_section_key: "scope" }));
  }

  if (large) {
    const kinds = ["wireframe", "user_flow", "acceptance_tests", "tech_brief"];
    const sections = ["scope", "metrics", "risks", "users"];
    for (let i = 1; i <= 14; i++) {
      output(kinds[i % kinds.length], `Variant screen ${i}`, "draft", "potentially_stale", [{ upstream_section_key: sections[i % sections.length] }]);
    }
    v2.walk_truncated = true;
  }
}
