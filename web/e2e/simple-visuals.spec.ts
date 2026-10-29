import { MOCK_VISUAL_JOB_MS_KEY } from "../lib/api/mock/simple-visuals";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple S10 (#723, D26): visual proposals, driven through the UI on the mock's invented
 * one-pager "guided-setup" and roadmap (./lib/api/mock/simple-visuals.ts), on desktop
 * (1366x820) and phone (390x844), light and dark, as each role.
 *
 * The owner's flow picks (2026-10-28, simple-v3/talk/flow-display.html): a flow opens across
 * the page (A), Full screen opens the viewer (C) whose Comment holds the comments, the notes,
 * the versions and Revise.
 *
 * Card visuals-bet-widen: protects = a one-pager bet ("What we will build") carries a flow
 * thumbnail; clicking it opens the user flow across the page: the diagram, its steps with the
 * decision point, the feature of each and what is new, the screen as numbered regions; Full
 * screen opens the same visual over the page (the meeting's or a presentation's view) with
 * the numbered notes tied to the PRD section and requirement under Comment, and closes; a bet
 * with none says "No flow yet"; fails_when = the thumbnail is missing, the flow does not open,
 * the regions or notes are missing, or full screen does not open; no_claim = the drawing's
 * pixels and the model's wording (api/tests/test_simple_visuals_api.py).
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
 * Card visuals-bet-ask: protects = a bet Oracle has not drawn offers its owner (who
 * changes the PRD directly: the API's can_revise for one_pager_line) "Ask Oracle to draw
 * it"; pressing it shows the pending state while the simple_visual job runs, then version
 * 1 of the drawing in the widened card; so does asking again for a bet whose queued
 * drawing never came (a visual with no version); a commenter or viewer is offered no ask; fails_when
 * = the owner gets no button, the pending state is missing, the drawing never shows, or a
 * role without the rule is offered the ask; no_claim = the job's queueing and the draft
 * version's lines (api/tests/test_simple_line_visuals_api.py).
 *
 * Card visuals-roadmap-item: protects = a roadmap item's floating card (a bottom sheet on a
 * phone) shows its flow's title; "Open the item's flow" opens the user flow and its screen
 * across the page (full height on a phone); an item with none says "No flow yet" and its
 * owner asks Oracle to draw it, after which version 1 shows; fails_when = the flow does not
 * open or the ask draws nothing; no_claim = the job's queueing (the API's tests).
 */

const ONE_PAGER = "/simple/prds/guided-setup";
const ROADMAP = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1366, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

/** Opens bet 2's flow across the page: the opened view. */
async function openBet(page: Page, email?: string): Promise<Locator> {
  await login(page, email);
  await page.goto(ONE_PAGER);
  await page.getByRole("button", { name: "Flow for “A setup checklist that shows" }).click();
  const opened = page.getByTestId("flow-detail");
  await expect(opened.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
  return opened;
}

/** The viewer's comments (Full screen, then Comment): the notes, the versions, Revise. */
async function openComments(page: Page, opened: Locator): Promise<Locator> {
  await opened.getByRole("button", { name: "Full screen" }).click();
  const full = page.getByTestId("flow-fullscreen");
  await full.getByRole("button", { name: "Comment" }).click();
  await expect(full.getByTestId("flow-version")).toBeVisible();
  return full;
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      test("a bet's thumbnail opens its flow and screen across the page, then full screen", async ({ page }) => {
        const opened = await openBet(page, "viewer@example.com");
        await expect(opened.getByRole("heading", { name: "Finish setup from the checklist · flow", level: 2 })).toBeVisible();
        await expect(opened.getByTestId("flow-svg")).toBeVisible();
        await expect(opened.getByTestId("flow-steps")).toContainText("Decision: Invite now or later?");
        await expect(opened.getByTestId("flow-steps")).toContainText("See the setup checklist · Setup checklist");
        await expect(opened.getByTestId("flow-steps")).toContainText("New");
        await expect(opened.getByText("Screen: Home with the checklist")).toBeVisible();
        await expect(opened.getByTestId("flow-regions")).toContainText("Setup checklist: 4 steps");
        const full = await openComments(page, opened);
        await expect(full.getByRole("heading", { name: "Finish setup from the checklist", level: 2 })).toBeVisible();
        await expect(full.getByTestId("flow-version")).toHaveText("Version 1 of 1");
        await expect(full.getByTestId("flow-annotations")).toContainText("The checklist shows the next step · PRD § build, requirement R1");
        // Roles: a viewer reads, with no comment box and no Revise.
        await expect(full.getByLabel("Comment on the flow")).toHaveCount(0);
        await expect(full.getByRole("button", { name: "Revise" })).toHaveCount(0);
        const box = (await full.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
        await full.getByRole("button", { name: "Exit full screen" }).click();
        await expect(full).toHaveCount(0);
        await opened.getByRole("button", { name: where === "phone" ? "Back" : "Close" }).click();
        await expect(page.getByTestId("flow-detail")).toHaveCount(0);
        // A bet Oracle has not drawn yet: its row says so on the line.
        await expect(page.getByRole("group", { name: "User flow of “Invite suggestions from the admin's" }).getByTestId("flow-empty")).toContainText("No flow yet");
      });

      test("an owner comments on a note and revises: version 2, version 1 in the history", async ({ page }) => {
        const full = await openComments(page, await openBet(page));
        const panel = full.getByTestId("flow-comments-panel");
        await expect(panel.getByRole("button", { name: "Revise" })).toBeDisabled();
        await panel.getByLabel("Comment on the flow").fill("Show where a skipped invite comes back");
        await panel.getByLabel("On annotation").selectOption("2");
        await panel.getByRole("button", { name: "Comment", exact: true }).click();
        await expect(panel.getByTestId("flow-comments")).toContainText("on note 2: Show where a skipped invite comes back · open");
        await panel.getByRole("button", { name: "Revise" }).click();
        await expect(panel.getByTestId("flow-version")).toHaveText("Version 2 of 2");
        await expect(full.getByRole("heading", { name: "Finish setup from the checklist (revised) · flow", level: 2 })).toBeVisible();
        await expect(panel.getByTestId("flow-comments")).toContainText("addressed in version 2");
        // The revised steps, under the comments (a phone: on the Steps tab).
        await full.getByRole("button", { name: "Close the comments" }).click();
        if (where === "phone") await full.getByRole("tab", { name: "Steps" }).click();
        await expect(full.getByTestId("flow-steps")).toContainText("Show where a skipped invite comes back");
        await full.getByRole("button", { name: "Comment" }).click();
        await panel.getByLabel("Version").selectOption("1");
        await expect(panel.getByTestId("flow-version")).toHaveText("Version 1 of 2 (an older version)");
        await expect(full.getByRole("heading", { name: "Finish setup from the checklist · flow", level: 2 })).toBeVisible();
      });

      test("an owner asks Oracle to draw a bet's flow: pending, then version 1", async ({ page }) => {
        await login(page);
        await page.goto(ONE_PAGER);
        const wide = page.getByRole("group", { name: "User flow of “Invite suggestions from the admin's" });
        await expect(wide.getByTestId("flow-empty")).toContainText("No flow yet");
        await wide.getByRole("button", { name: "Ask Oracle to draw it" }).click();
        await expect(wide.getByTestId("flow-empty")).toContainText("Oracle is drawing the flow");
        await expect(wide.getByRole("button", { name: "Ask Oracle to draw it" })).toHaveCount(0);
        await expect(wide.getByTestId("flow-drawn")).toContainText("Version 1");
        await wide.getByRole("button", { name: "Flow for “Invite suggestions from the admin's" }).click();
        const opened = page.getByTestId("flow-detail");
        await expect(opened.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
        await expect(opened.getByTestId("flow-svg")).toBeVisible();
        await opened.getByRole("button", { name: where === "phone" ? "Back" : "Close" }).click();
        // The bet's thumbnail still shows its flow (no longer "No flow yet") after a reload.
        await page.reload();
        await expect(page.getByRole("button", { name: "Flow for “Invite suggestions from the admin's" })).toBeVisible();
        await expect(page.getByRole("group", { name: "User flow of “Invite suggestions from the admin's" })).not.toContainText("No flow yet");
      });

      test("an owner asks again for a bet whose queued drawing never came: pending, then version 1", async ({ page }) => {
        await login(page);
        await page.goto(ONE_PAGER);
        const wide = page.getByRole("group", { name: "User flow of “A sample project created on" });
        await expect(wide.getByTestId("flow-empty")).toContainText("No flow yet");
        await wide.getByRole("button", { name: "Ask Oracle to draw it" }).click();
        await expect(wide.getByTestId("flow-empty")).toContainText("Oracle is drawing the flow");
        await expect(wide.getByTestId("flow-drawn")).toContainText("Version 1");
        await wide.getByRole("button", { name: "Flow for “A sample project created on" }).click();
        await expect(page.getByTestId("flow-detail").getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
        await expect(page.getByTestId("flow-detail").getByTestId("flow-svg")).toBeVisible();
      });

      for (const who of ["commenter@example.com", "viewer@example.com"]) {
        test(`${who.split("@")[0]} is not offered Ask on a bet Oracle has not drawn`, async ({ page }) => {
          await login(page, who);
          await page.goto(ONE_PAGER);
          const wide = page.getByRole("group", { name: "User flow of “Invite suggestions from the admin's" });
          await expect(wide.getByTestId("flow-empty")).toContainText("No flow yet");
          await expect(wide.getByRole("button", { name: "Ask Oracle to draw it" })).toHaveCount(0);
        });
      }

      test("a commenter comments but cannot revise", async ({ page }) => {
        const full = await openComments(page, await openBet(page, "commenter@example.com"));
        const panel = full.getByTestId("flow-comments-panel");
        await panel.getByLabel("Comment on the flow").fill("Name the invite step after the calendar");
        await panel.getByRole("button", { name: "Comment", exact: true }).click();
        await expect(panel.getByTestId("flow-comments")).toContainText("Name the invite step after the calendar · open");
        await expect(full.getByRole("button", { name: "Revise" })).toHaveCount(0);
      });

      test("a roadmap item's card opens its flow across the page; an owner asks Oracle for one", async ({ page }) => {
        await login(page);
        await page.goto(ROADMAP);
        await expect(bar(page, "alert-mobile")).toBeVisible();
        await bar(page, "alert-mobile").click();
        const card = page.getByTestId("floating-card");
        await expect(card.getByTestId("card-flow")).toContainText("Act on a pushed alert");
        await card.getByRole("button", { name: "Open the item's flow" }).click();
        await expect(card).toHaveAttribute("data-flow-open", "true");
        const view = page.getByTestId("flow-detail");
        await expect(view.getByRole("heading", { level: 2 })).toHaveText(where === "phone" ? "Act on a pushed alert · flow" : "Mobile alert push · flow");
        await expect(view.getByTestId("flow-regions")).toContainText("Snooze and Assign buttons");
        if (where === "phone") {
          const box = (await view.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(840);
        }
        await view.getByRole("button", { name: where === "phone" ? "Back" : "Close" }).click();
        await expect(card).toHaveAttribute("data-flow-open", "false");
        await card.getByRole("button", { name: "Close", exact: true }).click();
        await bar(page, "alert-digest").click();
        await expect(card.getByTestId("card-flow")).toContainText("No flow yet");
        await expect(card.getByTestId("flow-empty")).toContainText("No flow yet");
        await card.getByRole("button", { name: "Ask Oracle to draw it" }).click();
        await expect(card.getByTestId("flow-drawn")).toContainText("Version 1");
      });
    });
  }
}

test.describe("a drawing that takes a while lands without a reload", () => {
  test.use(DESKTOP);
  const JOB_MS = 4500;

  async function noReloads(page: Page): Promise<() => number> {
    let loads = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) loads += 1;
    });
    return () => loads;
  }

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, String(JOB_MS)] as const);
  });

  test("a roadmap item's card: drawing, then version 1", async ({ page }) => {
    await login(page);
    await page.goto(ROADMAP);
    await bar(page, "alert-digest").click();
    const card = page.getByTestId("floating-card");
    const loads = await noReloads(page);
    await card.getByRole("button", { name: "Ask Oracle to draw it" }).click();
    await expect(card.getByTestId("flow-empty")).toContainText("Oracle is drawing the flow");
    // The job is still running at the panel's first read again.
    await page.waitForTimeout(2500);
    await expect(card.getByTestId("flow-empty")).toContainText("Oracle is drawing the flow");
    await expect(card.getByTestId("flow-drawn")).toContainText("Version 1", { timeout: JOB_MS + 6000 });
    await card.getByRole("button", { name: "Open the flow", exact: true }).click();
    await expect(page.getByTestId("flow-detail").getByTestId("flow-svg")).toBeVisible();
    expect(loads()).toBe(0);
  });

  test("a one-pager bet line: drawing, then version 1", async ({ page }) => {
    await login(page);
    await page.goto(ONE_PAGER);
    const wide = page.getByRole("group", { name: "User flow of “Invite suggestions from the admin's" });
    const loads = await noReloads(page);
    await wide.getByRole("button", { name: "Ask Oracle to draw it" }).click();
    await expect(wide.getByTestId("flow-empty")).toContainText("Oracle is drawing the flow");
    await page.waitForTimeout(2500);
    await expect(wide.getByTestId("flow-empty")).toContainText("Oracle is drawing the flow");
    await expect(wide.getByTestId("flow-drawn")).toContainText("Version 1", { timeout: JOB_MS + 6000 });
    await wide.getByRole("button", { name: "Flow for “Invite suggestions from the admin's" }).click();
    await expect(page.getByTestId("flow-detail").getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
    await expect(page.getByTestId("flow-detail").getByTestId("flow-svg")).toBeVisible();
    expect(loads()).toBe(0);
  });
});
