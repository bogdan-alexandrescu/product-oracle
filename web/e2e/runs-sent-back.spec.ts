import { expect, test, type Page } from "@playwright/test";

import { login, seedSentBack, SENT_BACK_RUN, SENT_BACK_SUMMARY } from "./helpers";

/**
 * A refused draft goes back to the writer before a person is asked (owner, 2026-10-20). While
 * Oracle's own NOT_YET has the revision running, the run reads "Revising: sent back by Oracle",
 * not "Draft rejected", and the Inbox shows that state, not a decision request. A clean
 * revision clears it: the review opens for a person with the draft imported.
 */

const ID = SENT_BACK_RUN;
const SUMMARY = SENT_BACK_SUMMARY;
const REVISING = "Revising: sent back by Oracle";

/** The run's status badge (Next keeps the list page mounted but hidden). */
function status(page: Page) {
  return page.getByTestId("run-status").filter({ visible: true });
}

test("a draft Oracle sent back reads Revising on the run page and the runs list, with nothing to decide", async ({ page }) => {
  await login(page);
  const id = await seedSentBack(page);
  await page.goto(`/runs/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(status(page)).toHaveText("Running");

  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd.getByTestId("segment-state")).toHaveText(REVISING);
  await expect(prd).not.toContainText("Draft rejected");
  await expect(prd).toContainText("attempt 2");
  // What Oracle refused, as context: the same summary, its problems behind the disclosure.
  const sentBack = prd.getByTestId("draft-sent-back");
  await expect(sentBack.getByTestId("draft-sent-back-summary")).toHaveText(SUMMARY);
  await expect(sentBack).toContainText("Oracle sent the draft back to the writer");
  await expect(prd.getByTestId("draft-rejected")).toHaveCount(0);
  await sentBack.getByRole("button", { name: "Show all 5 problems" }).click();
  await expect(sentBack.getByTestId("draft-problems").getByRole("listitem")).toHaveCount(5);
  // Nothing to decide or retry: no checkpoint waits, no Retry import, no Send back to writer.
  await expect(prd.getByTestId("checkpoint-waiting")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decide", exact: true })).toHaveCount(0);
  await expect(prd.getByRole("button", { name: "Retry import" })).toHaveCount(0);
  await expect(prd.getByRole("button", { name: "Send back to writer" })).toHaveCount(0);

  // The runs list says Revising too, with the summary on hover, and no Draft rejected.
  await page.getByTestId("nav-runs").click();
  const row = page.getByTestId("run-row").filter({ hasText: "guest-checkout" });
  await expect(row.getByTestId("run-sent-back")).toHaveText("Revising");
  await expect(row.getByTestId("run-sent-back")).toHaveAttribute("title", `${REVISING}. ${SUMMARY}`);
  await expect(row.getByTestId("run-draft-rejected")).toHaveCount(0);
});

test("the Inbox shows a draft Oracle sent back as Revising, not a decision, and does not count it", async ({ page }) => {
  await login(page);
  await seedSentBack(page);
  await page.goto("/inbox");
  const tabs = page.getByTestId("inbox-state-tabs");
  // The seed's 10 waiting, unchanged: nothing of this run asks for a decision.
  await expect(page.getByText("10 waiting").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("10");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveText("New10");
  await expect(page.getByTestId("inbox-checkpoints")).not.toContainText("guest-checkout");
  await expect(page.getByTestId("inbox-revising")).toHaveCount(0);

  // Under Open, shown and not counted, as the run page shows it.
  await tabs.getByRole("tab", { name: /^Open/ }).click();
  await expect(tabs.getByRole("tab", { name: /^Open/ })).toHaveText("Open0");
  const revising = page.getByTestId("inbox-revising");
  await expect(revising.locator("tr[data-row]")).toHaveCount(1);
  const item = revising.getByTestId("inbox-revising-state");
  await expect(item).toHaveText(REVISING);
  await expect(item).toHaveAttribute("title", SUMMARY);
  await expect(revising).toContainText("guest-checkout");
  await expect(revising.getByRole("button")).toHaveCount(0);
  await revising.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${ID}$`));
  await expect(page.getByTestId("segment-prd_draft").getByTestId("segment-state")).toHaveText(REVISING);
});

test("a clean revision clears Revising: the draft is imported and the review waits for a person", async ({ page }) => {
  await login(page);
  const id = await seedSentBack(page);
  await page.goto(`/runs/${id}`);
  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd.getByTestId("segment-state")).toHaveText(REVISING);

  // The writer's revision finishes; Oracle imports it as the review opens.
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(prd).toContainText("Imported as guest-checkout v1");
  await expect(prd.getByTestId("segment-state")).toHaveText("Succeeded");
  await expect(prd.getByTestId("draft-sent-back")).toHaveCount(0);
  await expect(prd).not.toContainText("Revising");
  await expect(status(page)).toHaveText("Waiting for review");
  const review = prd.getByTestId("checkpoint-prd_review");
  await expect(prd.getByTestId("checkpoint-waiting")).toBeVisible();
  await expect(review.getByRole("button", { name: "Approve and continue" })).toBeEnabled();
  await expect(review.getByTestId("cannot-approve")).toHaveCount(0);

  // The Inbox: the review is a decision now, counted; the Revising row is gone.
  await page.goto("/inbox");
  await expect(page.getByText("11 waiting").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("inbox-checkpoints")).toContainText("guest-checkout");
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Open/ }).click();
  await expect(page.getByTestId("inbox-revising")).toHaveCount(0);

  // The runs list: neither Revising nor Draft rejected.
  await page.getByTestId("nav-runs").click();
  const row = page.getByTestId("run-row").filter({ hasText: "guest-checkout" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("run-sent-back")).toHaveCount(0);
  await expect(row.getByTestId("run-draft-rejected")).toHaveCount(0);
});

for (const [name, width, height] of [["desktop", 1366, 820], ["phone", 390, 844]] as const) {
  test(`the Revising state chip wraps inside its column and clears the checkpoint chip (${name})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await login(page);
    const id = await seedSentBack(page);
    await page.goto(`/runs/${id}`);
    const prd = page.getByTestId("segment-prd_draft");
    const state = prd.getByTestId("segment-state").locator("xpath=..");
    const checkpoint = prd.getByTestId("segment-checkpoint");
    await expect(state).toBeVisible();
    await expect(checkpoint).toBeVisible();
    const a = (await state.boundingBox())!;
    const b = (await checkpoint.boundingBox())!;
    const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
    expect(apart, `state ${JSON.stringify(a)} overlaps checkpoint ${JSON.stringify(b)}`).toBe(true);
    // The chip holds its own text: its width never exceeds its grid cell, so nothing spills.
    const cell = (await state.locator("xpath=..").boundingBox())!;
    expect(a.x + a.width).toBeLessThanOrEqual(cell.x + cell.width + 0.5);
    if (width > 600) expect(a.height).toBeGreaterThan(26);
  });
}
