import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITY_BLOCKED_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/*
 * Visual QA of Nov 12, 2026 (docs/qa/2026-11-12/detailed-b.md): Detailed Priorities, Runs and
 * Settings, driven through the UI on the mock. Each test names its finding.
 */

const scenario = (page: Page, key: string) => page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, key] as const);

async function priorities(page: Page) {
  await login(page);
  await page.goto("/priorities");
  await expect(page.getByTestId("priority-row-F-1")).toBeVisible();
}

test("detailed-b 1: Priorities names each feature by its code and name", async ({ page }) => {
  await priorities(page);
  // The row, its Depends on and the cycle banner.
  await expect(page.getByTestId("priority-row-F-5").getByTestId("feature-name")).toHaveText("F-5 Address lookup service");
  await expect(page.getByTestId("cycles-banner")).toContainText("F-7 Bulk export → F-8 Scheduled exports");
  const deps = page.getByTestId("priority-row-F-2").getByTestId("row-deps");
  await expect(deps).toContainText("F-5 Address lookup service");
  // The inspector's head and its Moved for chip.
  await page.getByTestId("priority-row-F-5").getByTestId("feature-name").click();
  await expect(page.getByTestId("priority-inspector").getByRole("heading").first()).toContainText("F-5 Address lookup service");
  await expect(page.getByTestId("explanation-F-5").locator("li", { hasText: "Moved for" })).toContainText("F-2 Shipping cost shown in the cart");
  // The Move dialog's title and target.
  await page.getByTestId("priority-row-F-2").getByRole("button", { name: "Move up" }).click();
  const sheet = page.getByTestId("override-sheet");
  await expect(sheet).toContainText("Move F-2 Shipping cost shown in the cart");
  await expect(sheet.getByTestId("move-target")).toHaveText("Move above F-5 Address lookup service");
});

test("detailed-b 4: a row's More actions is the app's icon, never a ⋯ character", async ({ page }) => {
  await priorities(page);
  const more = page.getByTestId("priority-row-F-1").getByRole("button", { name: "More actions" });
  await expect(more.locator("svg")).toHaveCount(1);
  await expect(more).not.toContainText("⋯");
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Move above…" })).toBeVisible();
});

test("detailed-b 6: each header count shows the rows it counts", async ({ page }) => {
  await priorities(page);
  const header = page.locator("header[data-page-header]").filter({ visible: true });
  const rows = page.getByTestId("priority-table").locator("[data-testid^='priority-row-']").filter({ visible: true });
  const all = await rows.count();
  await header.getByRole("button", { name: "1 no goal" }).click();
  await expect(header.getByRole("button", { name: "1 no goal" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("priority-row-F-6")).toBeVisible();
  await header.getByRole("button", { name: "2 in a cycle" }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("priority-row-F-7")).toBeVisible();
  await expect(page.getByTestId("priority-row-F-8")).toBeVisible();
  // The whole count brings every row back.
  await header.getByRole("button", { name: /ranked$/ }).click();
  await expect(rows).toHaveCount(all);
});

test("detailed-b 2: a run's order problem names each feature by its code and name", async ({ page }) => {
  await scenario(page, "priority-order");
  await login(page, "approver@example.com");
  await page.goto(`/runs/${PRIORITY_BLOCKED_RUN}`);
  const reason = page.getByTestId("gate-reason").filter({ visible: true }).first();
  await expect(reason).toContainText("F-2 Shipping cost shown in the cart");
  await expect(reason).toContainText("is ranked 1, above F-5 Address lookup service (rank 2), which it depends on");
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page.getByTestId("priority-row-F-2").getByTestId("problem-before_prerequisite")).toHaveAttribute(
    "title",
    "F-2 Shipping cost shown in the cart is ranked 1, above F-5 Address lookup service (rank 2), which it depends on",
  );
});

test("detailed-b 5: the runs list's count shows only the runs that need a decision", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  const rows = page.getByTestId("run-row");
  await expect(rows).toHaveCount(5);
  const count = page.getByRole("button", { name: /runs? needs? a decision/ });
  const n = Number((await count.innerText()).match(/\d+/)![0]);
  await count.click();
  await expect(count).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(n);
  await count.click();
  await expect(rows).toHaveCount(5);
});

test("detailed-b 20: a run paused over budget says it once to whoever may resume it", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "Team workspaces" }).getByRole("link").first().click();
  await expect(page.getByRole("button", { name: "Resume" }).first()).toBeVisible();
  await expect(page.getByTestId("run-overrun-held")).toHaveCount(0);
});

test("detailed-b 10, 11: Connections has one (i) per row and its count leads to the cards", async ({ page }) => {
  await login(page);
  await page.goto("/settings/connections");
  const count = page.getByTestId("connected-count");
  await expect(count).toHaveAttribute("href", "#connection-cards");
  await count.click();
  await expect(page).toHaveURL(/#connection-cards$/);
  await expect(page.locator("#connection-cards")).toBeInViewport();
  const old = page.locator("li[data-testid^='connection-']").filter({ has: page.getByRole("button", { name: /why reconnect/ }) }).first();
  await expect(old.getByRole("button", { name: / scopes$/ })).toHaveCount(0);
});

test("detailed-b 21: an empty Trash leads to PRDs by their name", async ({ page }) => {
  await scenario(page, "empty");
  await login(page);
  await page.goto("/settings/trash");
  await expect(page.getByTestId("trash-empty").getByRole("link", { name: "Open PRDs" })).toHaveAttribute("href", "/documents");
});
