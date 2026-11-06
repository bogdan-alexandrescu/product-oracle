import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";

/*
 * F-30 (visual QA, mock-backed, through the UI): the sentences that explain a part sit behind its
 * title's (i), not on the page; at most one short state line stays. Simple's Welcome, Simple's
 * empty "Waiting for you" card, Detailed Home's empty Needs you, Settings › Company (Horizons,
 * Time zone, Team capacity), Build the baseline and a brief that is not here. At 390 px wide no
 * page scrolls sideways.
 * fails_when: a sentence still shows on the page, or its (i) does not show it.
 * no_claim: the wording (the owner's call), the real API.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** A new company (the "empty" scenario), with the mock's store reset once at the start. */
async function newCompany(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("pass-f-explanations")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("pass-f-explanations", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "empty"] as const,
  );
}

/** `text` is not on the page in `scope` until the (i) named "About <label>" is clicked; then it shows. */
async function behindTip(scope: Locator, label: string, text: string) {
  await expect(scope.getByText(text, { exact: false }).filter({ visible: true })).toHaveCount(0);
  const tip = scope.getByRole("button", { name: `About ${label}` });
  await tip.click();
  await expect(scope.getByRole("tooltip").filter({ hasText: text })).toBeVisible();
  // Unpinned again (Escape would close Build the baseline's dialog too).
  await tip.click();
}

/** At 390 px wide the page does not scroll sideways. */
async function fitsPhone(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/** The Detailed rail's Mode switch: Simple, landing on Simple's Home. */
async function toSimple(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
}

const simple = (page: Page) => page.getByTestId("simple-page");

test("Simple's Welcome: how setup works is in the title's (i)", async ({ page }) => {
  await newCompany(page);
  await login(page, ADMIN.email);
  await toSimple(page);
  const card = simple(page).getByTestId("home-setup");
  await expect(card.getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
  await behindTip(card, "setting up Oracle", "A few steps make Oracle yours: connect your tools, pick the sources it reads, then build the baseline it plans from. Each step opens where it is done.");
  await fitsPhone(page);
});

test("Simple's empty card says Nothing waiting, the rest in its (i)", async ({ page }) => {
  await newCompany(page);
  await login(page, ADMIN.email);
  await toSimple(page);
  const card = simple(page).getByTestId("home-nothing-waits");
  await expect(card).toContainText("Nothing waiting");
  await expect(card.getByText("Nothing waits on you", { exact: false })).toHaveCount(0);
  await behindTip(card, "what waits for you", "Decisions and proposals on your items show here when they come.");
  await expect(card.getByRole("link", { name: "Open the roadmap" })).toBeVisible();
  await fitsPhone(page);
});

test("Detailed Home: what Needs you holds is in its (i)", async ({ page }) => {
  await newCompany(page);
  await login(page, ADMIN.email);
  const empty = page.getByTestId("home-needs-empty");
  await expect(empty).toContainText("Nothing waiting");
  await behindTip(empty, "what needs you", "Approvals, reviews and the questions asked of you show here.");
  await fitsPhone(page);
});

test("Settings › Company: Horizons, Time zone and Team capacity explain in their (i)s", async ({ page }) => {
  await newCompany(page);
  await login(page, ADMIN.email);
  await page.goto("/settings/company");
  await expect(page.getByRole("heading", { level: 1, name: "Company" })).toBeAttached();
  await behindTip(page.locator("#horizons"), "horizons", "Save keeps the default horizons.");
  await behindTip(page.getByTestId("timezone-panel"), "time zone", "Pick a time zone to save it.");
  await behindTip(page.getByTestId("team-capacity-panel"), "team capacity", "One team builds every PRD's items, in order. Dates on the roadmap follow its size and focus.");
  await fitsPhone(page);
});

test("Build the baseline: what it does is in the title's (i)", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.getByTestId("nav-baseline").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/baseline/);
  await page.getByRole("button", { name: "Build baseline" }).click();
  const sheet = page.getByRole("dialog", { name: "Build the baseline" });
  await expect(sheet).toBeVisible();
  await behindTip(sheet, "building the baseline", "Oracle reads your connected sources and proposes goals, products, features, constraints and evidence. Nothing is confirmed until you review it.");
  await fitsPhone(page);
});

test("A brief that is not here: why is in the title's (i)", async ({ page }) => {
  await login(page, ADMIN.email);
  await page.goto("/intakes/c5000000-0000-4000-8000-0000000000ff");
  await expect(page.getByRole("heading", { level: 1, name: /This brief is not here/ })).toBeAttached();
  await behindTip(page.locator("body"), "a brief that is not here", "It may have been drafted into a PRD, archived, or deleted. A drafted brief lives on as its PRD; a deleted one waits in Trash for a while.");
  await expect(page.getByTestId("intake-gone").getByRole("link", { name: "Back to PRDs" })).toBeVisible();
  await fitsPhone(page);
});
