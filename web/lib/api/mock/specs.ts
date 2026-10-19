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
};

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
    sections: parts.map(([key, heading, layer, part]) => ({ key, heading, layer, part, decided: part === "product_requirement" || part === "context" })),
    design: [design("user_flow"), design("wireframe")],
    stale: [
      { kind: "artifact_version", category: "engineering_spec", artifact_kind: "tech_brief", document_kind: null, artifact_version_id: I.specVersion, request_id: I.request, document_version_id: null, document_id: null, document_slug: null, number: 1, title: "Early shipping cost: technical brief", status: "in_review", approved: false, freshness: "potentially_stale", dependencies: [], reasons: ["section s-5-2 changed in checkout-redesign"] },
      { kind: "artifact_version", category: "wireframe", artifact_kind: "user_flow", document_kind: null, artifact_version_id: I.flowVersion, request_id: I.flowRequest, document_version_id: null, document_id: null, document_slug: null, number: 1, title: "Early shipping cost: user flows", status: "in_review", approved: false, freshness: "potentially_stale", dependencies: [], reasons: ["section s-5-2 changed in checkout-redesign"] },
    ],
    run_id: I.run,
    run_status: "succeeded",
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

function summary(s: Spec): Schemas["SpecSummary"] {
  const { request, document_slug, document_id, prd, depth, latest_version, approach_status, freshness } = s;
  return { request, document_slug, document_id, prd, depth, latest_version, approach_status, freshness };
}

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
      return json(200, ctx.db.specs.filter((s) => !prd || s.request.source_document_id === prd || s.document_slug?.startsWith(prd)).map(summary));
    }
    if (!p[2] && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      const data = await body<Schemas["SpecRequestCreate"]>();
      if (!data?.requirement_ids?.length) return fail(422, "requirement_ids: at least one requirement");
      const base = ctx.db.specs[0];
      const id = ctx.uuid();
      const spec: Spec = {
        ...base,
        request: { ...base.request, id, kind: data.depth === "full" ? "engineering_spec" : "tech_brief", requirement_ids: data.requirement_ids, status: "queued", created_at: ctx.now(), updated_at: ctx.now() },
        latest_version: null, approach_status: null, freshness: null, versions: [], sections: [], design: [], stale: [],
        run_id: ctx.uuid(), run_status: "draft",
      };
      ctx.db.specs.unshift(spec);
      return json(201, { spec, run_id: spec.run_id });
    }
    const spec = ctx.db.specs.find((s) => s.request.id === p[2]);
    if (!spec) return fail(404, "spec request not found");
    if (!p[3] && m === "GET") return json(200, spec);
    if (p[3] === "regenerate" && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      const out: Schemas["RegenerationOut"] = {
        request_id: spec.request.id, run_id: ctx.uuid(), prd_version: 1, section_keys: spec.section_keys,
        dropped_section_keys: [], reasons: spec.stale.flatMap((s) => s.reasons ?? []),
      };
      spec.run_id = out.run_id;
      spec.run_status = "draft";
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
