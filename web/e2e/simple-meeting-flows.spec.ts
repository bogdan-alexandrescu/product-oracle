import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * Simple S8 (#723), the review's finding: each decided flow is linked. A meeting decides a
 * proposal for a new feature (the draft item "Team invite nudges"); the end screen and the
 * Decisions page show its flow thumbnail, which widens in place (a full-height sheet on a
 * phone), or "No flow yet" while S10 has drawn none. On the mock's invented data; the
 * mock's "flow" flag stands for S10's bundle being drawn.
 *
 * Card meeting-decided-flow: protects = a decision on a new flow carries its flow thumbnail
 * on the end screen (widened: the user flow and the wireframe) and on the Decisions page;
 * "No flow yet" without one; a decision on a planned item shows neither; fails_when = the
 * decided flow is not linked; no_claim = how S10 draws the flow.
 */

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

async function decideAndEnd(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await page.getByRole("button", { name: "Start review" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
  await page.getByRole("button", { name: "Move Team invite nudges to Now" }).click();
  await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Moved Team invite nudges");
  await page.getByRole("button", { name: "Move Setup checklist to Next" }).click();
  await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Moved Setup checklist");
  await page.getByRole("button", { name: "End meeting" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

const taken = (page: Page, text: string) => page.getByRole("list", { name: "Decisions taken" }).getByRole("listitem").filter({ hasText: text });

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 } });

    test("the end screen links the decided flow", async ({ page, context }) => {
      await flags(context, "flow");
      await decideAndEnd(page);
      const row = taken(page, "Moved Team invite nudges");
      await expect(taken(page, "Moved Setup checklist").getByTestId("flow-thumb")).toHaveCount(0);
      await expect(taken(page, "Moved Setup checklist").getByTestId("flow-none")).toHaveCount(0);
      await row.getByRole("button", { name: "Open the flow for Team invite nudges" }).click();
      const detail = phone ? page.getByTestId("flow-sheet") : row;
      await expect(detail.getByTestId("flow-detail")).toContainText("User flow: Invite your team");
      await expect(detail.getByRole("img", { name: "Wireframe of Invite step" })).toBeVisible();
      if (!phone) await expect(row).toHaveAttribute("data-wide", "true");
      else {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("flow-sheet")).toBeHidden();
      }

      await page.getByRole("region", { name: "Delivery" }).getByRole("button", { name: "Send" }).click();
      await page.getByRole("link", { name: "Open the Decisions page" }).click();
      const decided = page.getByTestId("decision-row").filter({ hasText: "Moved Team invite nudges" });
      await expect(decided.getByRole("button", { name: "Open the flow for Team invite nudges" })).toBeVisible();
    });

    test("a decided flow with none drawn reads No flow yet", async ({ page }) => {
      await decideAndEnd(page);
      await expect(taken(page, "Moved Team invite nudges").getByTestId("flow-none")).toHaveText("No flow yet");
      await expect(taken(page, "Moved Team invite nudges").getByTestId("flow-thumb")).toHaveCount(0);
    });
  });
}
