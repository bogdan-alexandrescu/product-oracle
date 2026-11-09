import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * walk-brief: New PRD and its brief, as the end-to-end walk on production found them.
 * Each test runs on a desktop and on a phone.
 *
 * Test cards (protects / fails_when / no_claim):
 * - item 2: protects=the New PRD form shows at once with its fields disabled while the role
 *   is read, says so, and keeps what is typed once it is ready; fails_when=a blank
 *   "Loading…" stands in for the form; no_claim=how long the API takes.
 * - item 2 (review minors): protects=the account button is blank, never "?", while GET
 *   /v1/me answers, then shows the member's initials; fails_when=a "?" shows meanwhile;
 *   no_claim=how long /v1/me takes.
 * - items 3 and 4: protects=the brief's side panel lists the goals the owner ticked, shows
 *   Oracle's other goals apart as suggestions with why, and names the theme ("Clean
 *   document"); fails_when=an unticked goal reads as picked, or the theme's key shows;
 *   no_claim=how Oracle matches goals to a brief (api tests/test_intake.py).
 * - item 5: protects=a new brief never shows the brief before it (its title, counts or
 *   critical questions) while its own load; fails_when=the previous brief's panel stays up
 *   under the new brief's address (over 500 ms in the @timing test, run alone; over 1500 ms in
 *   its coarse copy, run in the parallel shards); no_claim=how long the summary takes.
 * - item 7: protects=a drafted brief's open questions in the Inbox say the PRD's stage, not
 *   "Before drafting"; fails_when=the old label stays; no_claim=the API's own labels
 *   (api tests/test_questions_people.py).
 */

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const;

const PROBLEM = "Shoppers cannot buy gift cards for friends; a gift card option would grow paid conversion with new buyers.";

/** The brief's side panel: in the right column, or the sheet behind "Show details" on a phone. */
async function sidePanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("intake-inspector").filter({ visible: true });
  if ((page.viewportSize()?.width ?? 1440) <= 600 && !(await panel.count())) {
    await page.getByRole("button", { name: "Show details" }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function writeBrief(page: Page, title: string) {
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
}

async function openNewPrd(page: Page) {
  await page.getByTestId("nav-prds").or(page.getByTestId("tab-prds")).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
}

/**
 * Opens a brief, then a new one whose reads take 2 s; how long, in ms, the previous brief's
 * title or panel showed under the new brief's address.
 */
async function oldBriefShownFor(page: Page): Promise<number> {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "before-drafting"));
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeVisible();
  await expect(page.getByText("3 open · 2 answered").or(page.getByTestId("stat-open").filter({ visible: true })).first()).toBeVisible();

  // Watch each painted frame for what a person sees while the address is the new brief's:
  // the old brief may last while the router switches pages, never while the new
  // brief's own reads are under way (it stood for seconds on production).
  await page.evaluate(
    ({ oldId, oldTitle }) => {
      const w = window as unknown as { __seen: number[] };
      w.__seen = [];
      const look = () => {
        if (location.pathname.startsWith("/intakes/") && !location.pathname.endsWith(oldId)) {
          const h1 = document.querySelector("h1")?.textContent ?? "";
          const panel = [...document.querySelectorAll('[data-testid="intake-inspector"], [data-testid="intake-readiness-counts"]')].map((e) => e.textContent ?? "").join(" ");
          if (h1.includes(oldTitle) || panel.includes("Blockers: not known yet") || panel.includes("3 open · 2 answered")) w.__seen.push(performance.now());
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    },
    { oldId: BEFORE_DRAFTING.intakeId, oldTitle: BEFORE_DRAFTING.title },
  );
  await openNewPrd(page);
  await writeBrief(page, "Example gift cards");
  // The new brief's reads take 2 s, as production's took seconds.
  await page.evaluate(() => {
    localStorage.setItem("po-mock-slow", "/v1/intakes/*");
    localStorage.setItem("po-mock-slow-ms", "2000");
  });
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Example gift cards" })).toBeVisible({ timeout: 10_000 });
  const panel = await sidePanel(page);
  await expect(panel.getByTestId("stat-open")).toHaveText(/^Open\s*5$/);
  const seen = await page.evaluate(() => (window as unknown as { __seen: number[] }).__seen);
  return seen.length ? seen[seen.length - 1] - seen[0] : 0;
}

for (const [name, viewport] of VIEWPORTS) {
  test.describe(name, () => {
    test.use({ viewport });

    test(`2: the New PRD form shows at once, disabled until it is ready, and keeps what is typed (${name})`, async ({ page }) => {
      await login(page);
      await page.evaluate(() => {
        localStorage.setItem("po-mock-slow", "/v1/me/capabilities");
        localStorage.setItem("po-mock-slow-ms", "3000");
      });
      await page.goto("/documents/new?kind=prd");
      const title = page.getByRole("textbox", { name: "Title" });
      await expect(title).toBeVisible();
      await expect(title).toBeDisabled();
      await expect(page.getByTestId("new-prd-getting-ready").filter({ visible: true })).toHaveText("Getting the form ready…");
      await expect(page.getByRole("button", { name: "Continue" }).first()).toBeDisabled();

      await expect(title).toBeEnabled({ timeout: 10_000 });
      await expect(page.getByTestId("new-prd-getting-ready").filter({ visible: true })).toHaveCount(0);
      await writeBrief(page, "Example gift cards");
      await expect(title).toHaveValue("Example gift cards");
      await expect(page.getByRole("textbox", { name: "What problem does it solve?" })).toHaveValue(PROBLEM);
    });

    test(`2: the account button never shows a "?" while the signed-in member loads (${name})`, async ({ page }) => {
      await login(page);
      await page.evaluate(() => {
        localStorage.setItem("po-mock-slow", "/v1/me");
        localStorage.setItem("po-mock-slow-ms", "3000");
      });
      await page.goto("/documents/new?kind=prd");
      const avatar = page.getByTestId(name === "phone" ? "phone-user-menu" : "user-menu");
      await expect(avatar).toBeVisible();
      // Read once (a retried assertion would pass when /v1/me answers).
      expect(await avatar.textContent()).not.toContain("?");
      // Once the member is read, it shows their initials (admin@example.com).
      await expect(avatar).toContainText("AD", { timeout: 10_000 });
    });

    test(`3-4: the side panel shows the picked goal, Oracle's other goal as a suggestion, and the theme's name (${name})`, async ({ page }) => {
      await login(page);
      await openNewPrd(page);
      await writeBrief(page, "Example gift cards");
      await page.getByRole("group", { name: "Which goals does it serve?" }).getByRole("checkbox", { name: /Raise activation/ }).check();
      await page.getByRole("button", { name: "Continue" }).first().click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
      await expect(page.getByRole("heading", { level: 1, name: "Example gift cards" })).toBeVisible();

      const panel = await sidePanel(page);
      const goals = panel.getByTestId("intake-goals");
      await expect(goals.getByTestId("intake-goals-picked")).toContainText("Raise activation");
      await expect(goals.getByTestId("intake-goals-picked")).not.toContainText("Grow paid conversion");
      const suggested = goals.getByTestId("intake-goals-suggested");
      await expect(suggested).toContainText("Oracle suggests");
      await expect(suggested).toContainText("Grow paid conversion");
      await expect(suggested).toContainText("The brief speaks to it");

      const template = panel.getByTestId("intake-template");
      await expect(template).toContainText("Goal-traced PRD");
      await expect(template.getByTestId("intake-theme")).toHaveText("Clean document");
      await expect(template).not.toContainText("clean-document");
    });

    test(`5: a new brief never shows the previous brief's panel while its own loads (${name}) @timing`, async ({ page }) => {
      expect(await oldBriefShownFor(page)).toBeLessThan(500);
    });

    // The same guard, coarse, in the parallel shards: a large regression fails there too.
    test(`5: a new brief never shows the previous brief's panel for long (${name})`, async ({ page }) => {
      // timing-check: coarse (under load; the tight bound is the @timing test above)
      expect(await oldBriefShownFor(page)).toBeLessThan(1500);
    });

    test(`7: a drafted brief's open questions in the Inbox say the PRD's stage (${name})`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "late-answers"));
      await login(page);
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      const rows = page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("[data-row]").filter({ visible: true });
      await expect(rows.filter({ hasText: "Checkout redesign" }).first()).toBeVisible();
      await expect(rows.filter({ hasText: /PRD (drafted|in review|approved) · Checkout redesign/ }).first()).toBeVisible();
      await expect(rows.filter({ hasText: `Before drafting · ${BEFORE_DRAFTING.title}` })).toHaveCount(0);
    });
  });
}
