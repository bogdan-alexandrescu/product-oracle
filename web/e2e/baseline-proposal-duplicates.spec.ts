import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// The "proposal-duplicates" scenario (lib/api/mock/baseline.ts addDuplicateProposals): the
// Ground Truth to PRD run's writer and critic propose the same changes twice, and four
// proposals on Raise activation that one accept settles.
const PHONE = { width: 390, height: 844 };

async function openProposals(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "proposal-duplicates"));
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("proposal").first()).toBeVisible();
}

const card = (page: Page, reason: string) => page.getByTestId("proposal").filter({ hasText: reason });

for (const [where, size] of [["desktop", null], ["phone", PHONE]] as const) {
  test.describe(`Ground Truth proposals: duplicates (${where})`, () => {
    if (size) test.use({ viewport: size });

    /**
     * protects: two values the run proposed for one field are one card with the choice; picking
     * one accepts it and closes the other.
     * fails_when: the critic's proposal has its own card, the card offers Accept instead of the
     * choice, or the other value is still asked for after the pick.
     */
    test("two values for Dark mode's status are one choice", async ({ page }) => {
      await openProposals(page);
      await expect(card(page, "Not committed to yet.")).toHaveCount(0);
      const dark = card(page, "Mentioned as next up in the planning call");
      const choice = dark.getByRole("group", { name: "Pick one" });
      await expect(choice).toContainText("Planned or Proposed");
      await expect(choice).toContainText("Critic suggests Proposed");
      await expect(dark.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
      await choice.getByRole("button", { name: "Proposed", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Proposal accepted");
      await expect(card(page, "Mentioned as next up in the planning call")).toHaveCount(0);
      await expect(card(page, "Not committed to yet.")).toHaveCount(0);
    });

    /**
     * protects: a feature added twice under near-identical titles is one card naming the other
     * role and its title; accepting it closes the other as already done.
     * fails_when: "Add saved address" has its own card, the role or its title is not named, or
     * it is left open.
     */
    test("a feature proposed twice is one card, also proposed by the critic", async ({ page }) => {
      await openProposals(page);
      const added = card(page, "Asked for in the planning call.");
      await expect(added).toHaveCount(1);
      await expect(added.getByTestId("also-proposed")).toHaveText("Also proposed by Critic as “Add saved address”");
      await added.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("1 other proposal was already done and is closed.");
      await expect(card(page, "Asked for in the planning call.")).toHaveCount(0);
    });

    /**
     * protects: a link proposed twice is one card; accepting a link that already exists says so
     * in plain words and closes it, with no error.
     * fails_when: the second link has its own card, the raw edge text or an error shows, or the
     * proposal stays open.
     */
    test("accepting a link that already exists is done, not an error", async ({ page }) => {
      await openProposals(page);
      await expect(card(page, "Invites come first.")).toHaveCount(0);
      const link = card(page, "Shared carts need invites.");
      await expect(link.getByTestId("also-proposed")).toHaveText("Also proposed by Critic");
      await link.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("This link already exists");
      await expect(page.getByText(/edge between these entities/)).toHaveCount(0);
      await expect(card(page, "Shared carts need invites.")).toHaveCount(0);
      await expect(card(page, "Invites come first.")).toHaveCount(0);
    });

    /**
     * protects: accepting one goal change closes at once the proposals it made no-ops, and marks
     * the one that would undo it in one line.
     * fails_when: the same target or the unchanged name is still asked for, or the stretch
     * target is closed or not named on the line.
     */
    test("accepting a goal change closes its no-op siblings", async ({ page }) => {
      await openProposals(page);
      await expect(card(page, "Keep the name.").getByRole("button", { name: "Dismiss" })).toBeVisible();
      await card(page, "Raise the bar after the October read.").getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("2 other proposals were already done and are closed.");
      await expect(card(page, "Half of new accounts set up in a week.")).toHaveCount(0);
      await expect(card(page, "Keep the name.")).toHaveCount(0);
      await expect(card(page, "Stretch target.")).toHaveCount(1);
      await expect(page.getByTestId("undo-line")).toContainText("1 proposal would undo what you just accepted");
      await page.getByTestId("undo-line").getByRole("button", { name: "Show" }).click();
      await expect(card(page, "Stretch target.")).toHaveAttribute("data-highlighted", "true");
    });

    /**
     * protects: a feature and its next version ("Search" and "Search v2") are two cards, and
     * accepting the first leaves the second to decide.
     * fails_when: "Search v2" shows as also proposed on the Search card, or the accept closes it.
     */
    test("a feature and its next version are two cards", async ({ page }) => {
      await openProposals(page);
      const search = card(page, "A search box.");
      await expect(card(page, "A second search with filters.")).toHaveCount(1);
      await expect(search.getByTestId("also-proposed")).toHaveCount(0);
      await search.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Proposal accepted");
      await expect(page.getByRole("status")).not.toContainText("already done");
      await expect(card(page, "A search box.")).toHaveCount(0);
      await expect(card(page, "A second search with filters.")).toHaveCount(1);
    });

    /**
     * protects: the line about undoing what you just accepted is only for an accept made just
     * now; a proposal that would undo one from days ago keeps its own chip only.
     * fails_when: the line shows on opening the page for an accept made days ago.
     */
    test("an accept from days ago is not 'just accepted'", async ({ page }) => {
      await openProposals(page);
      await expect(card(page, "Invites in M1.").getByTestId("overlap-chip")).toBeVisible();
      await expect(page.getByTestId("undo-line")).toHaveCount(0);
    });
  });
}
