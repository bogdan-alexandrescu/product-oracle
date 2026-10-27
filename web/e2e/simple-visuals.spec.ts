import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple S10 (#723, D26): visual proposals, driven through the UI on the mock's invented
 * one-pager "guided-setup" and roadmap (./lib/api/mock/simple-visuals.ts), on desktop
 * (1366x820) and phone (390x844), light and dark, as each role.
 *
 * Card visuals-bet-widen: protects = a one-pager bet ("What we will build") carries a flow
 * thumbnail; clicking it widens the card in place to the user flow (an image of the
 * sanitised SVG), its steps with the decision point, the feature of each and what is new,
 * the screen's low-fi wireframe (a sandboxed frame), and the numbered annotations tied to
 * the PRD section and requirement; Full screen opens the same visual over the page (the
 * meeting's or a presentation's view) and closes; a bet with none says "No flow yet";
 * fails_when = the thumbnail is missing, the card does not widen, the wireframe or notes
 * are missing, or full screen does not open; no_claim = the drawing's pixels and the
 * model's wording (api/tests/test_simple_visuals_api.py).
 *
 * Card visuals-comment-revise: protects = an owner comments on one annotation, presses
 * Revise and the card shows version 2 with the comment addressed by it, while the history
 * still opens version 1 read-only; fails_when = Revise is offered with no open comment, the
 * new version does not show, or the comment loses its state; no_claim = how well Oracle
 * follows the comment (the job's tests).
 *
 * Card visuals-roles: protects = a commenter comments but gets no Revise; a viewer reads
 * the visual with neither a comment box nor Revise (can_comment / can_revise);
 * fails_when = a role sees a control its rule does not give; no_claim = the API's 403s
 * (its role tests).
 *
 * Card visuals-roadmap-item: protects = a roadmap item's floating card (a bottom sheet on a
 * phone) shows its flow's title; "Open the item's flow" widens the card in place to the
 * user flow and wireframe (full height on a phone); an item with none says "No flow yet"
 * and its owner asks Oracle to draw it, after which version 1 shows; fails_when = the card
 * does not widen or the ask draws nothing; no_claim = the job's queueing (the API's tests).
 */

const ONE_PAGER = "/simple/prds/guided-setup";
const ROADMAP = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1366, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

async function openBet(page: Page, email?: string): Promise<Locator> {
  await login(page, email);
  await page.goto(ONE_PAGER);
  await page.getByRole("button", { name: "Flow for bet 2" }).click();
  const wide = page.getByRole("group", { name: "User flow of bet 2" });
  await expect(wide.getByTestId("flow-version")).toHaveText("Version 1 of 1");
  return wide;
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      test("a bet's thumbnail widens its card to the flow and wireframe, then full screen", async ({ page }) => {
        const wide = await openBet(page, "viewer@example.com");
        await expect(wide.getByRole("heading", { name: "User flow: Finish setup from the checklist" })).toBeVisible();
        await expect(wide.getByTestId("flow-svg")).toBeVisible();
        await expect(wide.getByTestId("flow-steps")).toContainText("Decision: Invite now or later?");
        await expect(wide.getByTestId("flow-steps")).toContainText("See the setup checklist · Setup checklist");
        await expect(wide.getByTestId("flow-steps")).toContainText("New");
        await expect(wide.getByTestId("flow-wireframe")).toBeVisible();
        await expect(wide.getByTestId("flow-wireframe")).toHaveAttribute("sandbox", "");
        await expect(wide.getByTestId("flow-annotations")).toContainText("The checklist shows the next step · PRD § build, requirement R1");
        await expect(page.frameLocator('[data-testid="flow-wireframe"]').first().getByText("Setup checklist: 4 steps")).toBeVisible();
        // Roles: a viewer reads, with no comment box and no Revise.
        await expect(wide.getByLabel("Comment on the flow")).toHaveCount(0);
        await expect(wide.getByRole("button", { name: "Revise" })).toHaveCount(0);
        await wide.getByRole("button", { name: "Full screen" }).click();
        const full = page.getByTestId("flow-fullscreen");
        await expect(full).toBeVisible();
        await expect(full.getByRole("heading", { name: "Finish setup from the checklist", level: 2 })).toBeVisible();
        const box = (await full.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
        await full.getByRole("button", { name: "Exit full screen" }).click();
        await expect(full).toHaveCount(0);
        await wide.getByRole("button", { name: "Close the flow" }).click();
        await expect(wide).toHaveCount(0);
        // A bet Oracle has not drawn yet.
        await page.getByRole("button", { name: "Flow for bet 3" }).click();
        await expect(page.getByRole("group", { name: "User flow of bet 3" }).getByTestId("flow-empty")).toContainText("No flow yet");
      });

      test("an owner comments on a note and revises: version 2, version 1 in the history", async ({ page }) => {
        const wide = await openBet(page);
        await expect(wide.getByRole("button", { name: "Revise" })).toBeDisabled();
        await wide.getByLabel("Comment on the flow").fill("Show where a skipped invite comes back");
        await wide.getByLabel("On annotation").selectOption("2");
        await wide.getByRole("button", { name: "Comment", exact: true }).click();
        await expect(wide.getByTestId("flow-comments")).toContainText("on note 2: Show where a skipped invite comes back · open");
        await wide.getByRole("button", { name: "Revise" }).click();
        await expect(wide.getByTestId("flow-version")).toHaveText("Version 2 of 2");
        await expect(wide.getByRole("heading", { name: "User flow: Finish setup from the checklist (revised)" })).toBeVisible();
        await expect(wide.getByTestId("flow-steps")).toContainText("Show where a skipped invite comes back");
        await expect(wide.getByTestId("flow-comments")).toContainText("addressed in version 2");
        await wide.getByLabel("Version").selectOption("1");
        await expect(wide.getByTestId("flow-version")).toHaveText("Version 1 of 2 (an older version)");
        await expect(wide.getByRole("heading", { name: "User flow: Finish setup from the checklist" })).toBeVisible();
      });

      test("a commenter comments but cannot revise", async ({ page }) => {
        const wide = await openBet(page, "commenter@example.com");
        await wide.getByLabel("Comment on the flow").fill("Name the invite step after the calendar");
        await wide.getByRole("button", { name: "Comment", exact: true }).click();
        await expect(wide.getByTestId("flow-comments")).toContainText("Name the invite step after the calendar · open");
        await expect(wide.getByRole("button", { name: "Revise" })).toHaveCount(0);
      });

      test("a roadmap item's card widens in place to its flow; an owner asks Oracle for one", async ({ page }) => {
        await login(page);
        await page.goto(ROADMAP);
        await expect(bar(page, "alert-mobile")).toBeVisible();
        await bar(page, "alert-mobile").click();
        const card = page.getByTestId("floating-card");
        await expect(card.getByTestId("card-flow")).toContainText("Act on a pushed alert");
        await card.getByRole("button", { name: "Open the item's flow" }).click();
        await expect(card).toHaveAttribute("data-wide", "true");
        const view = card.getByTestId("flow-view");
        await view.scrollIntoViewIfNeeded();
        await expect(view.getByRole("heading", { name: "User flow: Act on a pushed alert" })).toBeVisible();
        await expect(view.getByTestId("flow-regions")).toContainText("Snooze and Assign buttons");
        if (where === "phone") {
          const box = (await card.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(840);
        }
        await view.getByRole("button", { name: "Close the flow" }).click();
        await expect(card).toHaveAttribute("data-wide", "false");
        await card.getByRole("button", { name: "Close", exact: true }).click();
        await bar(page, "alert-digest").click();
        await expect(card.getByTestId("card-flow")).toContainText("No flow yet");
        await card.getByRole("button", { name: "Open the item's flow" }).click();
        await expect(card.getByTestId("flow-empty")).toContainText("No flow yet");
        await card.getByRole("button", { name: "Ask Oracle to draw it" }).click();
        await expect(card.getByTestId("flow-version")).toHaveText("Version 1 of 1");
      });
    });
  }
}
