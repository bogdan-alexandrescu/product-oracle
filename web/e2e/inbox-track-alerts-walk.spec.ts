import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The stale-marks walk (Nov 6, 2026): a person reconciled 'May be stale' roadmap items and the
 * Inbox did not follow. On the mock layer, the "track-alerts-stale" scenario
 * (lib/api/mock/roadmap.ts) adds to the Usage alerts track's date slip a stale alert on
 * "Budgets per team" (its PRD section Behaviour changed), and gives the roadmap's first item a
 * dependency on it, an item that version has no row for. The API's rules (the alert resolving
 * at once, each track's own items, the names) are proven by
 * api/tests/test_inbox_track_alerts_walk.py; each test here proves what a person sees and does.
 * "track-alerts-stale-removed" is the same with the section removed in version 2.
 */

const STALE = "Budgets per team";
const REASON = "PRD section Behaviour changed in version 2";

async function withStale(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "track-alerts-stale"), MOCK_SCENARIO_KEY);
  await login(page);
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });
const trackLabel = (page: Page) => page.locator('[data-need="Track"]').filter({ visible: true }).getByTestId("track-label");
const alertRows = (page: Page) => page.locator('[data-need="Track alert"]').filter({ visible: true });
const staleCard = (page: Page) =>
  page.getByTestId("plan-inspector").filter({ visible: true }).locator('[data-testid="plan-alert"][data-kind="stale"]');

async function openInbox(page: Page) {
  await rail(page).getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
}

// protects = the Inbox row's Review opens the Plan item panel with the Items tab's Still valid…
// already open (reason, Mark still valid), and marking it still valid takes the alert out of the
// track's group and its count at once; fails_when = Review only opens the Plan (no reason field),
// the alert stays after reconciling, or the count does not drop; no_claim = the API monitoring
// the tracks (api/tests/test_inbox_track_alerts_walk.py).
test("Review in the Inbox opens Still valid… in the Plan; marking it still valid takes it out of the Inbox", async ({ page }) => {
  await withStale(page);
  await openInbox(page);
  await expect(trackLabel(page)).toHaveText("Usage alerts PRD · At risk · 2 need you");
  const row = alertRows(page).filter({ hasText: STALE });
  await expect(row.getByTestId("track-alert-detail")).toHaveText(REASON);
  await row.getByRole("link", { name: `Review ${STALE}` }).click();
  await expect(page).toHaveURL(/\/plan\?item=team-budgets&review=1$/);

  const card = staleCard(page);
  await expect(card.getByTestId("plan-alert-detail")).toHaveText(REASON);
  await card.getByLabel("Why it is still valid").fill("Budgets per team still hold after the rewrite");
  await card.getByRole("button", { name: "Mark still valid" }).click();
  await expect(staleCard(page)).toHaveCount(0);

  await openInbox(page);
  await expect(trackLabel(page)).toHaveText("Usage alerts PRD · At risk · 1 need you");
  await expect(alertRows(page).filter({ hasText: STALE })).toHaveCount(0);
});

// protects = the Plan item panel's Review opens Still valid… instead of marking the item under
// review and showing nothing (a second click read "nothing to review: under_review"); Cancel
// closes it with nothing changed; fails_when = Review calls the API at once, shows an error or
// opens no reason field; no_claim = the refusal words (the API test).
test("the Plan item panel's Review opens Still valid…, and Cancel closes it with nothing changed", async ({ page }) => {
  await withStale(page);
  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await page.locator('[data-testid="plan-row"][data-item="team-budgets"]').filter({ visible: true }).getByTestId("plan-title").click();
  const card = staleCard(page);
  await expect(card.getByTestId("plan-alert-detail")).toHaveText(REASON);
  await expect(card.getByLabel("Why it is still valid")).toHaveCount(0);

  await card.getByRole("button", { name: "Review" }).click();
  await expect(card.getByLabel("Why it is still valid")).toBeVisible();
  await expect(card.getByRole("button", { name: "Mark still valid" })).toBeDisabled();
  await expect(card).not.toContainText("nothing to");

  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByLabel("Why it is still valid")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Review" })).toBeVisible();
  await expect(card.getByTestId("plan-alert-detail")).toHaveText(REASON);
});

// protects = a roadmap item's Depends on names a dependency its version has no row for, never by
// its key; fails_when = the Items tab shows "team-budgets"; no_claim = how the API finds the name
// (another version's item, another roadmap's, a Ground Truth feature: the API test).
test("a roadmap item names a dependency outside its version, never its key", async ({ page }) => {
  await withStale(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1/items");
  await page.getByTestId("roadmap-item-row").filter({ visible: true }).first().click();
  const depends = page.getByTestId("item-depends").filter({ visible: true });
  await expect(depends).toContainText(STALE);
  await expect(depends).not.toContainText("team-budgets");
});

// protects = a stale alert whose PRD section was removed says so in the words the rest of the
// Inbox uses for a removed section ("removed"), in the Inbox row and on the Plan's card;
// fails_when = it reads "PRD section Behaviour is gone in version 2"; no_claim = how the API
// words a stored reason (api/tests/test_roadmap_item_staleness.py).
test("a stale alert on a removed PRD section reads 'removed' in the Inbox and the Plan", async ({ page }) => {
  const removed = "PRD section Behaviour removed in version 2";
  await page.addInitScript((key) => localStorage.setItem(key, "track-alerts-stale-removed"), MOCK_SCENARIO_KEY);
  await login(page);
  await openInbox(page);
  const row = alertRows(page).filter({ hasText: STALE });
  await expect(row.getByTestId("track-alert-detail")).toHaveText(removed);
  await expect(row).not.toContainText("is gone");
  await row.getByRole("link", { name: `Review ${STALE}` }).click();
  await expect(page).toHaveURL(/\/plan\?item=team-budgets&review=1$/);
  await expect(staleCard(page).getByTestId("plan-alert-detail")).toHaveText(removed);
});
