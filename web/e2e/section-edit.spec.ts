import { expect, test, type Page } from "@playwright/test";

import { login, openSection, section } from "./helpers";

// #347: people type into PRD sections by hand, and review the agent rewrites held because
// their section was approved (Accept or Reject, with a reason).

const DOC = "/documents/checkout-redesign/v/2";
const NEW_TEXT = "Buyers leave checkout when shipping cost appears late [c:c1]. Show the full total on the cart.";

async function openEditor(page: Page, key: string, heading: string) {
  const s = await openSection(page, key);
  await s.getByRole("button", { name: `Actions for ${heading}` }).click();
  await s.getByRole("menuitem", { name: `Edit section ${heading}` }).click();
  const editor = s.getByTestId("section-editor");
  await expect(editor).toBeVisible();
  return { s, editor };
}

test("edit a section by hand: the preview keeps citation chips, Save makes the next version and asks for re-review", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  // Approve the section first: a change to it then asks for re-review (the default policy).
  const problem = await openSection(page, "problem");
  const bar = problem.getByTestId("review-bar");
  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");

  const chips = await problem.locator("[data-section-body]").getByRole("button", { name: /^Citation/ }).count();
  expect(chips).toBeGreaterThan(1);
  const { editor } = await openEditor(page, "problem", "2. Problem");
  const text = editor.getByLabel("Section text (markdown)");
  await expect(text).toHaveValue(/Buyers leave checkout when the total changes late/);
  const preview = editor.getByTestId("section-edit-preview");
  await expect(preview.getByRole("button", { name: /^Citation/ })).toHaveCount(chips);

  await text.fill(NEW_TEXT);
  await expect(preview).toContainText("Show the full total on the cart.");
  await expect(preview.getByRole("button", { name: /^Citation/ })).toHaveCount(1);
  await editor.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(/\/v\/3#problem$/);
  const saved = section(page, "problem");
  await expect(saved).toContainText("Show the full total on the cart.");
  await expect(saved.getByTestId("section-editor")).toHaveCount(0);
  await expect(saved.getByTestId("rereview-chip")).toHaveText("Re-review requested");
});

test("a save on a section that changed meanwhile is refused with Reload", async ({ page, context }) => {
  await login(page);
  await page.goto(DOC);
  const { editor } = await openEditor(page, "scope", "4. Scope");

  // Someone else saves the same section in another tab.
  const other = await context.newPage();
  await other.goto(DOC);
  const { editor: otherEditor } = await openEditor(other, "scope", "4. Scope");
  await otherEditor.getByLabel("Section text (markdown)").fill("In scope: the cart summary only.");
  await otherEditor.getByRole("button", { name: "Save" }).click();
  await expect(other).toHaveURL(/\/v\/3#scope$/);
  await other.close();

  await editor.getByLabel("Section text (markdown)").fill("In scope: the shipping step only.");
  await editor.getByRole("button", { name: "Save" }).click();
  const refused = editor.getByTestId("section-edit-conflict");
  await expect(refused).toContainText("Nothing was saved");
  await refused.getByRole("button", { name: "Reload" }).click();
  await expect(editor.getByLabel("Section text (markdown)")).toHaveValue("In scope: the cart summary only.");
  await expect(refused).toHaveCount(0);
  await editor.getByLabel("Section text (markdown)").fill("In scope: the cart summary and the shipping step.");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/v\/4#scope$/);
  await expect(section(page, "scope")).toContainText("the cart summary and the shipping step.");
});

test("held rewrites: a badge counts them; Accept applies the rewrite as the next version", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  const open = page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true });
  await expect(open.getByTestId("held-count")).toHaveText("1");
  await open.click();
  const panel = page.getByTestId("held-rewrites").filter({ visible: true });
  const item = panel.getByTestId("held-rewrite");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("1. Goal trace");
  await expect(item).toContainText("the approved text was kept");
  await expect(item.locator("ins")).toContainText(["An", "agent", "proposed"]);
  await item.getByLabel("Reason").fill("Reads better with the added sentence.");
  await item.getByRole("button", { name: "Accept" }).click();

  await expect(page).toHaveURL(/\/v\/3#goal-trace$/);
  await expect(section(page, "goal-trace")).toContainText("An agent proposed this added sentence.");
  await expect(page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).getByTestId("held-count")).toHaveCount(0);
});

test("held rewrites: Reject keeps the approved text and shows the reason", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).click();
  const panel = page.getByTestId("held-rewrites").filter({ visible: true });
  const item = panel.getByTestId("held-rewrite");
  await item.getByLabel("Reason").fill("The goal trace says enough already.");
  await item.getByRole("button", { name: "Reject" }).click();

  await expect(item).toContainText("Rejected");
  await expect(item).toContainText("The goal trace says enough already.");
  await expect(item.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).getByTestId("held-count")).toHaveCount(0);
  await expect(page).toHaveURL(/\/v\/2/);
  const goal = await openSection(page, "goal-trace");
  await expect(goal).not.toContainText("An agent proposed this added sentence.");
});
