import { expect, test, type FrameLocator, type Page } from "./test";
import { login } from "./helpers";

/**
 * O5 owner decision (2026-10-26): the roadmap's audience preview groups Board's and Team's
 * items by the confirmed goal each item's feature serves in the baseline, under each
 * horizon. The "sharing" scenario's items: Falcon alerts rework and Billing ledger v2
 * serve G1 (Cut monthly churn to 2%), Northwind bulk import and Partner API beta serve G2
 * (Grow self-serve sign-ups); Ops console cleanup's feature serves no confirmed goal, so
 * Board leaves it out and Team shows it under "No goal".
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
  const headings = (await frame.locator("h1, h2, h3, h4, h5, h6").allTextContents()).map((t) => t.trim());
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
});

test("Board groups its rows by goal and still leaves out the item that serves none", async ({ page }) => {
  await sharing(page);
  await page.goto(DOC);
  await page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Board" }).click();
  const board = page.frameLocator('iframe[title="Roadmap for Board"]');
  await expect(board.getByText("1 item serves no confirmed goal and is left out.")).toBeVisible();
  await expect(board.getByRole("heading", { name: G1 })).toHaveCount(2);
  expect(await horizonOutline(board)).toEqual(["Now", G1, G2, "Next", G1, G2]);
  await expect(board.getByRole("row", { name: /Falcon alerts rework/ })).toBeVisible();
  await expect(board.getByRole("row", { name: /Partner API beta/ })).toBeVisible();
  await expect(board.getByText("Ops console cleanup")).toHaveCount(0);
  await expect(board.getByRole("heading", { name: "No goal" })).toHaveCount(0);
});
