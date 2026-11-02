import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * build-rundecide RD2 b "Separate Approve step": on the Simple PRD page, the run's PRD review
 * waits for its approver with Send back and Approve; approving it (with an optional note) lets
 * the run go on, and approving the PRD comes right after as its own step, "Approve the PRD";
 * then the status by the title reads Approved. Driven through the UI on the mock's "run-review"
 * scenario (a run waiting at its PRD review of usage-alerts v2), desktop and phone.
 *
 * Card run-approve-step: protects = the bar names the run and the version and says approving the
 * PRD is its own step; Approve opens a note and says the PRD is asked next; Approve review turns
 * the bar into "Next stop: approve the PRD" (the review approved by you, Start review still
 * above) while the PRD stays In review; Approve the PRD makes it read Approved; fails_when =
 * approving the review approves the PRD too, the second step is missing, or the status does not
 * change; no_claim = the detailed version page's run review bar (run-review*.spec.ts).
 */

async function open(page: Page) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"] as const);
  await login(page);
  await page.goto("/simple/one-pagers/usage-alerts");
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("approve the run's review, then approve the PRD as its own step", async ({ page }) => {
      await open(page);
      const step = page.getByRole("region", { name: "The run's PRD review" });
      await expect(step).toContainText("Usage alerts plan waits for your review of version 2.");
      await expect(step).toContainText("Approving lets the run go on. Approving the PRD comes right after, as its own step.");
      await expect(step.getByRole("button", { name: "Send back" })).toBeVisible();
      const status = page.getByTestId("one-pager-status");
      await expect(status).toHaveText("In review");
      if (phone) {
        // The buttons wrap under the words.
        const words = (await step.getByText("Usage alerts plan waits for your review").boundingBox())!;
        const approve = (await step.getByRole("button", { name: "Approve", exact: true }).boundingBox())!;
        expect(approve.y).toBeGreaterThan(words.y + words.height - 1);
      }

      await step.getByRole("button", { name: "Approve", exact: true }).click();
      const box = step.getByRole("dialog", { name: "Approve the review" });
      await expect(box).toContainText("This approves the run's review. Next you are asked to approve the PRD.");
      await box.getByRole("textbox", { name: "Note for the run (optional)" }).fill("Good to build from version 2.");
      await box.getByRole("button", { name: "Approve review" }).click();

      await expect(step.getByRole("heading", { name: "Next stop: approve the PRD" })).toBeVisible();
      await expect(step.getByTestId("run-review-approved")).toContainText(/^Run review approved by you \(Avery Stone\) · \w{3} \w{3} \d{1,2}$/);
      await expect(step).toContainText("Approving makes version 2 the PRD everyone builds from. To change it first, use Start review above.");
      // The PRD is not approved by the review: it still reads In review, and Start review stays.
      await expect(status).toHaveText("In review");
      await expect(page.getByRole("button", { name: "Start review" }).first()).toBeAttached();

      await step.getByRole("button", { name: "Approve the PRD" }).click();
      await expect(step).toContainText("You approved the PRD, version 2.");
      await expect(step).toContainText("Second of two steps · Usage alerts plan goes on · Avery Stone ·");
      await expect(status).toHaveCount(0);
      await expect(page.getByTestId("one-pager-meta")).toContainText("Approved");
    });
  });
}
