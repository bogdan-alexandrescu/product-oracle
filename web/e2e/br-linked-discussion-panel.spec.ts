import { expect, test, type Page } from "./test";

import { RUN_DISCUSSION_OPEN } from "../lib/api/mock/discussions";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * ask-phone row 12 (Nov 12 QA): a linked discussion (the Inbox's Review changes, a run agent's
 * link) opens in the right Ask panel on desktop, the one place for threads, never a page-wide
 * bottom sheet; a phone keeps the sheet. Mock layer, invented data ("discussions" and
 * "run-discussions" scenarios).
 */

const APPROVER = "approver@example.com";
const ORDER = "Order: put Guest checkout first?";
// The run the "feature-set" scenario seeds (web/lib/api/mock/runs.ts FEATURE_SET_RUN).
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";

const panel = (page: Page) => page.getByTestId("hop-drawer").getByTestId("hop-panel");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Discussion" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Inbox Review changes opens the thread in the Ask panel, on its changes; closing it clears the link", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
    await login(page, APPROVER);
    await page.goto("/inbox");
    const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-discussions").locator("tr[data-row]").filter({ hasText: `${ORDER} · 1 change proposed` });
    await row.getByRole("link", { name: "Review changes" }).click();
    await expect(page).toHaveURL(/\/priorities\?discussion=[^&]+&changes=1/);
    await expect(page.getByRole("heading", { name: "Priorities", level: 1 })).toBeVisible();
    const card = panel(page).getByTestId("discussion-thread").getByTestId("changes-card");
    await expect(card).toBeInViewport();
    await expect(card.getByRole("list", { name: "Open changes" }).getByTestId("change-row")).toContainText("Move Guest checkout above Saved carts");
    await expect(sheet(page)).toHaveCount(0);
    // The panel sits at the right, no wider than the panel's 400 px.
    const box = (await panel(page).boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(401);
    expect(box.x + box.width).toBeGreaterThan(1440 - 2);
    await panel(page).getByRole("button", { name: "Close Ask Oracle" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/priorities$/);
  });

  test("a run agent's discussion link opens in the Ask panel on the run page", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "run-discussions"), MOCK_SCENARIO_KEY);
    await login(page, "commenter@example.com");
    await page.goto(`/runs/${RUN}?discussion=${RUN_DISCUSSION_OPEN}`);
    await expect(panel(page).getByTestId("discussion-thread")).toContainText("Can bulk edit ship before the export does?");
    await expect(sheet(page)).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a discussion link keeps the bottom sheet on a phone", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "run-discussions"), MOCK_SCENARIO_KEY);
    await login(page, "commenter@example.com");
    await page.goto(`/runs/${RUN}?discussion=${RUN_DISCUSSION_OPEN}`);
    await expect(sheet(page).getByTestId("discussion-thread")).toContainText("Can bulk edit ship before the export does?");
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
  });
});
