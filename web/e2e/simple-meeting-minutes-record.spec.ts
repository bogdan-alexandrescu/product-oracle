import { MOCK_MEETINGS_KEY, MINUTES_LATER_MS } from "../lib/api/mock/simple-meetings";
import { login } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * The owner's production walk (2026-10-27): a meeting's minutes say only what happened.
 * Driven through the UI on the mock's invented data (./lib/api/mock/simple-meetings.ts),
 * desktop and phone, light and dark, as the PRD's decider (who ends meetings).
 *
 * Card minutes-empty-meeting: protects = a review ended with nothing said, decided or
 * assigned shows minutes that say plainly "nothing was decided or recorded", with no open
 * question and no action item, at once and after Oracle's minutes job answers; fails_when =
 * the minutes invent an open question or an action item, or read "no decision was taken"
 * as if something else happened; no_claim = the job's output check on a real model's
 * answer (api/tests/test_simple_minutes_record.py).
 */

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

async function startAndEnd(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await page.getByRole("button", { name: "Start a review" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

const NOTHING = "Review: Guided setup: nothing was decided or recorded.";

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("an empty meeting's minutes say nothing was decided or recorded", async ({ page }) => {
        await startAndEnd(page);
        const minutes = page.getByRole("region", { name: "Minutes" });
        await expect(minutes.getByLabel("Summary")).toHaveValue(NOTHING);
        await expect(minutes.getByLabel("Open questions")).toHaveValue("");
        await expect(minutes.getByTestId("action-item")).toHaveCount(0);
        await expect(minutes).toContainText("No decision was taken.");
      });

      test("Oracle's minutes of an empty meeting invent nothing either", async ({ page, context }) => {
        await flags(context, "minutes-later");
        await startAndEnd(page);
        const minutes = page.getByRole("region", { name: "Minutes" });
        await expect(minutes.getByText("Drafting…")).toBeVisible();
        await page.clock.runFor(MINUTES_LATER_MS + 4_000);
        await expect(minutes.getByText("Drafting…")).toHaveCount(0);
        await expect(minutes.getByLabel("Summary")).toHaveValue(NOTHING);
        await expect(minutes.getByLabel("Open questions")).toHaveValue("");
        await expect(minutes.getByTestId("action-item")).toHaveCount(0);
      });
    });
  }
}
