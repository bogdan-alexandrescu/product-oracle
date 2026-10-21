/**
 * Mock of the tech brief reads (api/oracle/engineering/router.py) for NEXT_PUBLIC_API_MOCKS=1:
 * `GET /v1/tech-briefs?prd=&feature=` and `GET /v1/tech-briefs/{id}`. The seed stands for
 * what an approved Engineering check registered on the checkout PRD: one brief per feature,
 * one resting on a shared code map and one written without a map. Synthetic placeholders
 * only; every member reads (viewer+), as in the API.
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";

type TechBrief = Schemas["TechBriefOut"];

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
        repos: [{ repo: "example/shop-app", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z" }],
      },
      approach:
        "Compute the total in the pricing module as soon as the cart changes, and show it in the checkout summary from the first step.",
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
      id: stableUuid("tech-brief/keep-form-state"),
      request_id: stableUuid("tech-brief-request/keep-form-state"),
      feature: { key: "keep-form-state", title: "Keep form state on back navigation", entity_id: stableUuid("feature/keep-form-state") },
      prd: { slug: PRD, version: 2 },
      run_id: RUN,
      status: "approved",
      code_map: { used: false, repos: [] },
      approach: "Keep each checkout step's fields in the session so going back shows what the buyer typed.",
      touches: [{ area: "checkout form", kind: "module", change: "change", ref: null }],
      reuse: [],
      risks: [],
      questions: [],
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

/** The tech brief routes, or null for any other path. `documents`: the PRDs' slugs and ids. */
export function routeEngineering(
  req: Request,
  p: string[],
  q: URLSearchParams,
  documents: { id: string; slug: string }[],
): Response | null {
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
