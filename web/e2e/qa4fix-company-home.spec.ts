import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * QA pass 4 on Home (Detailed), company lane: a checkpoint line puts " · " between its step
 * and its document (qa4-company-45); a section question names the section without its outline
 * number (-46); an answered question leaves Needs you with its count (-47); on a narrow phone
 * the counts sit together on a line under the title (-50); the selected PRD's Not reviewed
 * legend is a filled swatch, not a checkbox (-52); its open feedback says it is yours (-53).
 *
 * no_claim for every test here: the in-browser mock's lists stand in for the API.
 */

const CLINIC = "Which clinics join the waitlist first?";
const TIERS = "Which plan tiers get hard caps?";

async function openHome(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
}

/** The mock's "questions" company: the default one plus questions asked of the signed-in member. */
async function useQuestions(page: Page) {
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, "questions");
  }, MOCK_SCENARIO_KEY);
}

const lines = (page: Page) => page.getByTestId("home-needs-table").locator("tr[data-row]");

async function answer(page: Page, prompt: string, text: string) {
  await lines(page).filter({ hasText: prompt }).getByRole("button", { name: "Answer" }).click();
  const form = page.getByTestId("answer-question");
  await form.getByLabel("Your answer").fill(text);
  await form.getByRole("button", { name: "Send answer" }).click();
}

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-company-45: a checkpoint line reads 'Baseline proposal · Team onboarding'", async ({ page }) => {
    await openHome(page);
    const row = lines(page).filter({ hasText: "Baseline proposal" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Baseline proposal · Team onboarding");
    await expect(row).not.toContainText(/Baseline proposal\s*Team onboarding/);
  });

  test("qa4-company-46: a section question names the section without its outline number", async ({ page }) => {
    await useQuestions(page);
    await openHome(page);
    await expect(lines(page).filter({ hasText: CLINIC })).toBeVisible();
    // Answering the first question brings the next one, asked on a PRD section, into Needs you.
    await answer(page, CLINIC, "The two downtown clinics.");
    const tiers = lines(page).filter({ hasText: TIERS });
    await expect(tiers).toBeVisible();
    await expect(tiers).toContainText(/ · Success metrics/);
    await expect(tiers).not.toContainText(/· \d+(\.\d+)*\.? Success metrics/);
  });

  test("qa4-company-47: an answered question leaves Needs you as its count drops", async ({ page }) => {
    await useQuestions(page);
    await openHome(page);
    const needs = page.getByTestId("home-needs");
    const row = lines(page).filter({ hasText: CLINIC });
    await expect(row).toBeVisible();
    const count = needs.getByTestId("panel-count");
    const before = Number(await count.innerText());
    expect(before).toBeGreaterThan(1);

    await answer(page, CLINIC, "The two downtown clinics.");
    // What was done is said once, above the list; the line itself is gone, as from the count.
    await expect(needs.getByTestId("inbox-acted")).toContainText(`Answered: ${CLINIC}`);
    await expect(row).toHaveCount(0);
    await expect(needs).not.toContainText("Answered ✓");
    await expect(count).toHaveText(String(before - 1));
  });

  test("qa4-company-52: the Sections legend's Not reviewed is a filled swatch, not a checkbox", async ({ page }) => {
    await openHome(page);
    const inspector = page.getByTestId("home-inspector");
    const legend = inspector.getByTestId("inspector-sections");
    await expect(legend).toContainText("Not reviewed");
    const swatch = legend.getByText("Not reviewed").locator("i");
    await expect(swatch).toHaveCount(1);
    const look = await swatch.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        shadow: cs.boxShadow,
        border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth),
        filled: cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent",
        clickable: !!el.closest("a, button, label, [role=checkbox], [role=button]"),
      };
    });
    expect(look).toEqual({ shadow: "none", border: 0, filled: true, clickable: false });
  });

  test("qa4-company-53: the selected PRD's open feedback says it is yours, for an owner and a viewer", async ({ page }) => {
    await openHome(page);
    await expect(page.getByTestId("home-inspector").getByTestId("stat-open").locator("dt")).toHaveText("Your open feedback");

    await page.getByTestId("user-menu").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await openHome(page, "viewer@example.com");
    await expect(page.getByTestId("home-inspector").getByTestId("stat-open").locator("dt")).toHaveText("Your open feedback");
  });
});

test.describe("on a 375 px phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("qa4-company-50: Needs you's counts sit together on a line under the title", async ({ page }) => {
    await openHome(page);
    const needs = page.getByTestId("home-needs");
    await expect(lines(page).first()).toBeVisible();
    const counts = needs.locator('[data-testid^="home-count-"]');
    expect(await counts.count()).toBeGreaterThan(1);
    const title = await needs.getByRole("heading", { level: 2, name: "Needs you" }).boundingBox();
    const inbox = await needs.getByTestId("home-inbox-link").boundingBox();
    const boxes = await counts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    expect(title && inbox).toBeTruthy();
    const tops = boxes.map((b) => Math.round(b.top));
    // One line for every count, none left alone beside Inbox.
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    // That line is under the title; Inbox stays on the title's line.
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(Math.round(title!.y + title!.height) - 1);
    expect(inbox!.y + inbox!.height / 2).toBeGreaterThan(title!.y - 8);
    expect(inbox!.y + inbox!.height / 2).toBeLessThan(title!.y + title!.height + 8);
    // Nothing runs off the side.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
