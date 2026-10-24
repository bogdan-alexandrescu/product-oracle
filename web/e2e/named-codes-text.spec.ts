import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, section } from "./helpers";

/*
 * Named codes in agent-written text (#305), through the UI on the mock layer. The
 * "named-codes" scenario adds trip-planner, a PRD whose Summary uses bare codes (F-28,
 * F-30a, R1–R3, M2, G-B) and one code it never defines (F-99).
 * protects = each known code in a PRD section is underlined with the shared card behind it
 * (hover, Tab, tap), and Go to section opens the section that names it;
 * fails_when = a known code is drawn plain, an unknown one or one in a URL or code span is
 * underlined, or the card does not open; no_claim = proposals and checkpoint notes.
 * Inbox (owner decision 2026-10-23): the row stays one link with its codes plain; the row's
 * expanded detail shows Oracle's text with each known code carrying the card.
 */

const withCodes = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "named-codes"), MOCK_SCENARIO_KEY);

async function summary(page: Page) {
  await withCodes(page);
  await login(page);
  await page.goto("/documents/trip-planner/v/1");
  return openSection(page, "summary");
}

test("a PRD section's known codes are underlined; unknown codes, URLs and code spans are not", async ({ page }) => {
  const s = await summary(page);
  const codes = s.getByTestId("named-code");
  await expect(codes).toHaveText(["F-28", "F-30a", "F-30", "G-B", "R1–R3", "M2"]);
  expect(await codes.first().evaluate((el) => getComputedStyle(el).textDecorationStyle)).toBe("dotted");
  await expect(s).toContainText("F-99 waits");
  await expect(s).toContainText("https://example.com/specs/F-28");
  await expect(s.locator("code")).toHaveText("F-28");
});

test("hover and Tab open the card; a range lists its members; Go to section opens the section", async ({ page }) => {
  const s = await summary(page);
  const card = page.getByTestId("code-card");

  await s.getByTestId("named-code").filter({ hasText: "F-28" }).hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Feature · this PRD");
  await expect(card.getByTestId("code-tag")).toHaveText("F-28");
  await expect(card.getByTestId("card-name")).toHaveText("Shared trip notes");
  await expect(card.getByRole("link", { name: "Go to section" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Tab from the section heading to the range. Tab on an open card goes into it (#304), so
  // a keyboard user leaves each earlier card with Escape and tabs on.
  await page.mouse.move(0, 0);
  const range = s.getByTestId("named-code").filter({ hasText: "R1–R3" });
  await s.getByRole("heading", { name: "Summary" }).click();
  for (let i = 0; i < 60 && !(await range.evaluate((el) => el === document.activeElement)); i++) {
    if (await card.count()) await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
  }
  await expect(range).toBeFocused();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Requirement · this PRD");
  await expect(card.getByTestId("card-members")).toContainText("R1 Notes save offline");
  await expect(card.getByTestId("card-members").getByRole("listitem")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // A goal opens on the Baseline.
  await s.getByTestId("named-code").filter({ hasText: "G-B" }).click();
  await expect(card).toContainText("Goal");
  await expect(card.getByTestId("card-name")).toHaveText("Growth");
  await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", /^\/baseline\?entity=/);
  await page.keyboard.press("Escape");

  await s.getByTestId("named-code").filter({ hasText: "F-28" }).click();
  await card.getByRole("link", { name: "Go to section" }).click();
  await expect(page).toHaveURL(/#f-28$/);
  const target = section(page, "f-28");
  await expect(target).toBeInViewport();
  await expect(target).toContainText("Shared trip notes");
});

test("an Inbox row stays one plain link; its expanded detail names the codes in Oracle's text", async ({ page }) => {
  await withCodes(page);
  await login(page);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Saved addresses" });
  await expect(row.getByRole("link", { name: /within G-B/ })).toBeVisible();
  await expect(row.getByTestId("named-code")).toHaveCount(0);

  const more = row.getByRole("button", { name: "Show the text" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const quote = page.getByTestId("need-quote");
  await expect(quote).toHaveText("Moved 'Saved addresses' up 2 within G-B, ahead of G-Z");
  // G-B is a company goal; G-Z is not known and stays plain.
  await expect(quote.getByTestId("named-code")).toHaveText(["G-B"]);

  await quote.getByTestId("named-code").hover();
  const card = page.getByTestId("code-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("card-name")).toHaveText("Growth");
  await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", /^\/baseline\?entity=/);
  await page.keyboard.press("Escape");

  await more.click();
  await expect(quote).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("tapping a slice opens its card as a bottom sheet with its parent's name", async ({ page }) => {
    const s = await summary(page);
    await s.getByTestId("named-code").filter({ hasText: "F-30a" }).tap();
    const card = page.getByTestId("code-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-sheet", "true");
    await expect(card.getByTestId("card-name")).toHaveText("Packing lists");
    await expect(card.getByTestId("card-line")).toHaveText("Feature F-30, slice a");
    await expect(card.getByRole("link", { name: "Go to section" })).toBeVisible();
  });
});
