import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login, signOut } from "./helpers";

/*
 * H1 follow-ups (#193): pickers for the evidence, linked baseline items and subjects of a
 * decision when proposing or editing it, and the outcome status in the inspector's
 * Expected. The mock seeds D-5 "Ship usage caps before anomaly detection", proposed by the
 * commenter for the approver, and the baseline's "Guided setup" feature with its evidence.
 * Each test states its card: protects / fails_when / no_claim.
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const CAPS = "Ship usage caps before anomaly detection";
const STALL = "New accounts stall before adding a payment method";

const row = (page: Page, text: string) => page.getByTestId("decision-row").filter({ hasText: text });
const inspector = (page: Page) => page.getByTestId("decision-inspector").filter({ visible: true });
const chip = (page: Page, name: string) => page.getByRole("group", { name: "State" }).getByRole("button", { name: new RegExp(`^${name}`) });

async function openCaps(page: Page) {
  await page.goto("/company/decisions");
  await chip(page, "All").click();
  await row(page, CAPS).click();
  await expect(inspector(page)).toContainText("Do caps wait for detection?");
}

test("a proposal names the baseline items, evidence and document it is about; the inspector reads them back", async ({ page }) => {
  // protects=Propose decision offers a linked-item search, the linked items' evidence to
  // tick and an About picker; the new decision's inspector shows each by name, with links,
  // after a reload too; fails_when=the pickers send nothing (evidence_ids and entity_ids
  // empty), evidence of an unlinked item is offered, or the inspector shows ids;
  // no_claim=the mock stands in for POST /v1/decisions (pytest covers the API's read-back).
  await login(page, COMMENTER);
  await page.goto("/company/decisions");
  await page.getByRole("button", { name: "Propose decision" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  await dialog.getByLabel("Decision", { exact: true }).fill("Point new accounts to payment setup first");
  await dialog.getByLabel("Option 1", { exact: true }).fill("Checklist first");
  await dialog.getByLabel("Option 2", { exact: true }).fill("Sample data first");
  await dialog.getByLabel("Approver", { exact: true }).selectOption({ label: APPROVER });

  const evidence = dialog.getByRole("group", { name: "Evidence" });
  await expect(evidence).toContainText("Link a baseline item to pick from its evidence");
  const linked = dialog.getByRole("group", { name: "Linked items" });
  await linked.getByLabel("Find an item to link").fill("guided");
  await linked.getByRole("button", { name: /^Guided setup · Feature/ }).click();
  await expect(linked.getByRole("button", { name: "Remove Guided setup" })).toBeVisible();
  await linked.getByLabel("Find an item to link").fill("churn");
  await linked.getByRole("button", { name: /^Cut early churn · Goal/ }).click();
  await evidence.getByRole("checkbox", { name: new RegExp(STALL) }).check();
  // Removing an item drops it and leaves the others.
  await linked.getByRole("button", { name: "Remove Cut early churn" }).click();
  await expect(linked.getByRole("button", { name: "Remove Cut early churn" })).toHaveCount(0);

  const about = dialog.getByRole("group", { name: "About" });
  await about.getByLabel("Kind", { exact: true }).selectOption({ label: "Document" });
  await about.getByLabel("Item", { exact: true }).selectOption({ label: "Checkout redesign PRD" });
  await about.getByRole("button", { name: "Add", exact: true }).click();
  await expect(about.getByRole("button", { name: "Remove Document checkout-redesign" })).toBeVisible();
  await dialog.getByRole("button", { name: "Propose" }).click();
  await expect(dialog).toHaveCount(0);

  for (const pass of ["new", "reloaded"]) {
    if (pass === "reloaded") await page.reload();
    const ins = inspector(page);
    await expect(ins).toContainText("Point new accounts to payment setup first");
    const restsOn = ins.getByTestId("decision-rests-on");
    await expect(restsOn.getByRole("link", { name: "Guided setup" })).toHaveAttribute("href", /\/baseline\?entity=/);
    await expect(restsOn).not.toContainText("Cut early churn");
    await expect(restsOn.getByTestId("decision-evidence")).toHaveCount(1);
    await expect(restsOn.getByTestId("decision-evidence")).toContainText(STALL);
    await expect(ins.getByRole("link", { name: "Document checkout-redesign" })).toHaveAttribute("href", "/documents/checkout-redesign");
  }
});

test("editing a proposal changes its linked items, evidence and subjects", async ({ page }) => {
  // protects=the Edit form opens with the decision's linked items, evidence and subjects and
  // saves the changed ones; fails_when=the form drops what the decision had, or PATCH keeps
  // the old lists; no_claim=the mock stands in for PATCH /v1/decisions/{decision}.
  await login(page, COMMENTER);
  await openCaps(page);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  const linked = form.getByRole("group", { name: "Linked items" });
  await linked.getByLabel("Find an item to link").fill("guided");
  await linked.getByRole("button", { name: /^Guided setup · Feature/ }).click();
  await form.getByRole("group", { name: "Evidence" }).getByRole("checkbox", { name: new RegExp(STALL) }).check();
  const about = form.getByRole("group", { name: "About" });
  await about.getByLabel("Kind", { exact: true }).selectOption({ label: "Baseline item" });
  await about.getByLabel("Item", { exact: true }).selectOption({ label: "Guided setup" });
  await about.getByRole("button", { name: "Add", exact: true }).click();
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector(page).getByTestId("decision-evidence")).toContainText(STALL);
  await expect(inspector(page).getByRole("link", { name: "Baseline item Guided setup" })).toBeVisible();

  // Edit again: the form holds what was saved; unticking and removing clears them.
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const again = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(again.getByRole("group", { name: "Linked items" }).getByRole("button", { name: "Remove Guided setup" })).toBeVisible();
  await again.getByRole("group", { name: "Evidence" }).getByRole("checkbox", { name: new RegExp(STALL) }).uncheck();
  await again.getByRole("group", { name: "About" }).getByRole("button", { name: "Remove Baseline item Guided setup" }).click();
  await again.getByRole("button", { name: "Save changes" }).click();
  await expect(again).toHaveCount(0);
  await page.reload();
  await expect(inspector(page).getByRole("link", { name: "Guided setup" })).toBeVisible();
  await expect(inspector(page).getByTestId("decision-evidence")).toHaveCount(0);
  await expect(inspector(page).getByRole("link", { name: "Baseline item Guided setup" })).toHaveCount(0);
});

test("a decision with a prediction shows its outcome's status under Expected and opens it in Outcomes", async ({ page }) => {
  // protects=after the approver decides a proposal that carries a prediction, the
  // inspector's Expected reads the outcome record's status (Measuring) with a link to the
  // record in Outcomes; fails_when=no status shows, or the link opens another record;
  // no_claim=status changes after an assessment are covered by pytest (the mock seeds no
  // goal values to assess).
  await login(page, APPROVER);
  await openCaps(page);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  await form.getByLabel("Goal").selectOption({ label: "Cut early churn" });
  await form.getByLabel("Metric").fill("spend incidents per month");
  await form.getByLabel("Baseline").fill("6");
  await form.getByLabel("Predicted").fill("2");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector(page).getByTestId("decision-outcome")).toHaveCount(0);

  await inspector(page).getByRole("button", { name: "Decide" }).click();
  const decide = inspector(page).getByRole("form", { name: "Decide" });
  await decide.getByRole("radio", { name: "Caps first" }).check();
  await decide.getByLabel("Why").fill("Caps alone meet the goal.");
  await decide.getByLabel("Expected outcome").fill("Spend incidents drop below 2 a month");
  await decide.getByRole("button", { name: "Record decision" }).click();

  const outcome = inspector(page).getByTestId("decision-outcome");
  await expect(outcome).toContainText("Outcome");
  await expect(outcome).toContainText("Measuring");
  await outcome.getByRole("link", { name: "Open in Outcomes" }).click();
  await expect(page).toHaveURL(/\/plan\/outcomes\?outcome=/);
  await expect(page.getByTestId("outcome-inspector").filter({ visible: true })).toContainText(CAPS);
});

// #570 review: Edit sends the linked items and evidence back, so one that is gone since, or
// one the editor may not see, must neither block the save nor be dropped by it.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const PRICING = "Price: Should the Starter plan cost less for teams under 5 seats?";

async function editTitle(page: Page, title: string) {
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  await form.getByLabel("Decision", { exact: true }).fill(title);
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector(page)).toContainText(title);
}

test("a title-only edit saves after evidence the decision rests on is removed from the baseline", async ({ page }) => {
  // protects=once an approver removes, in the baseline drawer, evidence a proposal rests on,
  // Edit still saves and neither the inspector nor the form shows the gone evidence or an
  // id; fails_when=Save is refused with "unknown evidence_ids: <id>" (the form cannot show,
  // so cannot untick, the gone row); no_claim=a deleted baseline item (the web has no
  // Delete for items; pytest covers it), the mock stands in for the API.
  await login(page, APPROVER);
  await openCaps(page);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  await form.getByRole("group", { name: "Linked items" }).getByLabel("Find an item to link").fill("guided");
  await form.getByRole("group", { name: "Linked items" }).getByRole("button", { name: /^Guided setup · Feature/ }).click();
  await form.getByRole("group", { name: "Evidence" }).getByRole("checkbox", { name: new RegExp(STALL) }).check();
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector(page).getByTestId("decision-evidence")).toContainText(STALL);

  await page.goto("/baseline");
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  const drawer = page.getByRole("dialog", { name: "Guided setup" });
  await drawer.getByRole("list", { name: "Evidence" }).getByRole("button", { name: "Remove example-org/storefront#128" }).click();
  const ask = drawer.getByRole("form", { name: "Remove evidence" });
  await ask.getByLabel("Reason").fill("Cited on the wrong feature.");
  await ask.getByRole("button", { name: "Remove" }).click();
  await expect(drawer.getByRole("status")).toContainText("Removed");

  await openCaps(page);
  await expect(inspector(page).getByTestId("decision-evidence")).toHaveCount(0);
  await editTitle(page, `${CAPS}, revised`);
  await expect(inspector(page)).not.toContainText(UUID);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const again = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(again.getByRole("group", { name: "Evidence" })).not.toContainText(STALL);
  await expect(again).not.toContainText(UUID);
});

test("a commenter's edit keeps a linked item only approvers may see, and never shows it to them", async ({ page }) => {
  // protects=an approver links D-5 to a pricing decision's baseline item (owners and
  // approvers only); the commenter who proposed D-5 sees no chip, title or id for it in the
  // inspector or the Edit pickers, saves a title-only edit, and the approver still reads the
  // link afterwards; fails_when=the commenter's save is refused ("unknown entity_ids"),
  // drops the link, or shows "A baseline item"/the item to the commenter; no_claim=the
  // mock stands in for the API's visibility rule (pytest covers the API's).
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "pricing"]);
  await login(page, APPROVER);
  await openCaps(page);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  const linked = form.getByRole("group", { name: "Linked items" });
  await linked.getByLabel("Find an item to link").fill("starter plan");
  await linked.getByRole("button", { name: new RegExp(`^${PRICING.replace(/[?]/g, "\\?")} · Decision`) }).click();
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector(page).getByTestId("decision-rests-on").getByRole("link", { name: PRICING })).toBeVisible();

  await signOut(page);
  await login(page, COMMENTER);
  await openCaps(page);
  await expect(inspector(page).getByTestId("decision-rests-on")).toHaveCount(0);
  await expect(inspector(page)).not.toContainText(PRICING);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const mine = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(mine.getByRole("group", { name: "Linked items" })).not.toContainText("A baseline item");
  await expect(mine).not.toContainText(PRICING);
  await mine.getByRole("group", { name: "Linked items" }).getByLabel("Find an item to link").fill("starter plan");
  await expect(mine.getByRole("group", { name: "Linked items" })).toContainText("No baseline item matches");
  await mine.getByRole("button", { name: "Cancel" }).click();
  await editTitle(page, `${CAPS}, revised`);
  await expect(inspector(page)).not.toContainText(UUID);

  await signOut(page);
  await login(page, APPROVER);
  await openCaps(page);
  await expect(inspector(page)).toContainText(`${CAPS}, revised`);
  await expect(inspector(page).getByTestId("decision-rests-on").getByRole("link", { name: PRICING })).toBeVisible();
});
