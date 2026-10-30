import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * QA pass 2, docs lane, on the mock API: a spec's design review (/specs/<id>/design/<versionId>)
 * and a brief before drafting (/intakes/<id>), driven through the UI as a person would.
 */

const BRIEF = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";

const inspector = (page: Page) => page.getByRole("complementary", { name: "Design review" }).filter({ visible: true });

/** Checkout redesign PRD → its tech brief → the design "Early shipping cost: user flows". */
async function openFlow(page: Page) {
  await page.goto(BRIEF);
  await page.getByTestId("spec-design").filter({ visible: true }).getByRole("link", { name: /Early shipping cost: user flows/ }).click();
  await expect(page).toHaveURL(/\/specs\/[^/]+\/design\/[^/]+$/);
}

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-11: Comment is off until something is written, with a hint (${scheme})`, async ({ page }) => {
    // qa-docs-11: an empty comment was sent and came back as the server's raw words.
    await page.emulateMedia({ colorScheme: scheme });
    await login(page, "commenter@example.com");
    await openFlow(page);
    const first = inspector(page).getByTestId("annotations").getByTestId("annotation").first();
    const comment = first.getByRole("button", { name: "Comment" });
    await expect(comment).toBeDisabled();
    await expect(first.getByText("Write a comment first")).toBeVisible();
    await expect(first.getByRole("alert")).toHaveCount(0);

    // Spaces are not a comment either.
    await first.getByLabel("Comment on annotation 1").fill("   ");
    await expect(comment).toBeDisabled();

    await first.getByLabel("Comment on annotation 1").fill("Is a 'from' price enough before the postcode?");
    await expect(comment).toBeEnabled();
    await expect(first.getByText("Write a comment first")).toHaveCount(0);
    await comment.click();
    await expect(first).toContainText("Is a 'from' price enough before the postcode?");
    await expect(page.getByText("a comment needs a body")).toHaveCount(0);
  });
}

test("qa-docs-32: the annotations filter reads 'Without comments'", async ({ page }) => {
  // qa-docs-32: the chip read "No comments 2".
  await login(page, "commenter@example.com");
  await openFlow(page);
  const notes = inspector(page).getByTestId("annotations");
  await expect(notes.getByRole("button", { name: "Without comments 2" })).toBeVisible();
  await expect(notes.getByRole("button", { name: /^No comments/ })).toHaveCount(0);
  await notes.getByRole("button", { name: "Without comments 2" }).click();
  await expect(notes.getByRole("button", { name: "Without comments 2" })).toHaveAttribute("aria-pressed", "true");
});

test("qa-docs-23: an open critical question is answered in one place; the summary takes you to it", async ({ page }) => {
  // qa-docs-23: each open critical question had an Answer in the thread and again in the side summary.
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "before-drafting");
    localStorage.setItem("po-interview-follow-up", "off");
  });
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByTestId("intake-thread")).toBeVisible();
  const panel = page.getByTestId("intake-inspector").filter({ visible: true });
  const gate = panel.getByTestId("ready-to-draft");

  // Decide the blocker: the critical questions stay open, listed in the summary.
  await gate.getByRole("button", { name: "Decide" }).click();
  await gate.getByRole("radio", { name: "Accept the risk" }).check();
  await gate.getByLabel("Rationale").fill("We ship behind the limit and watch it.");
  await gate.getByRole("button", { name: "Record decision" }).click();
  await expect(gate.getByTestId("missing-gap").first()).toBeVisible();

  // The summary has no Answer of its own: it takes you to the question.
  await expect(panel.getByRole("button", { name: /^Answer/ })).toHaveCount(0);
  const go = gate.getByRole("button", { name: /^Go to question: / }).first();
  await expect(go).toHaveText("Go to question");
  await page.getByRole("tab", { name: /Gaps/ }).click();
  await go.click();
  await expect(page.getByRole("tab", { name: "Questions" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="question"]:focus, [data-testid="question"]:has(:focus)')).toBeInViewport();
});
