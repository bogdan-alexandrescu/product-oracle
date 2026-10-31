import { expect, type Page, test } from "./test";

import { login } from "./helpers";

/**
 * F5-1 tech briefs on the mock layer: the PRD's Tech briefs panel lists one brief per
 * feature and opens the read-only brief page. The fake runtime stands in for the
 * architect (the mock seeds what an approved Engineering check registered); no model is
 * called.
 */

async function openBrief(page: Page, title: string) {
  await page.goto("/documents/checkout-redesign");
  const panel = page.getByTestId("tech-briefs");
  await expect(panel).toBeVisible();
  await panel.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

test("a brief shows its approach, touches with code map refs, risks, answered questions, size and verdict", async ({ page }) => {
  // protects=AC12 the brief page's content; fails_when=a part of the brief is missing or
  // a ref loses its touch; no_claim=what the brief says is true of the code.
  await login(page, "viewer@example.com");
  await openBrief(page, "Show the full price early");

  await expect(page.getByTestId("brief-approach")).toContainText("Compute the total in the pricing module");
  await expect(page.getByTestId("brief-code-map")).toContainText("example/shop-app");

  const touches = page.getByRole("table", { name: "What it touches" });
  const pricing = touches.getByRole("row", { name: /web\/checkout\/summary/ });
  await expect(pricing).toContainText("Changes an existing module"); // qa4-docs-share-46
  await expect(pricing).toContainText("Checkout web");
  await expect(touches.getByRole("row", { name: /GET \/v1\/quotes/ })).toContainText("Adds a new API");

  await expect(page.getByTestId("brief-risks")).toContainText("Tax rules differ by region");
  await expect(page.getByTestId("brief-risks")).toContainText("High");

  const question = page.getByTestId("brief-question-q1");
  await expect(question).toContainText("Can quotes be cached for ten minutes?");
  // qa4-docs-53: answered, it no longer blocks.
  await expect(question).toContainText("Was blocking · answered");
  await expect(question).toContainText("Yes, prices change at most hourly");

  await expect(page.getByTestId("brief-size")).toContainText("M");
  await expect(page.getByTestId("brief-size")).toContainText("about 2 person-weeks");
  await expect(page.getByTestId("brief-verdict")).toContainText("Feasible with changes");
  await expect(page.getByTestId("brief-verdict")).toContainText("Cache quotes per cart");
  await expect(page.getByTestId("brief-freshness")).toContainText("Fresh");
});

test("a brief written without a code map says so and lists its assumptions", async ({ page }) => {
  // protects=AC12 the no-map label; fails_when=a brief resting on assumptions reads as
  // resting on the code.
  await login(page);
  await openBrief(page, "Keep form state on back navigation");
  const map = page.getByTestId("brief-code-map");
  await expect(map).toContainText("No code map: assumptions");
  await expect(map).toContainText("The checkout form keeps its state in the page");
  await expect(page.getByTestId("brief-freshness")).toContainText("Potentially stale");
  await expect(page.getByTestId("brief-freshness")).toContainText("Requirement changed");
  await expect(page.getByTestId("brief-verdict")).toContainText("Approved at the Engineering check");
});

test("an unknown brief says it was not found", async ({ page }) => {
  // protects=the 404 path; fails_when=the page hangs or shows an empty brief.
  await login(page);
  await page.goto("/briefs/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Tech brief not found")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the brief page fits without horizontal scroll", async ({ page }) => {
    // protects=AC15 for the brief page; fails_when=the touches table or a long ref
    // widens the page past 390 px.
    await login(page);
    await openBrief(page, "Show the full price early");
    await expect(page.getByTestId("brief-approach")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("the PRD's Tech briefs panel shows a load error instead of hiding", async ({ page }) => {
  // protects=the panel's error path; fails_when=a failed load reads as a PRD without
  // briefs (the panel disappears).
  await page.addInitScript(() => localStorage.setItem("po-mock-fail", "/v1/tech-briefs"));
  await login(page);
  await page.goto("/documents/checkout-redesign");
  const panel = page.getByTestId("tech-briefs");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("Mock failure");
});
