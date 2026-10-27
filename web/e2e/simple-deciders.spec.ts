import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * #734 review (D-a): who decides a Simple change, in the "simple-deciders" scenario: the
 * pricing roadmap names Dana Decider (an approver) its decider; with no decider, the alerts
 * track's owner Avery Lane (an approver), the onboarding track's Cory Hale (a commenter) and
 * the welcome track's Vic Moss (a viewer) decide only as approvers. Simple S2-S3b have no
 * screen yet, so each person signs in through the sign-in page, in a tab of their own, and
 * the test sends Simple's calls through the mock as the app would.
 *
 * Card simple-deciders: protects = an approver track owner's change applies and undoes; a
 * commenter track owner's change is a proposal routed to the company's owners; a viewer
 * track owner decides nothing; the named decider applies directly and others' changes go
 * to them; fails_when = the mock never names a decider or track owner (the people can't
 * sign in, every change goes to owners), or a track owner decides below the approver role;
 * no_claim = Simple's screens (none yet), the real API (api/tests/test_simple_review_fixes.py).
 */

type Call = { status: number; body: any };

async function call(page: Page, method: string, path: string, body?: unknown): Promise<Call> {
  return page.evaluate(
    async ([method, path, body]) => {
      const w = globalThis as unknown as { __poMockFetch?: (r: Request) => Promise<Response> };
      const req = new Request(new URL(path, location.origin), {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const res = await w.__poMockFetch!(req);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body] as const,
  );
}

/** A tab signed in as `email`, through the sign-in page. */
async function as(page: Page, email: string): Promise<Page> {
  const tab = await page.context().newPage();
  await login(tab, email);
  return tab;
}

async function items(tab: Page): Promise<Record<string, { id: string; title: string; suggestion: { id: string; can_decide: boolean } | null }>> {
  const r = await call(tab, "GET", "/v1/simple/roadmap");
  expect(r.status).toBe(200);
  return Object.fromEntries(r.body.items.map((i: { key: string }) => [i.key, i]));
}

async function retitle(tab: Page, key: string, title: string): Promise<Call> {
  const item = (await items(tab))[key];
  return call(tab, "POST", "/v1/simple/changes", { op: "edit_title", target: { item_id: item.id }, before: { title: item.title }, after: { title } });
}

async function meId(tab: Page): Promise<string> {
  return (await call(tab, "GET", "/v1/me")).body.id;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "simple-deciders"), MOCK_SCENARIO_KEY);
});

test("an approver track owner's change applies and undoes", async ({ page }) => {
  const avery = await as(page, "avery.lane@example.com");
  expect((await items(avery))["alert-sso"].suggestion?.can_decide).toBe(true);
  const r = await retitle(avery, "alert-export", "Alert history export (CSV)");
  expect(r.status).toBe(201);
  expect(r.body.change.status).toBe("applied");
  expect(r.body.change.can_undo).toBe(true);
  expect((await items(avery))["alert-export"].title).toBe("Alert history export (CSV)");
  const undo = await call(avery, "POST", `/v1/simple/changes/${r.body.change.id}/undo`);
  expect(undo.status).toBe(201);
  expect((await items(avery))["alert-export"].title).toBe("Alert history export");
});

test("a commenter track owner's change is a proposal to the company's owners", async ({ page }) => {
  const admin = await as(page, "admin@example.com");
  const cory = await as(page, "cory.hale@example.com");
  const r = await retitle(cory, "setup-checklist", "Setup checklist v2");
  expect(r.status).toBe(201);
  expect(r.body.change.status).toBe("proposed");
  expect(r.body.change.routed_to).toEqual([await meId(admin)]);
  expect(r.body.change.routed_to).not.toContain(await meId(cory));
  expect((await items(cory))["setup-checklist"].title).toBe("Setup checklist");
  const inbox = await call(admin, "GET", "/v1/inbox");
  expect(inbox.body.simple_proposals.map((x: { id: string }) => x.id)).toContain(r.body.change.id);
});

test("a viewer track owner decides nothing", async ({ page }) => {
  const vic = await as(page, "vic.moss@example.com");
  const video = (await items(vic))["setup-video"];
  expect(video.suggestion).not.toBeNull();
  expect(video.suggestion?.can_decide).toBe(false);
  expect((await retitle(vic, "setup-video", "Welcome video, short")).status).toBe(403);
  expect((await call(vic, "POST", `/v1/simple/roadmap/date-suggestions/${video.suggestion!.id}/dismiss`)).status).toBe(403);
  // Someone else's change on Vic's track goes to the owners, not to Vic.
  const admin = await as(page, "admin@example.com");
  const cory = await as(page, "cory.hale@example.com");
  const r = await retitle(cory, "setup-video", "Welcome video, short");
  expect(r.body.change.status).toBe("proposed");
  expect(r.body.change.routed_to).toEqual([await meId(admin)]);
});

test("the named decider applies directly; others' changes go to them", async ({ page }) => {
  const dana = await as(page, "dana.decider@example.com");
  const approver = await as(page, "approver@example.com");
  const p = await retitle(approver, "price-tiers", "New plan tiers, annual");
  expect(p.body.change.status).toBe("proposed");
  expect(p.body.change.routed_to).toEqual([await meId(dana)]);
  const inbox = await call(dana, "GET", "/v1/inbox");
  expect(inbox.body.simple_proposals.map((x: { id: string }) => x.id)).toContain(p.body.change.id);
  const r = await retitle(dana, "price-tiers", "New plan tiers 2027");
  expect(r.status).toBe(201);
  expect(r.body.change.status).toBe("applied");
  expect(r.body.change.can_undo).toBe(true);
  expect((await items(dana))["price-tiers"].title).toBe("New plan tiers 2027");
});
