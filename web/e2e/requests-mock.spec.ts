import { expect, test } from "./test";

import { routeRequests, seedRequests, type RequestsContext } from "../lib/api/mock/requests";
import { login } from "./helpers";

/**
 * C1 Requests, lane 1 (API). The screen comes in lane 2, so this drives the requests mock
 * (./lib/api/mock/requests.ts) the way intake-mock.spec.ts drives the intake one: the
 * shapes the API returns and the same rules, which the screen's specs then build on.
 * Card: protects=the mock agrees with the API's rules (states, merge roots, roles,
 * private found items); fails_when=a count, a refusal or a role check disagrees with
 * api/oracle/requests; no_claim=the real API (tests/test_requests.py) and the screen.
 */
const ADMIN_ID = "b1000000-0000-4000-8000-000000000001";
const OTHER_ID = "b1000000-0000-4000-8000-000000000002";
const GOALS = [
  { id: "e1000000-0000-4000-8000-000000000001", key: "g.activation", title: "Raise activation", status: "confirmed" },
  { id: "e1000000-0000-4000-8000-000000000002", key: "g.retention", title: "Keep teams", status: "confirmed" },
  { id: "e1000000-0000-4000-8000-000000000003", key: "g.idea", title: "An idea", status: "proposed" },
];
const FEATURES = [{ id: "f1000000-0000-4000-8000-000000000001", key: "f.saved-addresses", title: "Saved addresses" }];

type Role = RequestsContext["role"];

function setup() {
  const db = seedRequests({ ownerId: ADMIN_ID, goals: GOALS.filter((g) => g.status === "confirmed"), features: FEATURES });
  const ctx = (role: Role, userId = ADMIN_ID): RequestsContext => ({
    userId,
    role,
    goals: () => GOALS,
    features: () => FEATURES,
    documents: () => [],
  });
  const call = async (role: Role, method: string, path: string, body?: unknown, userId = ADMIN_ID) => {
    const url = new URL(path, "http://mock");
    const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const resp = await routeRequests(db, ctx(role, userId), req, url.pathname.split("/").filter(Boolean), url.searchParams);
    return { status: resp?.status ?? 0, body: resp ? await resp.json() : null };
  };
  return { db, call };
}

type Row = { id: string; title: string; state: string; mentions: number; lock_version: number; goal_ids: string[] };

test("requests mock: the seeded queue and its counts", async () => {
  const { call } = setup();
  const list = await call("viewer", "GET", "/v1/requests?limit=200");
  expect(list.status).toBe(200);
  expect(list.body.total).toBe(12);
  expect(list.body.counts).toEqual({ all: 12, new: 5, qualified: 4, merged: 2, disqualified: 1 });
  expect(Object.keys(list.body.by_channel)).toHaveLength(4);
  const rows = list.body.items as Row[];
  for (const [state, n] of Object.entries(list.body.counts)) {
    if (state !== "all") expect(rows.filter((r) => r.state === state)).toHaveLength(n as number);
  }
  // One New request carries Oracle's suggestion; the root of the two merged ones counts them.
  expect(rows.filter((r) => r.state === "new" && (r as unknown as { suggestion: unknown }).suggestion)).toHaveLength(1);
  expect(Math.max(...rows.map((r) => r.mentions))).toBe(3);
  const themes = await call("viewer", "GET", "/v1/request-themes");
  expect(themes.body).toHaveLength(3);

  const news = await call("viewer", "GET", "/v1/requests?state=new");
  expect(news.body.total).toBe(5);
  expect(news.body.counts.all).toBe(12);
});

test("requests mock: qualify needs a confirmed goal; accepting the suggestion links one", async () => {
  const { call } = setup();
  const rows = (await call("approver", "GET", "/v1/requests?state=new")).body.items as (Row & { suggestion: { goal_ids: string[] } | null })[];
  const row = rows.find((r) => r.suggestion)!;
  expect(row.goal_ids).toEqual([]);

  const refused = await call("approver", "POST", `/v1/requests/${row.id}/qualify`, { lock_version: row.lock_version });
  expect(refused.status).toBe(422);
  expect(refused.body.detail).toBe("Link a confirmed goal first, or disqualify it as 'No goal'");
  const unconfirmed = await call("approver", "POST", `/v1/requests/${row.id}/qualify`, { lock_version: row.lock_version, goal_ids: [GOALS[2].id] });
  expect(unconfirmed.status).toBe(422);

  const accepted = await call("approver", "POST", `/v1/requests/${row.id}/suggestion/accept`, { lock_version: row.lock_version, parts: ["goals"] });
  expect(accepted.status).toBe(200);
  expect(accepted.body.state).toBe("new");
  expect(accepted.body.goal_ids).toEqual(row.suggestion!.goal_ids);

  const stale = await call("approver", "POST", `/v1/requests/${row.id}/qualify`, { lock_version: row.lock_version });
  expect(stale.status).toBe(409);
  const qualified = await call("approver", "POST", `/v1/requests/${row.id}/qualify`, { lock_version: accepted.body.lock_version });
  expect(qualified.status).toBe(200);
  expect(qualified.body.state).toBe("qualified");
  expect(qualified.body.decided_by).toBe(ADMIN_ID);
  const counts = (await call("viewer", "GET", "/v1/requests")).body.counts;
  expect(counts).toMatchObject({ new: 4, qualified: 5 });
});

test("requests mock: merge resolves to the root, refuses a cycle, and reopen restores both", async () => {
  const { call } = setup();
  const add = async (title: string) => (await call("commenter", "POST", "/v1/requests", { title, channel: "support" })).body as Row;
  const a = await add("A");
  const b = await add("B");
  const c = await add("C");
  expect((await call("approver", "POST", `/v1/requests/${b.id}/merge`, { lock_version: 1, into_id: c.id })).status).toBe(200);
  const merged = await call("approver", "POST", `/v1/requests/${a.id}/merge`, { lock_version: 1, into_id: b.id });
  expect(merged.body.merged_into_id).toBe(c.id);
  const cycle = await call("approver", "POST", `/v1/requests/${c.id}/merge`, { lock_version: 1, into_id: a.id });
  expect(cycle.status).toBe(409);
  const root = await call("viewer", "GET", `/v1/requests/${c.id}`);
  expect(root.body.mentions).toBe(3);
  expect((root.body.merged as Row[]).map((r) => r.title).sort()).toEqual(["A", "B"]);

  const reopened = await call("approver", "POST", `/v1/requests/${a.id}/reopen`, { lock_version: merged.body.lock_version });
  expect(reopened.body.state).toBe("new");
  expect((await call("viewer", "GET", `/v1/requests/${c.id}`)).body.mentions).toBe(2);

  const other = await call("approver", "POST", `/v1/requests/${a.id}/disqualify`, { lock_version: reopened.body.lock_version, reason: "other" });
  expect(other.status).toBe(422);
});

test("requests mock: commenters add, viewers read, only approvers decide", async () => {
  const { call } = setup();
  const created = await call("commenter", "POST", "/v1/requests", { title: "Export to spreadsheet", channel: "team", requester_kind: "team" });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ state: "new", origin: "person", verified: true, mentions: 1, filed_by: ADMIN_ID });
  expect((await call("viewer", "POST", "/v1/requests", { title: "x", channel: "team" })).status).toBe(403);
  const interview = await call("commenter", "POST", "/v1/requests", { title: "x", channel: "interview" });
  expect(interview.status).toBe(422);
  expect(interview.body.detail).toBe("Interview requests come from interviews");
  for (const [verb, body] of [
    ["qualify", {}],
    ["merge", { into_id: created.body.id }],
    ["disqualify", { reason: "no_goal" }],
    ["suggestion/accept", { parts: ["goals"] }],
  ] as const) {
    const r = await call("commenter", "POST", `/v1/requests/${created.body.id}/${verb}`, { lock_version: 1, ...body });
    expect(r.status, verb).toBe(403);
  }
  expect((await call("commenter", "POST", "/v1/request-themes", { title: "New theme", goal_ids: [] })).status).toBe(403);
  const theme = await call("approver", "POST", "/v1/request-themes", { title: "New theme", goal_ids: [GOALS[0].id] });
  expect(theme.status).toBe(201);
  expect((await call("approver", "POST", "/v1/request-themes", { title: "new THEME", goal_ids: [] })).status).toBe(409);
});

test("requests mock: found items are their owner's alone; filing shares the title, link and excerpt", async () => {
  const { call } = setup();
  const mine = await call("owner", "GET", "/v1/request-candidates?status=open");
  expect(mine.body).toHaveLength(2);
  expect((await call("approver", "GET", "/v1/request-candidates", undefined, OTHER_ID)).body).toEqual([]);
  const [first, second] = mine.body as { id: string; title: string }[];
  expect((await call("approver", "POST", `/v1/request-candidates/${first.id}/file`, {}, OTHER_ID)).status).toBe(404);
  expect((await call("viewer", "POST", `/v1/request-candidates/${first.id}/file`, {})).status).toBe(403);

  const filed = await call("owner", "POST", `/v1/request-candidates/${first.id}/file`, {});
  expect(filed.status).toBe(201);
  expect(filed.body.title).toBe(first.title);
  expect(filed.body.source.removed).toBe(false);
  expect(filed.body.source.excerpt.length).toBeGreaterThan(0);
  expect(filed.body.source.excerpt.length).toBeLessThanOrEqual(400);
  expect((await call("owner", "GET", "/v1/request-candidates?status=open")).body).toHaveLength(1);
  const seen = await call("viewer", "GET", `/v1/requests/${filed.body.id}`, undefined, OTHER_ID);
  expect(seen.body.source).toEqual(filed.body.source);

  const dismissed = await call("owner", "POST", `/v1/request-candidates/${second.id}/dismiss`);
  expect(dismissed.body.status).toBe("dismissed");
  expect((await call("owner", "GET", "/v1/request-candidates?status=open")).body).toEqual([]);
});

test("Requests: the rail item still opens the Requests screen with the mock's routes in place", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-requests").click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole("heading", { name: "Requests" })).toBeVisible();
});
