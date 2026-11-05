import { expect, test, type Page } from "./test";

import { VERSION_WARNINGS_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * #396 Warnings speak the app's words: a roadmap version's warnings say what to do
 * in the app, never an API route or a raw id. On the mock layer, driven as a person would.
 * The "version-warnings" scenario gives usage-alerts-roadmap v1 the API's warnings: a date
 * with no verified basis, a citation whose source item Oracle no longer has, and feedback an
 * agent's draft left open.
 */

const ROUTE_OR_ID = /\/v1\/|\b(GET|POST|PUT|PATCH|DELETE)\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function openVersion(page: Page, email?: string) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, VERSION_WARNINGS_SCENARIO]);
  await login(page, email);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
}

const chip = (page: Page) => page.getByTestId("version-warnings-chip").filter({ visible: true });
const tip = (page: Page) => page.getByRole("tooltip").filter({ visible: true });

test("the warnings say what to do, and the date chip opens Plan › Dates", async ({ page }) => {
  // protects=#396 Done when 2; fails_when=a warning shows a route, a method or an id, the
  // dates chip does not point to Plan › Dates, or the citation warning names the item's
  // id; no_claim=the API's wording (api/tests/test_warning_wording.py).
  // B-09: the warnings are in the header chip's tip, the dates in their own chip; the body
  // shows no warning cards, only one line naming the sections still open.
  await openVersion(page);
  await expect(page.locator('[data-warning]:not([data-state="done"])').filter({ visible: true })).toHaveCount(0);
  await expect(chip(page)).toHaveText("2 warnings");
  await chip(page).click();
  await expect(tip(page)).toContainText("A citation in \"Summary\" names a source item Oracle no longer has");
  // The feedback an agent's draft left open, by section heading; the ids stay in refs.
  await expect(tip(page)).toContainText('2 feedback items stay open: on "Summary" and "Behaviour"');
  expect(await tip(page).innerText()).not.toMatch(ROUTE_OR_ID);
  await page.keyboard.press("Escape");

  const open = page.getByTestId("warned-sections").filter({ visible: true });
  await expect(open).toContainText("Still open in");
  await expect(open.getByRole("link", { name: "Summary" })).toBeVisible();
  await expect(open.getByRole("link", { name: "Behaviour" })).toBeVisible();
  expect(await open.innerText()).not.toMatch(ROUTE_OR_ID);

  const dates = page.getByTestId("dates-lacking").filter({ visible: true });
  await expect(dates).toHaveText("1 date lacks a basis");
  await dates.click();
  // date-warnings-honest: filtered to the date that lacks a basis.
  await expect(page).toHaveURL(/\/plan\/dates\?prd=[^&]+&dates=2026-12-15$/);
  await expect(page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-dates")).toHaveAttribute("aria-current", "page");
});

test("a viewer reads the same plain warnings", async ({ page }) => {
  // protects=#396 every role sees the app's words; fails_when=a viewer's warnings show a
  // route or an id; no_claim=who may record a basis (e2e/date-bases.spec.ts).
  await openVersion(page, "viewer@example.com");
  await expect(page.getByTestId("dates-lacking").filter({ visible: true })).toHaveText("1 date lacks a basis");
  await chip(page).click();
  await expect(tip(page)).toContainText("a source item Oracle no longer has");
  expect(await tip(page).innerText()).not.toMatch(ROUTE_OR_ID);
});

test("Approve on a spec version that may be stale says what to do, in the app's words", async ({ page }) => {
  // protects=#396 fixes 2 item 1: the spec approval refusal a person reads; fails_when=it
  // shows a route, a method or an id, or the stale version is approved; no_claim=when a
  // spec is stale (api/tests/test_specs.py).
  await login(page);
  await page.goto("/documents/checkout-redesign-early-shipping-cost-spec/v/1");
  await page.getByRole("button", { name: "Approve version" }).click();
  await page.getByRole("group", { name: "Confirm approval" }).getByRole("button", { name: "Confirm" }).click();
  const refusal = page.getByRole("group", { name: "Confirm approval" }).getByRole("alert");
  await expect(refusal).toContainText(/this spec version may be stale/i);
  await expect(refusal).toContainText("Potentially stale");
  expect(await refusal.innerText()).not.toMatch(ROUTE_OR_ID);
  await expect(page.getByText(/✓ Approved/)).toHaveCount(0);
});
