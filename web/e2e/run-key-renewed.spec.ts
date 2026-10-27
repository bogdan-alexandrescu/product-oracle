import { expect, test } from "./test";

import { KEY_RENEWED_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// SwarmCloud #2498: a step that started after the run's key expired in SwarmCloud's queue is
// parked, Oracle renews the key, and the run page says so in the runtime's notes.
test("a run whose key was renewed says so on its page", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, KEY_RENEWED_SCENARIO]);
  await login(page);
  await page.getByTestId("nav-runs").click();
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  const row = page.getByTestId("run-row").filter({ hasText: "checkout-redesign" }).filter({ hasText: "Running" });
  await row.getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Feedback loop" })).toBeVisible();

  await page.getByRole("button", { name: "About the runtime" }).click();
  const notes = page.getByTestId("run-notes");
  await expect(notes).toBeVisible();
  await expect(notes).toContainText("Key renewed at 2026-10-21 03:10 PDT");
  await expect(notes).toContainText("expired while it waited in SwarmCloud's queue");
  // The key itself is never shown.
  await expect(notes).not.toContainText("ort_");
});
