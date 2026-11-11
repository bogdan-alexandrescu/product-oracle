// goal-money-full: the owner's pick (Nov 11), "Short on Home only". A money goal's figures read in
// full ("$50,000") on every page, the Ground Truth's goal fields and Plan's goals among them; only
// Home's goals keep the short form ("$50k"). Mock-backed: "simple-home"'s Faster activation is a
// typed goal of at least 50,000 USD, from 30,000.
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

async function open(page: Page, path: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-home"] as const);
  await login(page);
  await page.goto(path);
}

const goalIn = (page: Page, panel: string) => page.getByTestId(panel).locator("[data-testid^='home-goal-']").filter({ hasText: "Faster activation" });

test("the Ground Truth's goal fields show a money target in full", async ({ page }) => {
  await open(page, "/ground-truth");
  const row = page.getByTestId("goal-faster-activation");
  await expect(row.locator('[data-attr="target"]')).toHaveText("≥ $50,000");
  await expect(row.locator('[data-attr="target"]')).toHaveAttribute("title", "At least $50,000");
});

test("Plan's goals show a money target in full", async ({ page }) => {
  await open(page, "/plan");
  await expect(goalIn(page, "plan-goals").getByTestId("goal-figure")).toContainText("/ $50,000");
});

test("Home's goals keep the short form", async ({ page }) => {
  await open(page, "/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
  await expect(goalIn(page, "home-goals").getByTestId("goal-figure")).toContainText("/ $50k");
});
