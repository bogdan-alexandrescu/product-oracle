import type { FrameLocator } from "@playwright/test";

import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * O5 owner decision (2026-10-26): the roadmap's audience preview groups Board's and Team's
 * items by the confirmed goal each item's feature serves in the baseline, under each
 * horizon. The "sharing" scenario's items: Falcon alerts rework and Billing ledger v2
 * serve G1 (Cut monthly churn to 2%), Northwind bulk import and Partner API beta serve G2
 * (Grow self-serve sign-ups); Ops console cleanup's feature serves no confirmed goal, so
 * Board leaves it out and Team shows it under "No goal". Falcon alerts rework's feature serves G2 too: grouped under
 * G1 (the first by title), its Goal column and card name G1, the group's goal (owner answer, 2026-10-26).
 */

const DOC = "/documents/example-labs-roadmap";
const G1 = "Cut monthly churn to 2%";
const G2 = "Grow self-serve sign-ups";

async function sharing(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
}

/** The preview's headings from Now up to the next section after the horizons, in order. */
async function horizonOutline(frame: FrameLocator, end?: string): Promise<string[]> {
  const headings = (await frame.locator("h1, h2, h3, h4, h5, h6").allTextContents()).map((t: string) => t.trim());
  const from = headings.indexOf("Now");
  const to = end ? headings.indexOf(end) : headings.length;
  return headings.slice(from, to < 0 ? headings.length : to);
}

test("Team groups each horizon's items under the goal its feature serves, No goal last", async ({ page }) => {
  await sharing(page);
  await page.goto(`${DOC}?audience=team`);
  const team = page.frameLocator('iframe[title="Roadmap for Team"]');
  await expect(team.getByRole("heading", { name: "No goal" })).toBeVisible();
  expect(await horizonOutline(team, "Dependencies and owners")).toEqual([
    "Now", G1, "Falcon alerts rework", G2, "Northwind bulk import",
    "Next", G1, "Billing ledger v2", G2, "Partner API beta",
    "Later", "No goal", "Ops console cleanup",
  ]);
  // Each card's "Goal:" line names its group's goal: Falcon alerts rework's says G1, not its best goal G2.
  await expect(team.getByText(`Goal: ${G1}`, { exact: true })).toHaveCount(2);
  await expect(team.getByText(`Goal: ${G2}`, { exact: true })).toHaveCount(2);
});

test("Board groups its rows by goal and still leaves out the item that serves none", async ({ page }) => {
  await sharing(page);
  await page.goto(DOC);
  await page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Board" }).click();
  const board = page.frameLocator('iframe[title="Roadmap for Board"]');
  await expect(board.getByText("1 item serves no confirmed goal and is left out.")).toBeVisible();
  await expect(board.getByRole("heading", { name: G1 })).toHaveCount(2);
  expect(await horizonOutline(board)).toEqual(["Now", G1, G2, "Next", G1, G2]);
  await expect(board.getByText(/\| Falcon alerts rework \|/)).toBeVisible();
  // Its Goal column names the group's goal (G1), not its best goal (G2).
  await expect(board.getByText(/\| Falcon alerts rework \|.*\| Cut monthly churn to 2% \|/)).toBeVisible();
  await expect(board.getByText(/\| Falcon alerts rework \|.*Grow self-serve sign-ups/)).toHaveCount(0);
  await expect(board.getByText(/\| Partner API beta \|/)).toBeVisible();
  await expect(board.getByText("Ops console cleanup")).toHaveCount(0);
  await expect(board.getByRole("heading", { name: "No goal" })).toHaveCount(0);
});
