/**
 * Mock of the specs lane's routes (api/oracle/specs/router.py) for NEXT_PUBLIC_API_MOCKS=1:
 * spec requests from an approved PRD, their versions with the approach status, sections by
 * part, SVG flows and grayscale wireframes with annotations and reviews, staleness and the
 * proposed regeneration. One seeded, synthetic spec; no run executes in the mock (a new
 * request or a regeneration answers with a draft run id). Same role checks as the API:
 * viewers read, commenters comment, approvers request, regenerate and decide.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["Me"]["role"];
type Spec = Schemas["SpecOut"];
type Design = Schemas["DesignArtifactOut"];

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const AT = "2026-10-19T12:00:00Z";
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox";

const I = {
  request: "c3000000-0000-4000-8000-000000000001",
  flowRequest: "c3000000-0000-4000-8000-000000000002",
  wireRequest: "c3000000-0000-4000-8000-000000000003",
  specVersion: "c3000000-0000-4000-8000-000000000011",
  flowVersion: "c3000000-0000-4000-8000-000000000012",
  wireVersion: "c3000000-0000-4000-8000-000000000013",
  docVersion: "c3000000-0000-4000-8000-000000000021",
  document: "c3000000-0000-4000-8000-000000000022",
  run: "c3000000-0000-4000-8000-000000000031",
  requirement: "c3000000-0000-4000-8000-000000000041",
  specDependency: "c3000000-0000-4000-8000-000000000051",
};

/** A spec version's dependency on the PRD section that changed (#481: Reconcile names it by its heading). */
function prdSectionDependency(id: string): Schemas["TraceDependency"] {
  return {
    id, freshness: "potentially_stale", caused_by_change_id: null, stale_since: AT, reconciled_by: null, reconciled_at: null, note: null,
    upstream: { document_slug: "checkout-redesign", document_kind: "prd", version_number: 1, section_key: "s-5-2", deleted: false },
    reasons: ["section s-5-2 changed in checkout-redesign"],
  };
}

// #396: why a spec version that may be stale is not approved (api/oracle/wording.py STALE).
const STALE =
  "may be stale: the PRD it rests on changed since it was written (the reasons are beside its Potentially stale label). Review or reconcile it from its tech brief page (Potentially stale › Review / Reconcile) before approving";

const FRESH_ORDER: Schemas["ArtifactVersionOut"]["freshness"][] = ["fresh", "reconciled", "under_review", "potentially_stale"];

/**
 * #481: the trace's staleness actions (POST /v1/trace/staleness/actions, api/oracle/trace/staleness.py
 * act) on a spec's version or its flow's, as the Plan inspector's; null when the output is not one of them.
 */
export async function specStalenessAction(ctx: SpecsContext, req: Request): Promise<Response | null> {
  const a = (await req.clone().json()) as Schemas["StalenessAction"];
  const spec = ctx.db.specs.find((s) => s.stale.some((v) => v.artifact_version_id && v.artifact_version_id === a.artifact_version_id));
  const view = spec?.stale.find((v) => v.artifact_version_id === a.artifact_version_id);
  if (!spec || !view) return null;
  if (!atLeast(ctx.role, "approver")) return fail(403, "Requires the approver role");
  if (a.action === "reconcile" && !a.reason?.trim()) return fail(422, "reconciling needs a reason");
  const from = a.action === "review" ? ["potentially_stale"] : ["potentially_stale", "under_review"];
  if (!from.includes(view.freshness)) return fail(409, `nothing to ${a.action.replace("_", " ")}: ${view.freshness}`);
  const to = a.action === "reconcile" ? "reconciled" : "under_review";
  view.freshness = to;
  view.dependencies = view.dependencies.map((d) => (from.includes(d.freshness) ? { ...d, freshness: to, note: a.reason ?? d.note } : d));
  for (const v of spec.versions) if (v.artifact_version.id === view.artifact_version_id) v.artifact_version = { ...v.artifact_version, freshness: to };
  for (const d of spec.design ?? []) if (d.version.id === view.artifact_version_id) d.version = { ...d.version, freshness: to };
  spec.freshness = spec.versions.map((v) => v.artifact_version.freshness).reduce((x, y) => (FRESH_ORDER.indexOf(y) > FRESH_ORDER.indexOf(x) ? y : x), "fresh");
  return json(200, view);
}

/** The refusal of Approve on a spec document's version whose spec version may be stale (api/oracle/specs/service.py). */
export function staleSpecRefusal(db: SpecsDb | undefined, slug: string, n: number): { detail: string; refs: Record<string, string> } | null {
  const av = db?.specs.find((s) => s.document_slug === slug)?.versions.find((x) => x.document_version === n)?.artifact_version;
  return av?.freshness === "potentially_stale" ? { detail: `this spec version ${STALE} its approach`, refs: { artifact_version: av.id } } : null;
}

export interface SpecsDb {
  specs: Spec[];
  /** Stored outputs by "<version id>/<name>". */
  files: Record<string, { media_type: string; content: string }>;
}

export interface SpecsContext {
  db: SpecsDb;
  userId: string;
  role: Role;
  uuid: () => string;
  now: () => string;
  /** F5 lane 3: what a request needs, as the API reads it (the server wires these). */
  documents?: { id: string; slug: string; kind?: string | null }[];
  /** The documents' versions: a spec is built from an approved PRD version. */
  versions?: { document_id: string; number: number; approved_at?: string | null }[];
  /** A baseline entity's title by id (the request's feature). */
  entityTitle?: (id: string) => string | null;
  /** The engineering leads who may approve (approvers and owners), A3. */
  leadApprovers?: () => string[];
  /** A tech brief (F5-1) by its version id: its PRD's slug and status. */
  techBrief?: (id: string) => { prd: string; status: string } | null;
  /** Drafts the prd_to_spec run (POST /v1/runs): its id, or the refusal. */
  draftRun?: (input: Schemas["RunCreate"]) => Promise<string | Response>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

const FLOW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 80" style="filter:grayscale(100%)"><title>Checkout with an early quote</title>' +
  '<rect id="cart" x="10" y="20" width="110" height="40" fill="#eee" stroke="#333"/><text x="65" y="45" text-anchor="middle">Cart</text>' +
  '<rect id="quote" x="180" y="20" width="110" height="40" fill="#eee" stroke="#333"/><text x="235" y="45" text-anchor="middle">Quote</text>' +
  '<line x1="120" y1="40" x2="180" y2="40" stroke="#333"/></svg>\n';
const wireframe = (n: number) =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Cart ${n}</title>` +
  `<style>html{filter:grayscale(100%)!important}body{font-family:system-ui,sans-serif;padding:16px}</style></head>` +
  `<body><main data-oracle-wireframe="1"><h1 id="heading-${n}">Cart ${n}</h1><div data-annotation="cost">Shipping: $4.99 (mocked)</div>` +
  `<button type="button">Continue</button></main></body></html>\n`;

function version(id: string, requestId: string, freshness: Schemas["ArtifactVersionOut"]["freshness"]): Schemas["ArtifactVersionOut"] {
  return {
    id, request_id: requestId, number: 1, status: "in_review", freshness, source_version_id: null, composition_revision: null,
    content_hash: null, summary: null, created_by: null, approved_by: null, approved_at: null, created_at: AT,
    provenance: { origin: "run", run_id: I.run, prompt_version: "prd_to_spec/1", runner_profile: "claude-code", prd_version: 1, requirement_ids: [I.requirement] },
  };
}

function request(id: string, kind: Schemas["ArtifactRequestOut"]["kind"], title: string, params: Record<string, unknown>): Schemas["ArtifactRequestOut"] {
  return {
    id, kind, title, source_document_id: "a1000000-0000-4000-8000-000000000001", source_version_id: null,
    requirement_ids: [I.requirement], section_keys: ["s-5-2"], params, status: "succeeded", run_id: I.run,
    requested_by: null, lock_version: 1, created_at: AT, updated_at: AT,
  };
}

const note = (target: string): Schemas["AnnotationOut"] => ({
  id: "cost-early", target, note: "The quote shows before the address step.", section_key: "s-5-2", requirement_ids: [I.requirement], reviews: [],
});

function design(kind: "user_flow" | "wireframe"): Design {
  const flow = kind === "user_flow";
  const versionId = flow ? I.flowVersion : I.wireVersion;
  const outputs: Schemas["DesignOutputOut"][] = flow
    ? [{ name: "checkout-flow.svg", title: "Checkout with an early quote", screen: null, media_type: "image/svg+xml", size_bytes: FLOW_SVG.length, sha256: "0".repeat(64), section_keys: ["s-5-2"], requirement_ids: [I.requirement], annotations: [note("quote")], removed: [], content_url: `/v1/design-artifacts/${versionId}/outputs/checkout-flow.svg` }]
    : [1, 2].map((n) => ({ name: `cart-${n}.html`, title: `Cart ${n}`, screen: `cart-${n}`, media_type: "text/html", size_bytes: wireframe(n).length, sha256: "0".repeat(64), section_keys: ["s-5-2"], requirement_ids: [I.requirement], annotations: [note("cost")], removed: [], content_url: `/v1/design-artifacts/${versionId}/outputs/cart-${n}.html` }));
  return {
    request_id: flow ? I.flowRequest : I.wireRequest,
    kind,
    title: flow ? "Early shipping cost: user flows" : "Early shipping cost: wireframes",
    version: version(versionId, flow ? I.flowRequest : I.wireRequest, flow ? "potentially_stale" : "fresh"),
    outputs,
    reviews: [],
    lineage: null,
  };
}

const DECIDED = "Decided · from the approved PRD";
const PROPOSED = "Proposed · until an engineering approver approves this version";
const APPROVED = "Decided · approved by an engineering approver";
const ADDED = "Proposed · added in an edit";
const PROPOSED_AC = "Proposed · not a product requirement until the PRD adopts it";
/** Oracle's label that starts the proposed acceptance criteria. */
export const ACCEPTANCE_PROPOSED_LABEL = "Proposed by this spec (not product requirements until the PRD adopts them):";
/** The spec template's sections a technical brief has (api/oracle/specs/contract.py SECTIONS). */
const BRIEF_TEMPLATE_KEYS = new Set(["summary", "requirements", "approach", "open-decisions", "acceptance-criteria", "assumptions", "sources"]);
/** ... and a full engineering spec. */
const TEMPLATE_KEYS = new Set([
  ...BRIEF_TEMPLATE_KEYS, "user-flows", "inputs-outputs", "architecture", "apis-data", "dependencies", "failure-modes",
  "security-privacy-performance", "test-strategy", "release-flags", "migration-rollback",
]);
const ADDED_STATE: Schemas["SpecPartState"] = { label: ADDED, decided: false, added: true, half: null, starts_at: null };
/** E1: a citation an edit added to a spec version, as the API's `CitationOut.state_label`. */
export const ADDED_CITATION_LABEL = ADDED;

/**
 * E1, as the API's `spec_states`: only what Oracle locks is decided; an added section is
 * proposed. A template section a technical brief does not have (e.g. Architecture), added
 * in an edit, is an added section too (owner, 2026-10-20).
 */
export function specStates(key: string, body: string, approved: boolean, depth: "brief" | "full" = "full"): Schemas["SpecPartState"][] {
  if (key === "spec" || key === "full") return [];
  if (key === "acceptance-criteria") {
    const out: Schemas["SpecPartState"][] = [{ label: DECIDED, decided: true, added: false, half: "decided", starts_at: null }];
    if (body.includes(`\n\n${ACCEPTANCE_PROPOSED_LABEL}\n`)) {
      out.push({ label: PROPOSED_AC, decided: false, added: false, half: "proposed", starts_at: ACCEPTANCE_PROPOSED_LABEL });
    }
    return out;
  }
  if (key === "requirements" || key === "sources") return [{ label: DECIDED, decided: true, added: false, half: null, starts_at: null }];
  if (!(depth === "brief" ? BRIEF_TEMPLATE_KEYS : TEMPLATE_KEYS).has(key)) return [ADDED_STATE];
  return [{ label: approved ? APPROVED : PROPOSED, decided: approved, added: false, half: null, starts_at: null }];
}

export function seedSpecs(): SpecsDb {
  const parts: [string, string, string, Schemas["SpecSectionOut"]["part"]][] = [
    ["spec", "Early shipping cost: technical brief", "brief", "context"],
    ["summary", "Summary", "brief", "context"],
    ["requirements", "Product requirements", "brief", "product_requirement"],
    ["approach", "Proposed engineering approach", "brief", "engineering_approach"],
    ["open-decisions", "Open engineering decisions", "brief", "open_decision"],
    ["full", "Full version", "detail", "context"],
    ["acceptance-criteria", "Acceptance criteria", "detail", "product_requirement"],
    ["assumptions", "Assumptions", "detail", "assumption"],
    ["sources", "Sources and data points", "detail", "context"],
  ];
  const spec: Spec = {
    request: request(I.request, "tech_brief", "Early shipping cost: technical brief", {
      document_slug: "checkout-redesign-early-shipping-cost-spec", depth: "brief", design: true, screens: 2,
      engineering_approver_ids: [], document_id: I.document, design_request_ids: { user_flow: I.flowRequest, wireframe: I.wireRequest },
    }),
    document_slug: "checkout-redesign-early-shipping-cost-spec",
    document_id: I.document,
    prd: null,
    depth: "brief",
    latest_version: 1,
    approach_status: "proposed",
    freshness: "potentially_stale",
    requirements: [{ id: I.requirement, key: "req-shipping-cost", title: "Show shipping cost on the cart", status: "confirmed", section_keys: ["s-5-2"], missing: false }],
    section_keys: ["s-5-2"],
    engineering_approver_ids: [],
    code_capability_map: "unavailable",
    versions: [{ artifact_version: version(I.specVersion, I.request, "potentially_stale"), document_version: 1, document_version_id: I.docVersion, approach_status: "proposed", approved_by: null, approved_at: null, origin: "run" }],
    // E1: only what Oracle locks is decided; the acceptance criteria read as two halves.
    sections: parts.flatMap(([key, heading, layer, part]): Schemas["SpecSectionOut"][] => {
      const oracle = ["spec", "requirements", "full", "acceptance-criteria", "sources"].includes(key);
      const state = { key, heading, layer, part, decided: oracle, half: null, added: false, label: oracle ? DECIDED : PROPOSED };
      if (key !== "acceptance-criteria") return [state];
      return [
        { ...state, half: "decided" },
        { ...state, part: "proposed", decided: false, half: "proposed", label: "Proposed · not a product requirement until the PRD adopts it" },
      ];
    }),
    design: [design("user_flow"), design("wireframe")],
    stale: [
      { kind: "artifact_version", category: "engineering_spec", artifact_kind: "tech_brief", document_kind: null, artifact_version_id: I.specVersion, request_id: I.request, document_version_id: null, document_id: null, document_slug: null, number: 1, title: "Early shipping cost: technical brief", status: "in_review", approved: false, freshness: "potentially_stale", dependencies: [prdSectionDependency(I.specDependency)], reasons: ["section s-5-2 changed in checkout-redesign"] },
      { kind: "artifact_version", category: "wireframe", artifact_kind: "user_flow", document_kind: null, artifact_version_id: I.flowVersion, request_id: I.flowRequest, document_version_id: null, document_id: null, document_slug: null, number: 1, title: "Early shipping cost: user flows", status: "in_review", approved: false, freshness: "potentially_stale", dependencies: [], reasons: ["section s-5-2 changed in checkout-redesign"] },
    ],
    run_id: I.run,
    run_status: "succeeded",
    regeneration_run_id: null,
    state: "stale",
    feature_id: null,
    tech_brief_version_id: null,
  };
  return {
    specs: [spec],
    files: {
      [`${I.flowVersion}/checkout-flow.svg`]: { media_type: "image/svg+xml", content: FLOW_SVG },
      [`${I.wireVersion}/cart-1.html`]: { media_type: "text/html", content: wireframe(1) },
      [`${I.wireVersion}/cart-2.html`]: { media_type: "text/html", content: wireframe(2) },
    },
  };
}

const RUN_ENDED = ["succeeded", "failed", "cancelled"];

/** F5 lane 3, as the API's specs.service._state: Requested, Drafting, In review, Approved, Stale or Run failed. */
function stateOf(s: Spec): Schemas["SpecSummary"]["state"] {
  const latest = s.versions.at(-1);
  if (latest) {
    if (latest.artifact_version.freshness === "potentially_stale") return "stale";
    return latest.approach_status === "approved" ? "approved" : "in_review";
  }
  const status = s.run_status ?? "draft";
  if (status === "draft" || status === "awaiting_approval") return "requested";
  return RUN_ENDED.includes(status) ? "failed" : "drafting";
}

function summary(s: Spec): Schemas["SpecSummary"] {
  const { request, document_slug, document_id, prd, depth, latest_version, approach_status, freshness } = s;
  const params = request.params as { feature_id?: string | null; tech_brief_version_id?: string | null };
  return {
    request, document_slug, document_id, prd, depth, latest_version, approach_status, freshness,
    state: stateOf(s), feature_id: params.feature_id ?? null, tech_brief_version_id: params.tech_brief_version_id ?? null,
  };
}

const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function findDesign(db: SpecsDb, versionId: string): Design | null {
  for (const s of db.specs) for (const d of s.design ?? []) if (d.version.id === versionId) return d;
  return null;
}

/** The specs routes; null when the path is not one of them. */
export async function routeSpecs(ctx: SpecsContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const need = (role: Role) => (atLeast(ctx.role, role) ? null : fail(403, `Requires the ${role} role`));

  if (p[1] === "spec-requests") {
    if (!p[2] && m === "GET") {
      const prd = q.get("prd");
      const doc = prd ? ctx.documents?.find((d) => d.slug === prd || d.id === prd) : undefined;
      return json(
        200,
        ctx.db.specs.filter((s) => !prd || s.request.source_document_id === (doc?.id ?? prd) || s.document_slug?.startsWith(`${prd}-`)).map((s) => ({ ...summary(s), state: stateOf(s) })),
      );
    }
    if (!p[2] && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      const data = await body<Schemas["SpecRequestCreate"]>();
      if (!data?.requirement_ids?.length) return fail(422, "requirement_ids: at least one requirement");
      const base = ctx.db.specs[0];
      const prd = ctx.documents?.find((d) => d.slug === data.prd || d.id === data.prd);
      if (ctx.documents && !prd) return fail(422, `document '${data.prd}' not found`);
      // As the API's _approved_prd: the version named, approved, or the latest approved one.
      let sourceVersion: number | null = null;
      if (prd && ctx.versions) {
        const own = ctx.versions.filter((v) => v.document_id === prd.id);
        if (data.prd_version != null) {
          const v = own.find((x) => x.number === data.prd_version);
          if (!v) return fail(422, `version ${data.prd_version} of '${prd.slug}' not found`);
          if (!v.approved_at) return fail(422, `version ${data.prd_version} of '${prd.slug}' is not approved: a spec is built from an approved PRD version`);
          sourceVersion = v.number;
        } else {
          const approved = own.filter((v) => v.approved_at).sort((a, b) => b.number - a.number)[0];
          if (!approved) return fail(422, `'${prd.slug}' has no approved version: approve the PRD first`);
          sourceVersion = approved.number;
        }
      }
      // F5 lane 3, as the API: an approved tech brief of this PRD from an Engineering check.
      if (data.tech_brief_version_id) {
        const brief = ctx.techBrief?.(data.tech_brief_version_id);
        if (!brief) return fail(422, "tech_brief_version_id is not a tech brief from an Engineering check");
        if (prd && brief.prd !== prd.slug) return fail(422, `that tech brief is of another PRD, not ${prd.slug}`);
        if (brief.status !== "approved") return fail(422, "that tech brief is not approved: only an approved brief feeds a spec");
      }
      const subject = (data.feature_id && ctx.entityTitle?.(data.feature_id)) || base.requirements[0]?.title || "Spec";
      const noun = data.depth === "full" ? "engineering spec" : "technical brief";
      const slug = data.document ?? `${prd?.slug ?? data.prd}-${slugify(subject)}-spec`;
      // A3: no approvers named, the engineering leads who may approve (an empty list: any approver).
      const approvers = data.engineering_approver_ids ?? ctx.leadApprovers?.() ?? [];
      const id = ctx.uuid();
      let runId = ctx.uuid();
      if (ctx.draftRun && prd) {
        const run = await ctx.draftRun({ flow: "prd_to_spec", document: slug, source: prd.slug, source_version: sourceVersion, knobs: data.knobs } as Schemas["RunCreate"]);
        if (run instanceof Response) return run;
        runId = run;
      }
      const spec: Spec = {
        ...base,
        request: {
          ...base.request, id, kind: data.depth === "full" ? "engineering_spec" : "tech_brief", title: data.title ?? `${subject}: ${noun}`,
          source_document_id: prd?.id ?? base.request.source_document_id, requirement_ids: data.requirement_ids, status: "queued", run_id: runId,
          params: {
            document_slug: slug, depth: data.depth ?? "brief", design: data.design ?? true, screens: data.screens ?? 3,
            feature_id: data.feature_id ?? null, engineering_approver_ids: approvers, tech_brief_version_id: data.tech_brief_version_id ?? null,
          },
          created_at: ctx.now(), updated_at: ctx.now(),
        },
        document_slug: slug, document_id: null, depth: data.depth ?? "brief", engineering_approver_ids: approvers,
        latest_version: null, approach_status: null, freshness: null, versions: [], sections: [], design: [], stale: [],
        run_id: runId, run_status: "draft", regeneration_run_id: null, state: "requested",
        feature_id: data.feature_id ?? null, tech_brief_version_id: data.tech_brief_version_id ?? null,
      };
      ctx.db.specs.unshift(spec);
      return json(201, { spec, run_id: spec.run_id });
    }
    const spec = ctx.db.specs.find((s) => s.request.id === p[2]);
    if (!spec) return fail(404, "spec request not found");
    if (!p[3] && m === "GET") return json(200, { ...spec, ...summary(spec) });
    if (p[3] === "regenerate" && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      // #481: as the API, no second regeneration while one has not ended.
      if (spec.regeneration_run_id) return fail(409, `this spec's run has not ended (it is ${spec.run_status}): let it finish, or cancel it on its run page, first`);
      const out: Schemas["RegenerationOut"] = {
        request_id: spec.request.id, run_id: ctx.uuid(), prd_version: 1, section_keys: spec.section_keys,
        dropped_section_keys: [], reasons: spec.stale.flatMap((s) => s.reasons ?? []),
      };
      spec.run_id = out.run_id;
      spec.run_status = "draft";
      // #481: proposing it settles nothing; the versions stay as stale as they were.
      spec.regeneration_run_id = out.run_id;
      return json(201, out);
    }
    return null;
  }

  if (p[1] === "design-artifacts" && p[2]) {
    const d = findDesign(ctx.db, p[2]);
    if (!d) return fail(404, "design artifact version not found");
    if (!p[3] && m === "GET") return json(200, d);
    if (p[3] === "outputs" && p[4] && m === "GET") {
      const file = ctx.db.files[`${p[2]}/${p[4]}`];
      if (!file) return fail(404, `output '${p[4]}' not found`);
      return new Response(file.content, {
        status: 200,
        headers: { "Content-Type": `${file.media_type}; charset=utf-8`, "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" },
      });
    }
    if (p[3] === "reviews" && m === "POST") {
      const denied = need("commenter");
      if (denied) return denied;
      const data = await body<Schemas["DesignReviewIn"]>();
      if (data.kind !== "comment" && !atLeast(ctx.role, "approver")) return fail(403, "only the spec's engineering approvers (or an owner) decide on it");
      if (data.kind === "comment" && !data.body?.trim()) return fail(422, "a comment needs a body");
      const event: Schemas["ArtifactReviewEventOut"] = {
        id: ctx.uuid(), version_id: d.version.id, kind: data.kind, body: data.body ?? null, actor: `user:${ctx.userId}`,
        data: data.annotation_id ? { output: data.output, annotation_id: data.annotation_id } : {}, created_at: ctx.now(),
      };
      const target = data.annotation_id && d.outputs.find((o) => o.name === data.output)?.annotations?.find((a) => a.id === data.annotation_id);
      if (data.annotation_id && !target) return fail(422, `no annotation '${data.annotation_id}' on '${data.output}'`);
      if (target) target.reviews = [...(target.reviews ?? []), event];
      else d.reviews = [...(d.reviews ?? []), event];
      if (data.kind === "approved") d.version = { ...d.version, status: "approved", approved_by: ctx.userId, approved_at: ctx.now() };
      if (data.kind === "rejected") d.version = { ...d.version, status: "rejected" };
      return json(201, { event, version: d.version });
    }
  }
  return null;
}
