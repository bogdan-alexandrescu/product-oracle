import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * #341 Edit a proposed decision, driven through the UI on the mock layer. The mock seeds
 * D-5 "Ship usage caps before anomaly detection", proposed by the commenter for the approver,
 * and D-4 "Price the team plan per seat", decided. Each test states its card:
 * protects / fails_when / no_claim.
 */

const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";
const CAPS = "Ship usage caps before anomaly detection";

const row = (page: Page, text: string) => page.getByTestId("decision-row").filter({ hasText: text });
const inspector = (page: Page) => page.getByTestId("decision-inspector").filter({ visible: true });
const chip = (page: Page, name: string) => page.getByRole("group", { name: "State" }).getByRole("button", { name: new RegExp(`^${name}`) });
const dayAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function openCaps(page: Page) {
  await page.goto("/company/decisions");
  await chip(page, "All").click();
  await row(page, CAPS).click();
  await expect(inspector(page)).toContainText("Do caps wait for detection?");
}

test("the creator edits every field of a proposal; the inspector and a reload show the changes", async ({ page }) => {
  // protects=Edit on a proposed decision opens a form filled from the decision; saving sends
  // the title, question, context, options, reversibility, people, review date, expected
  // outcome and prediction, and the inspector reads them back; fails_when=a field is not
  // saved, an existing option loses its Oracle recommendation, or the change is lost on
  // reload; no_claim=the mock stands in for PATCH /v1/decisions/{decision} (pytest covers it).
  await login(page, COMMENTER);
  await openCaps(page);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(form.getByLabel("Decision", { exact: true })).toHaveValue(CAPS);
  await expect(form.getByLabel("Option 2", { exact: true })).toHaveValue("Ship together");

  await form.getByLabel("Decision", { exact: true }).fill("Ship usage caps in the next sprint");
  await form.getByLabel("Question").fill("Do caps wait for anomaly detection?");
  await form.getByLabel("Context").fill("Finance asks for caps first.");
  await form.getByLabel("Option 2", { exact: true }).fill("Ship both together");
  await form.getByRole("button", { name: "Add option" }).click();
  await form.getByLabel("Option 3", { exact: true }).fill("Caps for new plans only");
  await form.getByLabel("Option 3 cons").fill("Two price lists");
  await form.getByLabel("Reversibility").selectOption("irreversible");
  await form.getByRole("group", { name: "Informed" }).getByLabel("approver@example.com").check();
  await form.getByLabel("Review date").fill(dayAhead(30));
  await form.getByLabel("Expected outcome").fill("Spend incidents drop below 2 a month");
  await form.getByLabel("Goal").selectOption({ label: "Cut early churn" });
  await form.getByLabel("Metric").fill("spend incidents per month");
  await form.getByLabel("Baseline").fill("6");
  await form.getByLabel("Predicted").fill("2");
  await form.getByRole("button", { name: "Save changes" }).click();

  await expect(form).toHaveCount(0);
  const ins = inspector(page);
  await expect(ins).toContainText("Ship usage caps in the next sprint");
  await expect(ins).toContainText("Do caps wait for anomaly detection?");
  await expect(ins).toContainText("Finance asks for caps first.");
  await expect(ins.getByTestId("decision-option").filter({ hasText: "Caps first" })).toContainText("Oracle recommends");
  await expect(ins.getByTestId("decision-option").filter({ hasText: "Ship both together" })).toBeVisible();
  await expect(ins.getByTestId("decision-option").filter({ hasText: "Caps for new plans only" })).toContainText("Two price lists");
  await expect(ins).toContainText("Hard to reverse");
  await expect(ins).toContainText("Spend incidents drop below 2 a month");
  await expect(ins).toContainText("spend incidents per month: 6 → 2");
  await expect(ins).toContainText(/Informed[^]*approver@example\.com/);

  await page.reload();
  await chip(page, "All").click();
  await row(page, "Ship usage caps in the next sprint").click();
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const again = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(again.getByLabel("Review date")).toHaveValue(dayAhead(30));
  await expect(again.getByLabel("Goal")).toHaveValue(/.+/);
  await expect(again.getByLabel("Option 3", { exact: true })).toHaveValue("Caps for new plans only");
});

test("a stale save shows the conflict message and keeps the form", async ({ browser }) => {
  // protects=a save on a decision someone changed since the form opened is refused with
  // "Someone else changed this since you loaded it; reload and try again" and the typed
  // edit stays on screen; fails_when=the stale save overwrites the other change or the form
  // closes silently; no_claim=two tabs of one browser share the mock's data, standing in for
  // two people.
  const context = await browser.newContext();
  const first = await context.newPage();
  await login(first, COMMENTER);
  await openCaps(first);
  const second = await context.newPage();
  await inspector(first).getByRole("button", { name: "Edit", exact: true }).click();
  const stale = inspector(first).getByRole("form", { name: "Edit decision" });
  await stale.getByLabel("Decision", { exact: true }).fill("A stale title");

  // The second tab shares the browser's sign-in: the same commenter, in another tab.
  await openCaps(second);
  await inspector(second).getByRole("button", { name: "Edit", exact: true }).click();
  const fresh = inspector(second).getByRole("form", { name: "Edit decision" });
  await fresh.getByLabel("Decision", { exact: true }).fill("The fresh title");
  await fresh.getByRole("button", { name: "Save changes" }).click();
  await expect(inspector(second)).toContainText("The fresh title");

  await stale.getByRole("button", { name: "Save changes" }).click();
  await expect(stale).toContainText("Someone else changed this since you loaded it; reload and try again");
  await expect(stale.getByLabel("Decision", { exact: true })).toHaveValue("A stale title");
  await second.reload();
  await chip(second, "All").click();
  await expect(row(second, "The fresh title")).toBeVisible();
  await context.close();
});

test("viewers see no Edit (#370); a decided decision has no Edit", async ({ page }) => {
  // protects=a viewer, who can never edit, is not shown the Edit control (#370: hidden, not
  // disabled); a decided decision offers no Edit (it is revisited instead); fails_when=a
  // viewer sees Edit or can open the form, or Edit shows on a decided call; no_claim=the
  // API's 403 and 409 are pytest's.
  await login(page, VIEWER);
  await openCaps(page);
  await expect(inspector(page).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await row(page, "Price the team plan per seat").click();
  await expect(inspector(page)).toContainText("Per seat or per company?");
  await expect(inspector(page).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
});

test("phone: the edit form fits 390 px in light and dark and saves", async ({ page }) => {
  // protects=at 390 px the edit form never scrolls sideways, in both themes, and a save
  // works; fails_when=a field or the option rows overflow the screen; no_claim=colours are
  // checked by eye on the screenshots, not measured.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, COMMENTER);
  await openCaps(page);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(form).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const shots = process.env.SWARM_ARTIFACTS_DIR ? `${process.env.SWARM_ARTIFACTS_DIR}/screens/after` : null;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const box = await form.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    if (shots) {
      await form.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/decision-edit-390-${theme}.png` });
    }
  }
  await form.getByLabel("Question").fill("Do caps wait for anomaly detection?");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(inspector(page)).toContainText("Do caps wait for anomaly detection?");
});
