import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * AQ1 "Cards atop the review" (picked Nov 1): the questions the run's agents asked at the
 * feature set sit in a "Questions from the agents" block at the top of the stop's review page,
 * above the feature table. Open ones as cards with their options as buttons and the agent's
 * pick marked; then an Answered row with who and when. Driven through the UI on the mock's
 * "scope-review" scenario (the Saved addresses PRD, invented people) and its hard case,
 * "scope-review-questions" (eleven questions).
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SEND = "Does a way to send an address to the courier exist already, or do we build it?";

async function seeded(page: Page, email: string, scenario = "scope-review") {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

/** Runs › Saved addresses PRD › Review feature set, as a person goes there. */
async function openReview(page: Page) {
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').filter({ visible: true }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+/);
  await expect(page.getByTestId("scope-row").first()).toBeVisible();
}

const block = (page: Page) => page.getByRole("region", { name: "Questions from the agents" });
const card = (page: Page, text: string) => block(page).getByTestId("agent-question").filter({ hasText: text });

for (const [device, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(device, () => {
    test.use({ viewport });

    test("the agents' questions sit atop the review, above the feature table, the agent's pick marked", async ({ page }) => {
      await seeded(page, APPROVER);
      await openReview(page);
      await expect(block(page).getByRole("heading", { name: "Questions from the agents" })).toBeVisible();
      await expect(block(page).getByTestId("agent-questions-count")).toHaveText("3 open · 1 answered");
      await expect(block(page).getByText("each answer goes to Engineering check with the decision")).toBeVisible();
      const send = card(page, SEND);
      await expect(send).toHaveAttribute("data-state", "unanswered");
      await expect(send.getByText("Architect asks · About Saved addresses")).toBeVisible();
      await expect(send.getByRole("radio", { name: /Reuse the order service path/ }).getByText("Agent's pick")).toBeVisible();
      await expect(send.getByRole("radio", { name: /Build a new send path/ }).getByText("Agent's pick")).toHaveCount(0);
      await expect(send.getByText("Not answered by the time you decide: Engineering check goes with the agent's pick.")).toBeVisible();
      await expect(card(page, "Who edits addresses in bulk").getByText("Analyst asks · About Bulk edit")).toBeVisible();
      // The one someone else answered: in the Answered row, with who and when, month first.
      const home = card(page, "outside the country");
      await expect(home).toHaveAttribute("data-state", "answered");
      await expect(home.getByText("Analyst asked · About the whole set")).toBeVisible();
      await expect(home.getByText("(the agent's pick)")).toBeVisible();
      await expect(home.getByTestId("agent-question-who")).toHaveText(/^Answered by Mara Lindqvist · Oct 17, \d+:\d\d [AP]M/);
      await expect(home.getByRole("button", { name: "Change" })).toHaveCount(0);
      // Above the table: the block ends before the features begin.
      const q = (await block(page).boundingBox())!;
      const firstRow = (await page.getByTestId("scope-row").filter({ visible: true }).first().boundingBox())!;
      expect(q.y + q.height).toBeLessThanOrEqual(firstRow.y);
      const [a, b] = await Promise.all([send.boundingBox(), card(page, "Who edits addresses in bulk").boundingBox()]);
      if (device === "desktop") expect(Math.abs(a!.y - b!.y)).toBeLessThan(2); // two columns
      else expect(Math.abs(a!.x - b!.x)).toBeLessThan(2); // stacked in one column
    });

    test("Why they ask opens the agent's reason and each option's cost; Hide why closes it", async ({ page }) => {
      await seeded(page, APPROVER);
      await openReview(page);
      const send = card(page, SEND);
      await expect(send.getByText("Why: The design needs a send path")).toHaveCount(0);
      await send.getByRole("button", { name: "Why they ask" }).click();
      await expect(send).toHaveAttribute("data-state", "open");
      await expect(send.getByText("Why: The design needs a send path to the courier.")).toBeVisible();
      await expect(send.getByText("About 8 days. Clean, owned by the checkout team.")).toBeVisible();
      await send.getByRole("button", { name: "Hide why" }).click();
      await expect(send).toHaveAttribute("data-state", "unanswered");
      await expect(send.getByText("About 8 days. Clean, owned by the checkout team.")).toHaveCount(0);
    });

    test("picking an option and saving moves the card to Answered, by you, and it can be changed", async ({ page }) => {
      await seeded(page, APPROVER);
      await openReview(page);
      const send = card(page, SEND);
      await send.getByRole("radio", { name: /Build a new send path/ }).click();
      await expect(send.getByRole("radio", { name: /Build a new send path/ })).toHaveAttribute("aria-checked", "true");
      await send.getByLabel("Note for the next agent (optional)").fill("The checkout team owns it from Nov 16");
      await expect(send.getByText("Goes to Engineering check with this stop's decision.")).toBeVisible();
      await send.getByRole("button", { name: "Save answer" }).click();
      await expect(block(page).getByTestId("agent-questions-count")).toHaveText("2 open · 2 answered");
      const saved = card(page, SEND);
      await expect(saved).toHaveAttribute("data-state", "answered");
      await expect(saved.getByText("Build a new send path")).toBeVisible();
      await expect(saved.getByText("“The checkout team owns it from Nov 16”")).toBeVisible();
      await expect(saved.getByTestId("agent-question-who")).toHaveText("Answered by you · just now");
      await expect(saved.getByTestId("agent-question-reaches")).toHaveText(
        "Goes to Engineering check, the next step, with this stop's decision. Its agent reads it as settled. You can change it until you decide the stop.",
      );
      // Kept: the page read again shows the answer.
      await page.reload();
      await expect(card(page, SEND)).toHaveAttribute("data-state", "answered");
      await expect(card(page, SEND).getByText("Build a new send path")).toBeVisible();
      // Change: the card opens again with the answer picked; the agent's pick saved instead.
      await card(page, SEND).getByRole("button", { name: "Change" }).click();
      const again = card(page, SEND);
      await expect(again).toHaveAttribute("data-state", "open");
      await expect(again.getByRole("radio", { name: /Build a new send path/ })).toHaveAttribute("aria-checked", "true");
      await again.getByRole("radio", { name: /Reuse the order service path/ }).click();
      await again.getByLabel("Note for the next agent (optional)").fill("");
      await again.getByRole("button", { name: "Save answer" }).click();
      await expect(card(page, SEND)).toHaveAttribute("data-state", "answered");
      await expect(card(page, SEND).getByText("(the agent's pick)")).toBeVisible();
    });

    test("a viewer reads the questions but cannot answer them", async ({ page }) => {
      await seeded(page, VIEWER);
      await openReview(page);
      const send = card(page, SEND);
      await expect(send).toBeVisible();
      await expect(send.getByRole("radio", { name: /Build a new send path/ })).toBeDisabled();
      await expect(block(page).getByRole("button", { name: "Save answer" })).toHaveCount(0);
    });

    test("hard case: eleven questions fill the block and the feature table starts below it", async ({ page }) => {
      await seeded(page, APPROVER, "scope-review-questions");
      await openReview(page);
      await expect(block(page).getByTestId("agent-questions-count")).toHaveText("9 open · 2 answered");
      await expect(block(page).locator('[data-testid="agent-question"][data-state="unanswered"]')).toHaveCount(9);
      await expect(card(page, "Placed orders keep the old address").getByTestId("agent-question-who")).toHaveText(/^Answered by Tomás Reyes · Oct 17/);
      await expect(card(page, "most shoppers on phones have exactly one address")).toBeVisible();
      const q = (await block(page).boundingBox())!;
      expect(q.y + q.height).toBeGreaterThan(viewport.height);
      const firstRow = (await page.getByTestId("scope-row").filter({ visible: true }).first().boundingBox())!;
      expect(q.y + q.height).toBeLessThanOrEqual(firstRow.y);
    });
  });
}
