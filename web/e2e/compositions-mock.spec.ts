import { expect, test } from "./test";

import { routeModules, seedModules } from "../lib/api/mock/modules";

// The mock's composition routes mirror the API's (no page: no screen confirms yet).
const DOC = { id: "d0000000-0000-4000-8000-000000000001", slug: "placeholder-prd", template: "oracle-default" };
const USER = "u0000000-0000-4000-8000-000000000001";

function api(role = "approver") {
  const db = seedModules(null, USER); // no composition seeded for DOC
  const ctx = { userId: USER, role, document: () => DOC, approvedVersion: () => null } as Parameters<typeof routeModules>[1];
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
