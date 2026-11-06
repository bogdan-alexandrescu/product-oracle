import { expect, test, type Page } from "./test";

import { MOCK_FAIL_ONCE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA pass F, Company › Strategy (F-12, F-13, F-41 to F-46): the drift list and the
 * stack's details on a phone, the cards while the stack loads or fails, names instead of
 * slugs, counts that lead to their rows, and explanations behind an (i). The "strategy"
 * scenario: an approved vision and product strategy, four open drift findings (Retention and
 * Dark mode not under the strategy, two report items still planned) and one waived finding
 * (Team plans has no goal). Each test's card: protects; fails_when; no_claim.
 */

const withStrategy = (page: Page, scenario = "strategy") =>
  page.addInitScript((s) => localStorage.setItem(s[0], s[1]), [MOCK_SCENARIO_KEY, scenario] as const);
const strategyPage = (page: Page) => page.getByTestId("strategy-page").filter({ visible: true });
const wide = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// protects=F-12: on a phone a drift row gives the subject its own full line; fails_when=the
// name is squeezed into a thin column ("Retenti / on") or the page scrolls sideways;
// no_claim=other phone widths.
test("pass F: phone, a drift row puts the subject's name on its own line", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const row = strategyPage(page).getByTestId("drift-list").getByTestId("finding-row").filter({ hasText: "Retention" });
  const subject = row.getByTestId("finding-subject");
  await expect(subject).toHaveText("Retention");
  const box = await subject.boundingBox();
  expect(box!.width).toBeGreaterThan(250);
  expect(box!.height).toBeLessThan(30);
  expect(await wide(page)).toBeLessThanOrEqual(0);
});

// protects=F-13: when the stack fails, the cards say so with Try again (not "not approved")
// and no finding prints its raw reference; Try again brings the vision back;
// fails_when=the cards claim nothing is approved, the stack stays grey, or "retention" shows;
// no_claim=a slow stack (the skeleton).
test("pass F: a failed stack says it could not load, and Try again brings the vision back", async ({ page }) => {
  await withStrategy(page);
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("po-failed")) {
      sessionStorage.setItem("po-failed", "1");
      localStorage.setItem(key, "GET /v1/strategy/stack");
    }
  }, MOCK_FAIL_ONCE_KEY);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  const vision = root.getByTestId("vision-card");
  await expect(vision).toContainText("Could not load the strategy");
  await expect(root.getByTestId("strategy-card")).toContainText("Could not load the strategy");
  await expect(root).not.toContainText("not approved yet");
  await expect(root.getByTestId("drift-list").getByTestId("finding-row").first()).toBeVisible();
  await expect(root.getByTestId("drift-list")).not.toContainText(/\bretention\b/);
  await vision.getByRole("button", { name: "Try again" }).click();
  await expect(vision).toContainText("Every small team plans its product like a large one.");
  await expect(root.getByTestId("drift-list").getByTestId("finding-row").filter({ hasText: "Retention" })).toHaveCount(1);
});

// protects=F-41: a waived finding names the focus choice ("Team plans"), never its slug;
// fails_when="product-strategy-team-plans" shows; no_claim=reopening a waived finding (asked of the owner).
test("pass F: a waived finding names the focus choice, not its slug", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const drift = strategyPage(page).getByTestId("drift-list");
  await drift.getByTestId("finding-state").getByRole("button", { name: /Waived/ }).click();
  const row = drift.getByTestId("finding-row").filter({ hasText: "Focus without a goal" });
  await expect(row.getByTestId("finding-subject")).toHaveText("Team plans");
  await expect(drift).not.toContainText("product-strategy-team-plans");
});

// protects=F-42: the Product strategy card's counts and goal pills open their stack line, and
// a focus choice with no goal offers Add a goal; fails_when=they are plain text; no_claim=the
// goal form itself.
test("pass F: the strategy card's counts open the stack line, and a goalless focus offers Add a goal", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  const card = root.getByTestId("strategy-card");
  const team = card.getByTestId("focus-row").filter({ hasText: "Team plans" });
  await team.getByRole("button", { name: "1 item" }).click();
  await expect(root.getByTestId("stack-inspector")).toContainText("Team plans");
  const self = card.getByTestId("focus-row").filter({ hasText: "Self-serve onboarding" });
  await self.getByRole("button", { name: /Grow paid conversion/ }).click();
  await expect(root.getByTestId("stack-inspector").getByRole("heading").first()).toContainText("Grow paid conversion");
  await expect(team.getByRole("link", { name: "Add a goal" })).toBeVisible();
  await expect(card.getByTestId("stop-row").getByRole("link", { name: "2 items still planned" })).toHaveAttribute("href", "/plan");
});

// protects=F-43 and F-46: the stack details let the vision line wrap and give a finding's
// subject its own line, and a drift row's link says what it opens; fails_when=the vision is
// cut with an ellipsis, the subject wraps mid-word, or the link reads only "Open";
// no_claim=the pages those links open.
test("pass F: the stack details wrap the vision, and drift links name what they open", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  await root.getByTestId("strategy-stack").getByTestId("stack-row").filter({ hasText: "Retention" }).click();
  const inspector = root.getByTestId("stack-inspector");
  const vision = inspector.getByTestId("chain-vision");
  await expect(vision).toHaveText(/Every small team plans its product like a large one\./);
  expect(await vision.evaluate((e) => e.scrollWidth <= e.clientWidth && getComputedStyle(e).textOverflow !== "ellipsis")).toBe(true);
  const subject = inspector.getByTestId("finding-subject");
  await expect(subject).toHaveText("Retention");
  expect((await subject.boundingBox())!.height).toBeLessThan(30);
  const drift = root.getByTestId("drift-list");
  await expect(drift.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
  await expect(drift.getByTestId("finding-row").filter({ hasText: "Retention" }).getByRole("link", { name: "Open goal" })).toBeVisible();
  await expect(drift.getByTestId("finding-row").filter({ hasText: "Dark mode" }).getByRole("link", { name: "Open item" })).toBeVisible();
});

// protects=F-44: on a phone a tapped stack row opens its details in a sheet, and the rows not
// under the strategy name their cells instead of bare dashes; fails_when=nothing visible happens
// or "—" marks show; no_claim=the desktop inspector.
test("pass F: phone, a tapped stack row opens its details in a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  const retention = root.getByTestId("strategy-stack").getByTestId("stack-row").filter({ hasText: "Retention" });
  await expect(retention).toContainText("Goal");
  await expect(retention).not.toContainText("—");
  await retention.click();
  const sheet = page.getByTestId("stack-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("stack-inspector")).toBeInViewport();
  await expect(sheet.getByTestId("stack-inspector")).toContainText("Not under the strategy");
  expect(await wide(page)).toBeLessThanOrEqual(0);
});

// protects=F-45: an empty card and the empty drift list keep one short line, the rest behind
// an (i); fails_when=the explanation sentences sit on the page; no_claim=the (i) wording.
test("pass F: with no strategy, the empty states keep one short line each", async ({ page }) => {
  await withStrategy(page, "strategy-none");
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  await expect(root.getByTestId("vision-empty")).toBeVisible();
  await expect(root.getByTestId("vision-empty")).not.toContainText("Where the company is headed");
  await expect(root.getByTestId("strategy-empty")).not.toContainText("each goal should follow from a focus choice");
  await expect(root.getByTestId("stack-empty")).not.toContainText("under the focus choice each follows from");
  await root.getByTestId("drift-list").getByTestId("finding-state").getByRole("button", { name: /Resolved/ }).click();
  await expect(root.getByTestId("drift-empty")).not.toContainText("because the goal or item now lines up");
  await expect(root.getByTestId("drift-empty").getByRole("button", { name: /About/ })).toBeVisible();
});
