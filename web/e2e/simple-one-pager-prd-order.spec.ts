import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * prd-order (the owner, Nov 5: "the PRDs should be in a different order"): one company PRD order
 * every page lists PRDs in. Driven through the UI on the mock (invented data): without a stored
 * place, a PRD follows the goal it mainly serves (Usage alerts PRD, whose roadmap items serve
 * Grow retention, before Checkout redesign PRD, which serves none), then its title. The owner
 * moves Checkout redesign PRD up from its ⋯ on One-pagers; the Roadmap's "came from" lines, its PRD
 * filter and Home (as a viewer, who has no ⋯) read the new order.
 *
 * - protects = One-pagers, the Roadmap's from-lines and PRD filter, and Home list PRDs in the one
 *   order, and Move up changes it on each; fails_when = newest first, by title, or as the roadmap
 *   met them, or a viewer may move a PRD.
 * - no_claim = the API's rule and route (api/tests/test_prd_order.py). Priorities lists no PRDs
 *   (its Line picker is by date), so it has nothing to order.
 */

const USAGE = "Usage alerts PRD";
const CHECKOUT = "Checkout redesign PRD";

/** The mock's roadmap with an item from Checkout redesign PRD, and a working draft both PRDs put items in. */
async function seed(page: Page) {
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const rm = db.simple_roadmap;
    const doc = (slug: string) => db.documents.find((d: { slug: string }) => d.slug === slug);
    const ref = (slug: string) => ({ id: doc(slug).id, slug, title: doc(slug).title });
    const item = rm.items.find((x: { key: string }) => x.key === "alert-export");
    item.from_prd = { slug: "checkout-redesign", title: doc("checkout-redesign").title };
    const owner = db.members.find((m: { role: string }) => m.role === "owner");
    const items = rm.items.filter((x: { roadmap: string }) => x.roadmap === "alerts-roadmap");
    (rm.drafts ??= []).push({
      roadmap: "alerts-roadmap",
      published: { items: structuredClone(items), own: {}, key_dates: [] },
      prds: {
        "checkout-redesign": { prd: ref("checkout-redesign"), version: 1, keys: ["alert-export"], key_dates: [] },
        "usage-alerts": { prd: ref("usage-alerts"), version: 1, keys: ["alert-rules"], key_dates: [] },
      },
      out: {
        id: crypto.randomUUID(), document: { id: crypto.randomUUID(), slug: "alerts-roadmap", title: "Alerts roadmap" },
        status: "working", base_version: 1, version: null, created_by: owner.id, created_at: "2026-10-20T09:00:00Z", participant_ids: [owner.id],
        submitted_at: null, submitted_by: null, decider_approved: false, waiting_on: [], approved_at: null, blocked_by: [], decision_notes: [],
      },
    });
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  });
}

async function onePagers(page: Page): Promise<string[]> {
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
  return page.getByTestId("one-pager-row").getByRole("link").allTextContents();
}

/** The Roadmap's "came from" lines and PRD filter, each as the PRDs it names in order. */
async function roadmap(page: Page): Promise<{ from: string[]; filter: string[] }> {
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByTestId("draft-from-prd")).toHaveCount(2);
  const from = (await page.getByTestId("draft-from-prd").allTextContents()).map((t) => (t.includes(CHECKOUT) ? CHECKOUT : t.includes(USAGE) ? USAGE : t));
  const filter = await page.getByLabel("PRD", { exact: true }).locator("option").allTextContents();
  return { from, filter: filter.filter((t) => t === CHECKOUT || t === "Usage alerts") };
}

test("an owner moves a PRD and every page lists PRDs in the new order", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByLabel("PRD", { exact: true })).toBeVisible();
  await seed(page);

  // The default: the goal each PRD mainly serves, then the title.
  const before = await onePagers(page);
  expect(before.slice(0, 2)).toEqual([USAGE, CHECKOUT]);
  expect(await roadmap(page)).toEqual({ from: [USAGE, CHECKOUT], filter: ["Usage alerts", CHECKOUT] });

  // The owner moves Checkout redesign PRD up from its ⋯; the first PRD has no Move up.
  await page.goto("/simple/one-pagers");
  await page.getByRole("button", { name: `More for ${USAGE}` }).click();
  await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `More for ${CHECKOUT}` }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(page.getByTestId("one-pager-row").getByRole("link").first()).toHaveText(CHECKOUT);
  const after = await onePagers(page);
  expect(after).toEqual([CHECKOUT, USAGE, ...before.slice(2)]);
  expect(await roadmap(page)).toEqual({ from: [CHECKOUT, USAGE], filter: [CHECKOUT, "Usage alerts"] });

  // A viewer reads the same order, on One-pagers and Home, and has no ⋯ to move one.
  await page.goto("/home");
  await signOut(page);
  await login(page, "viewer@example.com");
  expect(await onePagers(page)).toEqual(after);
  await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);
  await page.goto("/simple");
  const read = page.getByTestId("home-read");
  await expect(read.getByRole("link", { name: CHECKOUT })).toBeVisible();
  const home = (await read.getByRole("link").allTextContents()).filter((t) => after.includes(t));
  expect(home).toEqual(after.slice(0, home.length));
});
