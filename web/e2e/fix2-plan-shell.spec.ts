import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * Fix round 2 for the Plan's shell, header, tab strip, Roadmap table, goals card and inspector
 * (qa-plan-4, -11, -12, -13, -14, -31, -33, -51, -54), driven through the UI on the mock layer
 * as a person would, on a desktop (1440x900) and a phone (390x844).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });
const strip = (page: Page) => page.getByTestId("plan-tabs").filter({ visible: true });
const links = (page: Page) => page.getByTestId("plan-links").filter({ visible: true });
const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });
const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });

async function openPlan(page: Page) {
  await login(page);
  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(rows(page).first()).toBeVisible();
}

async function box(l: Locator) {
  await expect(l).toBeVisible();
  return (await l.boundingBox())!;
}

/** The Plan's tabs, by test id, with the URL each opens. */
const TABS: [string, RegExp][] = [
  ["plan-tab-plan", /\/plan$/],
  ["plan-tab-documents", /\/plan\/documents$/],
  ["plan-tab-dates", /\/plan\/dates$/],
  ["plan-tab-outcomes", /\/plan\/outcomes$/],
  ["plan-tab-reports", /\/plan\/reports$/],
];

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-plan-11/12: every Plan tab keeps its title, strip and page-wide links in one place, with an (i)", async ({ page }) => {
    await openPlan(page);
    const h1 = page.getByRole("heading", { level: 1 });
    const first = { title: await box(h1), strip: await box(strip(page)), links: await box(links(page)) };
    for (const [id, url] of TABS) {
      await strip(page).getByTestId(id).click();
      await expect(page).toHaveURL(url);
      await expect(strip(page).getByTestId(id)).toHaveAttribute("aria-current", "page");
      // No back link above the title on any tab: the strip leads back.
      await expect(header(page).getByRole("link", { name: "Back to Plan" }), id).toHaveCount(0);
      const t = await box(h1);
      const s = await box(strip(page));
      expect(Math.abs(t.y - first.title.y), `${id}: title moved`).toBeLessThanOrEqual(1);
      expect(Math.abs(s.y - first.strip.y), `${id}: strip moved`).toBeLessThanOrEqual(1);
      // Alignment report, Launches and Changelog: the same three, in the same place.
      await expect(links(page).getByRole("link"), id).toHaveText(["Alignment report", "Launches", "Changelog"]);
      const l = await box(links(page));
      expect(Math.abs(l.x - first.links.x) + Math.abs(l.y - first.links.y), `${id}: links moved`).toBeLessThanOrEqual(2);
      // Not repeated as header buttons on some tabs only.
      await expect(header(page).getByRole("link", { name: "Alignment report" }), id).toHaveCount(1);
      await expect(header(page).getByRole("link", { name: "Launches", exact: true }), id).toHaveCount(1);
      // The (i) by the title on every tab.
      await expect(header(page).getByRole("button", { name: /^About / }), id).toHaveCount(1);
    }
  });

  test("qa-plan-11: Launches and Changelog keep the title where the Plan has it, ‹ Plan beside it", async ({ page }) => {
    await openPlan(page);
    const planTitle = await box(page.getByRole("heading", { level: 1 }));
    await links(page).getByRole("link", { name: "Launches" }).click();
    await expect(page).toHaveURL(/\/roadmap\/launches$/);
    for (const [name, url] of [
      ["Launches", /\/roadmap\/launches$/],
      ["Changelog", /\/roadmap\/changelog$/],
    ] as const) {
      if (name === "Changelog") {
        await page.getByTestId("changelog-link").click();
        await expect(page).toHaveURL(url);
      }
      const title = await box(page.getByRole("heading", { level: 1, name }));
      const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
      expect(Math.abs(mid(title) - mid(planTitle)), `${name}: title moved down`).toBeLessThanOrEqual(1);
      const crumb = header(page).getByRole("link", { name: "Back to Plan" });
      await expect(crumb).toHaveText("‹ Plan");
      const c = await box(crumb);
      expect(c.height).toBeGreaterThanOrEqual(24);
      // On the title's row, before it.
      expect(c.x + c.width).toBeLessThanOrEqual(title.x);
      expect(Math.abs(c.y + c.height / 2 - (title.y + title.height / 2))).toBeLessThanOrEqual(4);
    }
    await header(page).getByRole("link", { name: "Back to Plan" }).click();
    await expect(page).toHaveURL(/\/plan$/);
  });

  test("qa-plan-11: a baseline item's Impact leads back with ‹ Baseline on the title's row", async ({ page }) => {
    await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "impact"] as const);
    await login(page);
    await page.goto("/baseline");
    await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
    await page.getByRole("dialog", { name: "Guided setup" }).getByRole("link", { name: "What if it changed?" }).click();
    await expect(page).toHaveURL(/\/impact\/entities\/[^/]+$/);
    const back = page.getByTestId("impact-back").filter({ visible: true });
    await expect(back).toHaveText("‹ Baseline");
    const b = await box(back);
    const t = await box(page.getByRole("heading", { level: 1 }));
    expect(Math.abs(b.y + b.height / 2 - (t.y + t.height / 2))).toBeLessThanOrEqual(4);
    await back.click();
    await expect(page).toHaveURL(/\/baseline$/);
  });

  test("qa-plan-13: the issue key and its date stay together; who decides is on its own line", async ({ page }) => {
    await openPlan(page);
    const eng = row(page, "Threshold alerts on spend").getByTestId("plan-engineering");
    await expect(eng).toHaveText("ENG-402 · Nov 20 ✓");
    // One line: no "ENG-402 · Nov" then "20 ✓".
    expect((await box(eng)).height).toBeLessThanOrEqual(24);
    const next = row(page, "Daily alert digest email").getByTestId("plan-next");
    await expect(next).toHaveText("Decide on slip · owners");
    const decision = await box(next.getByText("Decide on slip", { exact: true }));
    expect(decision.height, "Decide on slip on one line").toBeLessThanOrEqual(24);
    const who = await box(next.getByText("owners"));
    expect(who.y, "owners on the line below").toBeGreaterThanOrEqual(decision.y + decision.height - 1);
    expect(Math.abs(who.x - decision.x), "owners starts the second line").toBeLessThanOrEqual(1);
    const review = row(page, "One-page checkout").getByTestId("plan-next").getByRole("link", { name: "PRD review" });
    expect((await box(review)).height).toBeLessThanOrEqual(30);
  });

  test("qa-plan-31: a dropped item has one state, Dropped in draft 2 (was Planned), its title struck", async ({ page }) => {
    await openPlan(page);
    const budgets = row(page, "Budgets per team");
    await expect(budgets.getByTestId("plan-state")).toHaveText("Dropped in draft 2 (was Planned)");
    await expect(budgets.getByText("Planned", { exact: true })).toHaveCount(0);
    await expect(budgets.getByTestId("plan-title")).toHaveCSS("text-decoration-line", "line-through");
  });

  for (const role of ["owner", "viewer"] as const) {
    test(`qa-plan-14: Cut early churn shows its target and says No current value yet (${role})`, async ({ page }) => {
      if (role === "viewer") await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
      await openPlan(page);
      const churn = page.getByTestId("plan-goals").getByTestId("home-goal-G3");
      await expect(churn).toContainText("Cut early churn");
      await expect(churn.getByTestId("goal-figure")).toContainText("8%");
      await expect(churn.getByTestId("goal-to-go")).toHaveText("No current value yet");
      await expect(churn).not.toContainText("No target");
    });
  }

  test("qa-plan-33: in the light theme the selected item's head is on the card surface, not dark navy", async ({ page }) => {
    await page.addInitScript(([key, t]) => localStorage.setItem(key, t), [THEME_KEY, "light"] as const);
    await openPlan(page);
    await row(page, "Threshold alerts on spend").getByTestId("plan-title").click();
    const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
    await expect(inspector).toContainText("Threshold alerts on spend");
    const head = inspector.locator("[data-inspector-head]");
    const [headBg, cardBg, titleColor] = await Promise.all([
      head.evaluate((e) => getComputedStyle(e).backgroundColor),
      inspector.evaluate((e) => getComputedStyle(e).backgroundColor),
      head.locator("h2").evaluate((e) => getComputedStyle(e).color),
    ]);
    expect(headBg).toBe(cardBg);
    expect(headBg).toBe("rgb(255, 255, 255)");
    // Dark text on it, as on every other card.
    expect(titleColor).toBe("rgb(13, 23, 36)");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-plan-4: all five Plan tabs are on screen, no scrolling and no arrows over them", async ({ page }) => {
    await openPlan(page);
    await expect(strip(page).getByTestId("strip-more-right")).toHaveCount(0);
    await expect(strip(page).getByTestId("strip-more-left")).toHaveCount(0);
    const boxes = [];
    for (const [id] of TABS) {
      const b = await box(strip(page).getByTestId(id));
      expect(b.x, `${id} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `${id} ends on screen`).toBeLessThanOrEqual(PHONE.width);
      boxes.push(b);
    }
    // No two tabs overlap.
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
        expect(apart, `${TABS[i][0]} and ${TABS[j][0]} overlap`).toBe(true);
      }
    // The last tab works with one tap.
    await strip(page).getByTestId("plan-tab-reports").click();
    await expect(page).toHaveURL(/\/plan\/reports$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  });

  test("qa-plan-54: a row with no engineering issue does not end in a lone dash", async ({ page }) => {
    await openPlan(page);
    const budgets = row(page, "Budgets per team");
    await expect(budgets.getByTestId("plan-title")).toBeVisible();
    await expect(budgets.getByTestId("plan-engineering")).toBeHidden();
    for (const cell of await budgets.locator("td").filter({ visible: true }).all()) {
      expect((await cell.innerText()).trim()).not.toBe("—");
    }
    // A row with an issue still shows it.
    await expect(row(page, "Threshold alerts on spend").getByTestId("plan-engineering")).toBeVisible();
  });

  test("qa-plan-51: the Plan's PRD links are at least 24 px tall", async ({ page }) => {
    await openPlan(page);
    const cards = page.getByTestId("plan-prd-card").filter({ visible: true });
    await expect(cards.first()).toBeVisible();
    for (const card of await cards.all()) {
      const link = card.locator('a[href^="/documents/"]').first();
      const b = await box(link);
      expect(b.height, `${await link.innerText()}`).toBeGreaterThanOrEqual(24);
    }
  });

  test("qa-plan-12: the page-wide links show on a phone too, under the tabs", async ({ page }) => {
    await openPlan(page);
    await expect(links(page).getByRole("link")).toHaveText(["Alignment report", "Launches", "Changelog"]);
    for (const l of await links(page).getByRole("link").all()) {
      const b = await box(l);
      expect(b.height).toBeGreaterThanOrEqual(24);
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
    }
    await links(page).getByRole("link", { name: "Changelog" }).click();
    await expect(page).toHaveURL(/\/roadmap\/changelog$/);
  });
});
