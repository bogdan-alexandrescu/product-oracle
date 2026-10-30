import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The one-pager reads clearly (the owner's pick, 2026-10-30), on the mock's "guided-setup".
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=the problem says who has it (from the PRD's "Who has it" section); each outcome
 *   says how it is measured and where it comes from, or that the PRD does not say yet; a
 *   code shows its name ("F-26 Calendar invites"); a dagger with no note is gone; an owner
 *   gets a quiet "Needs a look" note naming both numbers that disagree and where;
 *   fails_when=any of those reads as before (one sentence naming no one, a bare code, a
 *   lone dagger, no measure, no note); no_claim=the API's checks (pytest).
 * - protects=a bet with no flow says nothing to a viewer or a commenter, and offers an owner
 *   a small "Draw the flow" link at the end of its line, which draws it; fails_when="No flow
 *   yet · Ask Oracle to draw it" shows under a bet; no_claim=the flow's own panel.
 */
const URL = "/simple/prds/guided-setup";
const LOOK_COUNT = "“Eight features wait for next” says 8, but “Not this quarter” shows 6 items.";
const LOOK_PER = "40 paid workspaces per region × 5 regions is 200, but the company-wide target says 250.";

async function readsClearly(page: Page) {
  const problem = page.getByRole("region", { name: "Problem and who has it" });
  await expect(problem.getByTestId("problem-who")).toHaveText("Who has it: Admins of new teams with fewer than ten people");
  const outcomes = page.getByRole("region", { name: "Outcomes and how we measure them" });
  await expect(outcomes.locator('[data-line="outcomes-1"]').getByTestId("outcome-measure")).toHaveText(
    "counted as: admins whose first invite is accepted within 7 days · from the product events table",
  );
  await expect(outcomes.locator('[data-line="outcomes-2"]').getByTestId("outcome-measure")).toHaveText("How it is measured is not in the PRD yet");
  const risks = page.getByRole("region", { name: "Risks and open decisions" });
  await expect(risks.locator('[data-line="risks-3"]')).toContainText("F-26 Calendar invites may slip past M1");
  await expect(page.getByRole("article", { name: "One-pager" })).not.toContainText("†");
  // The bet flow prompt is gone from under every bet.
  await expect(page.getByText("No flow yet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Oracle to draw it" })).toHaveCount(0);
  // A drawn bet keeps its flow row.
  await expect(page.getByRole("group", { name: /^User flow of “A setup checklist/ })).toBeVisible();
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 } });

    test("an owner reads who, how it is measured, named codes, a Needs a look note, and draws a bet's flow", async ({ page }) => {
      await login(page);
      await page.goto(URL);
      await readsClearly(page);
      const look = page.getByRole("region", { name: "Needs a look" });
      await expect(look).toBeVisible();
      await expect(look.getByRole("listitem")).toHaveText([
        `${LOOK_COUNT} In: Not this quarter`,
        `${LOOK_PER} In: Targets`,
      ]);
      const bet = page.locator('[data-line="bets-2"]');
      await expect(page.getByRole("group", { name: /^User flow of “Invite suggestions/ })).toHaveCount(0);
      const draw = bet.getByRole("button", { name: /^Draw the flow for “Invite suggestions/ });
      await expect(draw).toHaveText("Draw the flow");
      // The link sits at the end of the bet's line, not under it.
      const lineBox = (await bet.getByTestId("one-pager-line-text").boundingBox())!;
      const drawBox = (await draw.boundingBox())!;
      expect(drawBox.y).toBeLessThan(lineBox.y + lineBox.height);
      await draw.click();
      const flow = page.getByRole("group", { name: /^User flow of “Invite suggestions/ });
      await expect(flow.getByTestId("flow-drawn")).toContainText("Version 1");
      await expect(bet.getByRole("button", { name: /^Draw the flow/ })).toHaveCount(0);
    });

    for (const who of ["viewer@example.com", "commenter@example.com"]) {
      test(`${who.split("@")[0]} reads the same page with no Needs a look and no flow prompt`, async ({ page }) => {
        await login(page, who);
        await page.goto(URL);
        await readsClearly(page);
        await expect(page.getByRole("region", { name: "Needs a look" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Draw the flow/ })).toHaveCount(0);
        await expect(page.getByRole("group", { name: /^User flow of “Invite suggestions/ })).toHaveCount(0);
      });
    }
  });
}
