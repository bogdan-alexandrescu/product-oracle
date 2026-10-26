import { expect, test } from "./test";

import type { Nudges } from "../lib/api/mock/learned";
import { routeModules, seedModules } from "../lib/api/mock/modules";

// The mock's composition routes mirror the API's (no page: no screen confirms yet).
const DOC = { id: "d0000000-0000-4000-8000-000000000001", slug: "placeholder-prd", template: "oracle-default" };
const USER = "u0000000-0000-4000-8000-000000000001";

function api(role = "approver", learned: Nudges = {}) {
  const db = seedModules(null, USER); // no composition seeded for DOC
  const ctx = { userId: USER, role, document: () => DOC, approvedVersion: () => null, learned: () => learned } as Parameters<typeof routeModules>[1];
  return {
    db,
    async call(method: string, path: string, body?: unknown) {
      const req = new Request(`http://mock/v1/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const res = (await routeModules(db, ctx, req, ["v1", ...path.split("/")], new URLSearchParams()))!;
      return { status: res.status, json: await res.json() };
    },
  };
}

test("re-sending an earlier removal refreshes its reason instead of refusing", async () => {
  const { call } = api();
  const url = `documents/${DOC.slug}/composition/revisions`;
  const inputs = { scope: { capabilities: ["usage_billing"] } };
  expect((await call("POST", url, { base_revision: null, reason: "First", inputs })).status).toBe(201);
  expect((await call("POST", url, { base_revision: 1, reason: "Later", inputs, changes: { remove: ["economics.value"] } })).status).toBe(201);
  const again = await call("POST", url, { base_revision: 2, reason: "Next quarter", changes: { remove: ["economics.value"] } });
  expect(again.status).toBe(201);
  const value = again.json.current.modules.find((m: { key: string }) => m.key === "economics.value");
  expect(value).toMatchObject({ included: false, decided_by: "user", user_reason: "Next quarter" });
  expect(again.json.problems).toEqual([]);
});

test("only a chosen pack carries; a default pack is recomputed", async () => {
  const { call, db } = api();
  const url = `documents/${DOC.slug}/composition/revisions`;
  const first = await call("POST", url, { base_revision: null, reason: "First" });
  expect(first.json.current.inputs.policy.packs_source).toBe("category");
  db.policy.default_packs = ["ai-agent.platform"];
  const second = await call("POST", url, { base_revision: 1, reason: "Default changed" });
  expect(second.json.current.packs).toEqual(["ai-agent.platform"]);
  expect(second.json.current.inputs.policy.packs_source).toBe("default");
  const chosen = await call("POST", url, { base_revision: 2, reason: "Chosen", packs: ["startup.standard"] });
  expect(chosen.json.current.inputs.policy.packs_source).toBe("chosen");
  const kept = await call("POST", url, { base_revision: 3, reason: "Re-confirm" });
  expect(kept.json.current.packs).toEqual(["startup.standard"]);
});

const more = (target: string, statement: string): Nudges => ({ [target]: { target, net: 3, count: 1, statements: [statement] } });

test("a learning lifts an unconditional optional module, as the API's composer", async () => {
  // protects=_apply_learned: a recommend_more learning suggests an optional module nothing
  // else brings in, decided by the learning; fails_when=the mock leaves it out;
  // no_claim=the API (tests/test_learnings_tune.py).
  const { call, db } = api("approver", more("usage.analytics", "Usage signals caught churn twice."));
  const base = db.catalog.find((c) => c.key === "economics.value")!;
  db.catalog.push({ ...base, key: "usage.analytics", title: "Usage analytics", policy: "optional", contract: { ...base.contract, id: "usage.analytics", policy: "optional" } });
  const rec = await call("POST", "compositions/recommend", { document: DOC.slug, inputs: {} });
  const usage = rec.json.modules.find((m: { key: string }) => m.key === "usage.analytics");
  expect(usage).toMatchObject({ selection: "suggested", included: true, decided_by: "learning" });
  expect(usage.reason).toBe("Recommended because of a learning from past outcomes: Usage signals caught churn twice.");
});

test("a learning never lifts a conditional module whose condition did not hold, as the API's composer", async () => {
  // protects=BGD 2026-10-25 "condition must hold": the mock keeps a conditional module whose
  // condition failed out of the recommendation however heavy the learning, and only explains
  // it; fails_when=the mock suggests it, unlike the API; no_claim=the API
  // (test_a_learning_never_lifts_a_module_whose_condition_failed).
  const { call } = api("approver", more("economics.value", "Value cases won the budget."));
  const rec = await call("POST", "compositions/recommend", { document: DOC.slug, inputs: {} });
  const value = rec.json.modules.find((m: { key: string }) => m.key === "economics.value");
  expect(value).toMatchObject({ selection: "optional", included: false, decided_by: "condition" });
  expect(value.reason).toBe("Not suggested: its condition did not hold.");
  expect(value.explanation).toContain("Recommended because of a learning from past outcomes: Value cases won the budget.");
});
