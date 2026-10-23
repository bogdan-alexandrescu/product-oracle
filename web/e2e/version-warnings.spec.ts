import { expect, test, type Page } from "@playwright/test";

import { VERSION_WARNINGS_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * #396 Warnings speak the app's words: a roadmap version's Warnings panel says what to do
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

const warning = (page: Page, code: string) => page.locator(`[data-warning="${code}"]`).filter({ visible: true });

test("the Warnings panel says what to do, and the date warning opens Plan › Dates", async ({ page }) => {
  // protects=#396 Done when 2; fails_when=a warning shows a route, a method or an id, the
  // date warning does not point to Plan › Dates, or the citation warning names the item's
  // id; no_claim=the API's wording (api/tests/test_warning_wording.py).
  await openVersion(page);
  const date = warning(page, "unverified_date");
  await expect(date).toContainText("the date 2026-12-15");
  await expect(date).toContainText("record a date basis on Plan › Dates");
  await expect(date).toContainText('"Usage alerts PRD"');
  const citation = warning(page, "unknown_citation_item");
  await expect(citation).toContainText("a source item Oracle no longer has");
  // The feedback an agent's draft left open, by section heading; the ids stay in refs.
  const leftOpen = warning(page, "resolution_not_applied");
  await expect(leftOpen).toContainText('2 feedback items stay open: on "Summary" and "Behaviour"');
  for (const w of [date, citation, leftOpen]) expect(await w.innerText()).not.toMatch(ROUTE_OR_ID);

  await date.getByRole("link", { name: "Open Plan › Dates" }).click();
  await expect(page).toHaveURL(/\/plan\/dates$/);
  await expect(page.getByRole("heading", { name: "Dates" }).first()).toBeVisible();
});

test("a viewer reads the same plain warnings", async ({ page }) => {
  // protects=#396 every role sees the app's words; fails_when=a viewer's panel shows a
  // route or an id; no_claim=who may record a basis (e2e/date-bases.spec.ts).
  await openVersion(page, "viewer@example.com");
  await expect(warning(page, "unverified_date")).toContainText("ask the engineering lead");
  expect(await warning(page, "unknown_citation_item").innerText()).not.toMatch(ROUTE_OR_ID);
});
