import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * tracks-goal (owner, Nov 9): a track holds many PRDs, and a new PRD on no track gets Oracle's
 * suggested track in the Inbox ("Oracle suggests, person confirms"). As a person would: in
 * Simple > Roadmap > Tracks add a second PRD to a track and read both after a reload, then take
 * one off; confirm a suggested track from the Inbox and see the PRD's features leave the No
 * track band; the PRD's owner who does not decide the track asks its decider: the item waits
 * ("Proposed to ..."), cannot be asked again, and leaves both Inboxes once the decider accepts.
 * Invented tracks and PRDs (the mock's seed).
 */

const sheet = (page: Page) => page.getByTestId("tracks-sheet");
const row = (page: Page, title: string) => sheet(page).getByTestId("track-row").filter({ has: page.getByText(title, { exact: true }) });
const toasts = (page: Page) => page.getByTestId("toasts");

async function openTrack(page: Page, title: string) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("tracks-open").click();
  await sheet(page).getByRole("button", { name: `Change ${title}` }).click();
  return row(page, title).getByTestId("track-prds");
}

/** The Gantt by track: the No track band's name, when it shows. */
async function noTrackBand(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByRole("radio", { name: "Gantt" }).or(page.getByRole("button", { name: "Gantt", exact: true })).first().click();
  await page.getByTestId("group-track").click();
  return page.getByTestId("simple-roadmap").getByText("No track", { exact: true }).and(page.locator(":not(option)"));
}

test.describe("Tracks: a track holds many PRDs", () => {
  test("an owner adds a second PRD to a track, sees both after a reload, and takes one off", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const prds = await openTrack(page, "Guided setup track");
    await expect(prds.getByTestId("track-prd-title")).toHaveText(["Guided setup"]);
    // A PRD on another track is offered as a move from it.
    const add = prds.getByLabel("Add a PRD");
    await expect(add.locator("option", { hasText: "Usage alerts · move from Usage alerts track" })).toHaveCount(1);
    await add.selectOption({ label: "Plan changes" });
    await expect(toasts(page)).toContainText("Added Plan changes to Guided setup track");
    await expect(prds.getByTestId("track-prd-title")).toHaveText(["Guided setup", "Plan changes"]);

    await page.reload();
    const again = await openTrack(page, "Guided setup track");
    await expect(again.getByTestId("track-prd-title")).toHaveText(["Guided setup", "Plan changes"]);

    await again.getByRole("button", { name: "Remove Plan changes from Guided setup track" }).click();
    await expect(toasts(page)).toContainText("Removed Plan changes from Guided setup track");
    await expect(again.getByTestId("track-prd-title")).toHaveText(["Guided setup"]);
  });

  test("a new PRD's suggested track is confirmed from the Inbox: the item clears and its features leave No track", async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript((key) => localStorage.setItem(key, "track-suggestion"), MOCK_SCENARIO_KEY);
    await login(page);
    await expect(await noTrackBand(page)).toBeVisible();

    await page.goto("/inbox");
    await expect(page.getByTestId("track-suggestion-title")).toHaveText(["Plan changes"]);
    await expect(page.getByTestId("track-suggestion-context")).toHaveText("Oracle suggests the track Guided setup track");
    await expect(page.getByRole("button", { name: "New track", exact: true })).toBeVisible();
    await expect(page.getByLabel("Pick a track for Plan changes")).toBeVisible();
    await page.getByRole("button", { name: "Put Plan changes on Guided setup track" }).click();
    await expect(page.getByTestId("track-suggestion-title")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("inbox-state-tabs")).toBeVisible();
    await expect(page.getByTestId("track-suggestion-title")).toHaveCount(0);

    await expect(await noTrackBand(page)).toHaveCount(0);
    const prds = await openTrack(page, "Guided setup track");
    await expect(prds.getByTestId("track-prd-title")).toHaveText(["Guided setup", "Plan changes"]);
  });

  test("the PRD's owner confirms a track an owner decides: it waits for them, and their Accept clears both Inboxes", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((key) => localStorage.setItem(key, "track-suggestion-approver"), MOCK_SCENARIO_KEY);
    await login(page, "approver@example.com");
    await page.goto("/inbox");
    await expect(page.getByTestId("track-suggestion-title")).toHaveText(["Plan changes"]);
    await page.getByRole("button", { name: "Put Plan changes on Guided setup track" }).click();
    // It waits for the track's decider: a mark naming them, its tooltip the track; no actions.
    const mark = page.getByTestId("track-suggestion-proposed");
    await expect(mark).toContainText("Proposed to");
    await expect(mark).toHaveAttribute("title", "Asked to put Plan changes on Guided setup track");
    await expect(page.getByRole("button", { name: "Put Plan changes on Guided setup track" })).toHaveCount(0);
    await expect(page.getByLabel("Pick a track for Plan changes")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New track", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("track-suggestion-proposed")).toContainText("Proposed to");
    await expect(page.getByRole("button", { name: "Put Plan changes on Guided setup track" })).toHaveCount(0);

    await signOut(page);
    await login(page);
    await page.goto("/inbox");
    const asked = page.getByRole("row").filter({ hasText: "Put Plan changes on Guided setup track" });
    await expect(asked).toHaveCount(1);
    await asked.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: "Put Plan changes on Guided setup track" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("inbox-state-tabs")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Put Plan changes on Guided setup track" })).toHaveCount(0);
    await expect(await noTrackBand(page)).toHaveCount(0);

    await signOut(page);
    await login(page, "approver@example.com");
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-state-tabs")).toBeVisible();
    await expect(page.getByTestId("track-suggestion-title")).toHaveCount(0);
  });

  // Card track-proposal-declined: protects = the track's decider declining the PRD owner's
  // proposal brings Oracle's suggestion back to them, with its actions; fails_when = the PRD
  // stays "Proposed to" or the suggestion is gone after a decline.
  test("a declined proposal brings the suggested track back to the PRD's owner", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((key) => localStorage.setItem(key, "track-suggestion-approver"), MOCK_SCENARIO_KEY);
    await login(page, "approver@example.com");
    await page.goto("/inbox");
    await page.getByRole("button", { name: "Put Plan changes on Guided setup track" }).click();
    await expect(page.getByTestId("track-suggestion-proposed")).toContainText("Proposed to");

    await signOut(page);
    await login(page);
    await page.goto("/inbox");
    const asked = page.getByRole("row").filter({ hasText: "Put Plan changes on Guided setup track" });
    await asked.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: "Put Plan changes on Guided setup track" })).toHaveCount(0);

    await signOut(page);
    await login(page, "approver@example.com");
    await page.goto("/inbox");
    await expect(page.getByTestId("track-suggestion-title")).toHaveText(["Plan changes"]);
    await expect(page.getByTestId("track-suggestion-proposed")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Put Plan changes on Guided setup track" })).toBeVisible();
  });
});
