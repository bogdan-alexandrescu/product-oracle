import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";

import { login, openSeeded, seedRoadmapReview } from "./helpers";

/*
 * ask-page-context (owner, Nov 3): on a run's Roadmap items review, Ask Oracle's "This page" was
 * titled "Runs" and Oracle had none of the page's items. It now names the page (the run's flow
 * and the stop) and sends what the page lists, so a question about "these items" is answered
 * with them. protects=the header names the review and the reply names an item listed on it,
 * desktop and phone; fails_when=the chat is about "Runs" or the reply has none of the items;
 * no_claim=Oracle's wording (the mock answers from what the page sent).
 */

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;
const NAME = "Roadmap from an approved PRD · Roadmap items";
const QUESTION = "Can we add a due date for any of these items?";

async function open(page: Page) {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeAttached();
  await expect(page.locator('[data-testid="roadmap-item-row"]').filter({ visible: true }).first()).toBeVisible();
}

async function askThisPage(panel: ReturnType<Page["getByTestId"]>) {
  await expect(panel.getByRole("button", { name: "This page" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("hop-about")).toHaveText(`New chat about ${NAME}`);
  await panel.getByRole("textbox", { name: "Ask Oracle" }).fill(QUESTION);
  await panel.getByRole("button", { name: "Send" }).click();
  const thread = panel.getByTestId("discussion-thread");
  await expect(thread).toContainText(NAME);
  await expect(thread).not.toContainText(/\bRuns\b/);
  await expect(thread).toContainText("Slack alerts", { timeout: 15_000 });
  await expect(thread).toContainText("Anomaly detection");
}

test("desktop: This page on a run's review names the stop and answers with its items", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 820 });
  await open(page);
  await page.getByTestId("hop-strip").click();
  await askThisPage(page.getByTestId("hop-panel").filter({ visible: true }));
});

test("phone: This page on a run's review names the stop and answers with its items", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByTestId("phone-ask").click();
  const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
  await expect(sheet).toBeVisible();
  await askThisPage(sheet);
});
