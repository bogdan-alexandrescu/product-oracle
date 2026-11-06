/**
 * Mock of api/oracle/engineering/router.py for NEXT_PUBLIC_API_MOCKS=1.
 *
 * Tech briefs (F5-1): `GET /v1/tech-briefs?prd=&feature=` and `GET /v1/tech-briefs/{id}`.
 * The seed stands for what an approved Engineering check registered on the checkout PRD:
 * one brief per feature, one resting on a shared (docs-only) code map and one written
 * without a map. Every member reads (viewer+), as in the API.
 *
 * Code maps (F5-2): `GET/POST /v1/code-maps`, `GET /v1/code-maps/{id}` and
 * `POST /v1/code-maps/{id}/sharing`. A map starts building; the mock's code_map run
 * finishes on the next read, docs only (the checkout is not available yet). Private maps
 * are their source owner's only; shared ones everyone's. Synthetic placeholders only.
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";
import { SPENT } from "./llm-jobs";
import { readableRefusal } from "./refusal";
import { sourceRepos } from "./sources";

type TechBrief = Schemas["TechBriefOut"];
type CodeMap = Schemas["CodeMapDetail"];
/** A stored map: who owns its source, and how many reads it has been building. */
/** read_refused: the "code-map-unreadable" scenario refused one read of it already (a retry reads it). */
export type CodeMapRow = CodeMap & { owner_email: string; reads?: number; read_refused?: boolean };

export interface EngineeringContext {
  documents: { id: string; slug: string }[];
  /** The mock's code maps, kept in the db (created on first use). */
  maps: () => CodeMapRow[];
  /** canWrite: commenter and up (mapping and sharing are the source's writes, as in the API). */
  me: { id: string; email: string; canWrite: boolean };
  now: () => string;
  uuid: () => string;
  /** #633 re-review, the "stored-refusals" scenario: the Claude pool refuses every code map run. */
  refuse?: boolean;
  /** Pass F F-38, the "code-map-unreadable" scenario: the first read of a map's content fails. */
  unreadable?: boolean;
  /** Pass F F-38, the "code-map-empty" scenario: a map's content takes a moment to read. */
  slowRead?: boolean;
}

const PRD = "checkout-redesign";
const LEAD = stableUuid("member/approver@example.com");
const RUN = stableUuid("tech-briefs/run");

function seedBriefs(): TechBrief[] {
  return [
    {
      id: stableUuid("tech-brief/price-early"),
      request_id: stableUuid("tech-brief-request/price-early"),
      feature: { key: "price-early", title: "Show the full price early", entity_id: stableUuid("feature/price-early") },
      prd: { slug: PRD, version: 2 },
      run_id: RUN,
      status: "approved",
      code_map: {
        used: true,
        // A shared map built from the synced docs only (F5-2, until the checkout exists).
        repos: [{ repo: "example/shop-app", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z", partial: true }],
        unmapped: [],
      },
      // Prose with two " - " asides (review minors 19): one paragraph, never a list.
      approach:
        "Compute the total in the pricing module as soon as the cart changes - before tax is known - and show it in the checkout summary from the first step.",
      touches: [
        { area: "web/checkout/summary", kind: "module", change: "change", ref: "module:checkout-web" },
        { area: "GET /v1/quotes", kind: "api", change: "new", ref: null },
        { area: "Quote", kind: "data_model", change: "new", ref: null },
      ],
      reuse: ["module:pricing"],
      risks: [{ risk: "Tax rules differ by region", level: "high", mitigation: "Quote with the tax service, never locally" }],
      questions: [
        { id: "q1", question: "Can quotes be cached for ten minutes?", why: "Sets the load on the tax service", blocking: true },
        { id: "q2", question: "Do gift cards change the total before payment?", why: "One more input to the quote", blocking: false },
      ],
      answers: [{ question_id: "q1", answer: "Yes, prices change at most hourly", by: LEAD }],
      size: "m",
      size_why: "One endpoint, one model and the summary component",
      depends_on: [],
      assumptions: [],
      verdict: { value: "feasible_with_changes", note: "Cache quotes per cart", by: LEAD, at: "2026-10-20T18:00:00Z" },
      freshness: "fresh",
      stale_reasons: [],
      created_at: "2026-10-20T18:00:00Z",
    },
    {
      // F5 lane 3: the approved brief of an approved Plan item's feature (Usage alerts).
      id: stableUuid("tech-brief/threshold-alerts"),
      request_id: stableUuid("tech-brief-request/threshold-alerts"),
      feature: { key: "threshold-alerts", title: "Threshold alerts", entity_id: stableUuid("feature/threshold-alerts") },
      prd: { slug: "usage-alerts", version: 1 },
      run_id: RUN,
      status: "approved",
      code_map: { used: false, repos: [], unmapped: [] },
      approach: "Check each account's spend against its thresholds when usage is recorded, and send one alert per crossing.",
      touches: [{ area: "usage recording", kind: "module", change: "change", ref: null }],
      reuse: [],
      risks: [{ risk: "Usage arrives late for some accounts", level: "medium", mitigation: "Check again at the hourly roll-up" }],
      questions: [{ id: "q1", question: "Is one alert per crossing enough?", why: "Sets how alerts repeat", blocking: false }],
      answers: [{ question_id: "q1", answer: "Yes, with a daily reminder", by: LEAD }],
      size: "s",
      size_why: "One check where usage is recorded",
      depends_on: [],
      assumptions: ["Usage is recorded within an hour"],
      verdict: { value: "feasible", note: "Check at the roll-up too", by: LEAD, at: "2026-10-20T18:00:00Z" },
      freshness: "fresh",
      stale_reasons: [],
      created_at: "2026-10-20T18:00:00Z",
    },
    {
      id: stableUuid("tech-brief/keep-form-state"),
      request_id: stableUuid("tech-brief-request/keep-form-state"),
      feature: { key: "keep-form-state", title: "Keep form state on back navigation", entity_id: stableUuid("feature/keep-form-state") },
      // Written for v1; the PRD is at v2 now (production minors 18).
      prd: { slug: PRD, version: 1 },
      run_id: RUN,
      status: "approved",
      code_map: { used: false, repos: [], unmapped: [] },
      // As the architect writes it (production minors 19-21): a list run into one line,
      // nothing mapped (no code map), a file name and question codes in a mitigation.
      approach:
        "Keep each checkout step's fields in the session so going back shows what the buyer typed: - Save the fields when a step is left - Fill them in again when the step opens - Clear them when the order is placed",
      touches: [],
      reuse: [],
      risks: [
        {
          risk: "The session may end mid-checkout",
          level: "low",
          mitigation: "Keep the fields as long as a session lasts (questions.json); see OTR-Q1 and src-q1",
        },
      ],
      questions: [{ id: "otr-q1", question: "How long does a checkout session last?", why: "Sets when saved fields are lost", blocking: false }],
      answers: [],
      size: "s",
      size_why: "One component, if the assumption holds",
      depends_on: ["price-early"],
      assumptions: ["The checkout form keeps its state in the page"],
      verdict: { value: null, note: "Looks buildable", by: LEAD, at: "2026-10-20T18:00:00Z" },
      freshness: "potentially_stale",
      stale_reasons: ["Requirement changed: Keep the address on back navigation"],
      created_at: "2026-10-20T18:00:00Z",
    },
  ];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** What the mock's indexer writes: a docs-only map of the repository. */
function docsOnlyMap(repo: string, at: string): Record<string, unknown> {
  return {
    version: 1,
    repo,
    commit: null,
    generated_at: at,
    partial: true,
    modules: [{ id: "module:app", path: "app", summary: "The application (from its README)", depends_on: [] }],
    apis: [],
    data_models: [],
    flags: [],
    jobs: [],
  };
}

function mapOut(m: CodeMapRow, me: EngineeringContext["me"], detail: boolean): Schemas["CodeMapOut"] | CodeMap {
  const { owner_email, reads, read_refused, content, ...out } = m;
  void reads;
  void read_refused;
  // As the API: how its run ended read through the refusal rewrite, in the past once it failed.
  const view = { ...out, error: readableRefusal(out.error, out.status === "failed"), mine: owner_email === me.email };
  return detail ? { ...view, content } : view;
}

/**
 * Pass F F-5: the "code-map-approval" and "code-map-overrun" scenarios seed the Example repo's
 * code map building on a run that waits for an owner (its cost over the limit, or paused past
 * its spend limit). `runId`: the seeded run in that state, so the map's line leads to it.
 */
export const CODE_MAP_APPROVAL_SCENARIO = "code-map-approval";
export const CODE_MAP_OVERRUN_SCENARIO = "code-map-overrun";
/**
 * Pass F F-38: "code-map-shared" seeds the Example repo's map ready and shared with the
 * company, its content as an indexer writes it (parts, API routes, data models);
 * "code-map-unreadable" seeds the same map but the first read of its content fails;
 * "code-map-empty" seeds it with nothing mapped, read after a moment.
 */
export const CODE_MAP_SHARED_SCENARIO = "code-map-shared";
export const CODE_MAP_UNREADABLE_SCENARIO = "code-map-unreadable";
export const CODE_MAP_EMPTY_SCENARIO = "code-map-empty";

function sharedMap(ownerEmail: string, empty = false): CodeMapRow {
  const mapped = {
    version: 1,
    repo: "example-org/example-app",
    commit: "9b1d4e7",
    generated_at: "2026-10-28T09:00:00Z",
    partial: false,
    modules: [
      { id: "module:checkout", path: "web/checkout", summary: "The checkout pages", depends_on: ["module:billing"] },
      { id: "module:billing", path: "api/billing", summary: "Invoices and payments", depends_on: [] },
    ],
    apis: [
      { id: "api:create-invoice", method: "POST", path: "/v1/invoices", module: "module:billing" },
      { id: "api:list-invoices", method: "GET", path: "/v1/invoices", module: "module:billing" },
    ],
    data_models: [{ id: "model:invoice", name: "Invoice", module: "module:billing", fields: ["id", "total", "due_at"] }],
    flags: [],
    jobs: [],
  };
  const content = empty ? { ...mapped, modules: [], apis: [], data_models: [] } : mapped;
  return {
    id: stableUuid("code-map/shared"),
    source_id: "50000000-0000-4000-8000-000000000002",
    repo: "example-org/example-app",
    commit_sha: "9b1d4e7",
    status: "ready",
    sharing: "full",
    shared_by: stableUuid("member/admin@example.com"),
    shared_at: "2026-10-28T09:30:00Z",
    partial: false,
    as_of: "2026-10-28T09:00:00Z",
    size_bytes: JSON.stringify(content).length,
    counts: empty ? { modules: 0, apis: 0, data_models: 0, flags: 0, jobs: 0 } : { modules: 2, apis: 2, data_models: 1, flags: 0, jobs: 0 },
    run_id: stableUuid("code-map/shared/run"),
    run_status: "succeeded",
    error: null,
    failed_at: null,
    stale_at: null,
    mine: true,
    created_at: "2026-10-28T08:50:00Z",
    content,
    owner_email: ownerEmail,
    reads: 0,
  };
}

export function seedCodeMaps(scenario: string | null, runId: (status: string) => string | null, ownerEmail: string): CodeMapRow[] {
  if (scenario === CODE_MAP_SHARED_SCENARIO || scenario === CODE_MAP_UNREADABLE_SCENARIO) return [sharedMap(ownerEmail)];
  if (scenario === CODE_MAP_EMPTY_SCENARIO) return [sharedMap(ownerEmail, true)];
  const runStatus = scenario === CODE_MAP_APPROVAL_SCENARIO ? "awaiting_approval" : scenario === CODE_MAP_OVERRUN_SCENARIO ? "paused_overrun" : null;
  if (!runStatus) return [];
  return [
    {
      id: stableUuid(`code-map/${runStatus}`),
      source_id: "50000000-0000-4000-8000-000000000002",
      repo: "example-org/example-app",
      commit_sha: null,
      status: "building",
      sharing: "private",
      shared_by: null,
      shared_at: null,
      partial: false,
      as_of: null,
      size_bytes: null,
      counts: { modules: 0, apis: 0, data_models: 0, flags: 0, jobs: 0 },
      run_id: runId(runStatus),
      run_status: runStatus,
      error: null,
      failed_at: null,
      stale_at: null,
      mine: true,
      created_at: "2026-10-20T09:00:00Z",
      content: null,
      owner_email: ownerEmail,
      reads: 0,
    },
  ];
}

/** A run that waits for an owner holds its map building until the owner acts. */
const WAITS_FOR_OWNER = new Set(["awaiting_approval", "paused_overrun"]);

/** A building map's run finishes on its first read after the request. */
function advance(m: CodeMapRow, ctx: EngineeringContext) {
  if (m.status !== "building" || WAITS_FOR_OWNER.has(m.run_status ?? "")) return;
  m.reads = (m.reads ?? 0) + 1;
  if (m.reads < 2) return;
  const at = ctx.now();
  if (ctx.refuse) {
    // As codemaps.end_builds stores it: "The code map run failed: {run.error}".
    Object.assign(m, { status: "failed", run_status: "failed", failed_at: at, error: `The code map run failed: index: ${SPENT}` });
    return;
  }
  m.status = "ready";
  m.run_status = "succeeded";
  m.content = docsOnlyMap(m.repo, at);
  m.partial = true;
  m.as_of = at;
  m.size_bytes = JSON.stringify(m.content).length;
  m.counts = { modules: 1, apis: 0, data_models: 0, flags: 0, jobs: 0 };
}

async function routeCodeMaps(req: Request, p: string[], q: URLSearchParams, ctx: EngineeringContext): Promise<Response> {
  const maps = ctx.maps();
  const visible = (m: CodeMapRow) => m.sharing === "full" || m.owner_email === ctx.me.email;
  if (!p[2] && req.method === "GET") {
    maps.forEach((m) => advance(m, ctx));
    const repo = q.get("repo")?.toLowerCase();
    const status = q.get("status");
    const out = maps
      .filter(visible)
      .filter((m) => !repo || m.repo.toLowerCase() === repo)
      .filter((m) => !status || m.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json(200, out.map((m) => mapOut(m, ctx.me, false)));
  }
  const refused = () => json(403, { detail: "Requires the commenter role" });
  if (!p[2] && req.method === "POST") {
    if (!ctx.me.canWrite) return refused();
    const body = (await req.json()) as { source_id?: string; repo?: string };
    const source = body.source_id ? sourceRepos(body.source_id) : null;
    if (!source) return json(404, { detail: "Source not found" });
    if (source.kind !== "github") return json(422, { detail: "Only a GitHub source's repositories have a code map" });
    const repo = source.repos.find((r) => r.toLowerCase() === (body.repo ?? "").trim().toLowerCase());
    if (!repo) return json(422, { detail: `${body.repo} is not a repository of this source` });
    const mine = maps.filter((m) => m.source_id === body.source_id && m.repo === repo);
    if (mine.some((m) => m.status === "building")) return json(409, { detail: `A code map of ${repo} is already being built` });
    const latest = mine.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const row: CodeMapRow = {
      id: ctx.uuid(),
      source_id: body.source_id!,
      repo,
      commit_sha: null,
      status: "building",
      sharing: latest?.sharing ?? "private",
      shared_by: latest?.shared_by ?? null,
      shared_at: latest?.shared_at ?? null,
      partial: false,
      as_of: null,
      size_bytes: null,
      counts: { modules: 0, apis: 0, data_models: 0, flags: 0, jobs: 0 },
      run_id: ctx.uuid(),
      run_status: "running",
      error: null,
      failed_at: null,
      stale_at: null,
      mine: true,
      created_at: ctx.now(),
      content: null,
      owner_email: ctx.me.email,
      reads: 0,
    };
    maps.push(row);
    return json(201, mapOut(row, ctx.me, false));
  }
  const row = maps.find((m) => m.id === p[2] && visible(m));
  if (!row) return json(404, { detail: "Code map not found" });
  if (!p[3] && req.method === "GET") {
    if (ctx.unreadable && !row.read_refused) {
      row.read_refused = true;
      return json(500, { detail: "The code map could not be read. Try again later." });
    }
    if (ctx.slowRead) await new Promise((done) => setTimeout(done, 1000));
    advance(row, ctx);
    return json(200, mapOut(row, ctx.me, true));
  }
  if (p[3] === "sharing" && req.method === "POST") {
    if (!ctx.me.canWrite) return refused();
    if (row.owner_email !== ctx.me.email) return json(404, { detail: "Code map not found" });
    const { sharing } = (await req.json()) as { sharing: CodeMap["sharing"] };
    if (sharing !== "full" && sharing !== "private") return json(422, { detail: "sharing must be private or full" });
    const at = ctx.now();
    for (const m of maps.filter((x) => x.source_id === row.source_id && x.repo === row.repo)) {
      m.sharing = sharing;
      m.shared_by = sharing === "full" ? ctx.me.id : null;
      m.shared_at = sharing === "full" ? at : null;
    }
    return json(200, mapOut(row, ctx.me, false));
  }
  return json(405, { detail: "Method not allowed" });
}

/** F5 lane 3: a tech brief's PRD and status by its version id (the specs mock checks a request's brief). */
export function techBriefOf(id: string): { prd: string; status: string } | null {
  const b = seedBriefs().find((x) => x.id === id);
  return b ? { prd: b.prd.slug, status: b.status } : null;
}

/** The tech brief and code map routes, or null for any other path. */
export async function routeEngineering(req: Request, p: string[], q: URLSearchParams, ctx: EngineeringContext): Promise<Response | null> {
  if (p[1] === "code-maps") return routeCodeMaps(req, p, q, ctx);
  const documents = ctx.documents;
  if (p[1] !== "tech-briefs" || req.method !== "GET") return null;
  const briefs = seedBriefs();
  if (p[2]) {
    const one = briefs.find((b) => b.id === p[2]);
    return one ? json(200, one) : json(404, { detail: "Tech brief not found" });
  }
  let out = briefs;
  const prd = q.get("prd");
  if (prd) {
    const doc = documents.find((d) => d.slug === prd || d.id === prd);
    if (!doc) return json(404, { detail: `document '${prd}' not found` });
    out = out.filter((b) => b.prd.slug === doc.slug);
  }
  const feature = q.get("feature");
  if (feature) out = out.filter((b) => b.feature.key === feature);
  return json(200, out);
}
