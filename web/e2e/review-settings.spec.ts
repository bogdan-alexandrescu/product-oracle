import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Document review setup in the UI (#342): the Review settings sheet (decider, mandatory
 * reviewers, required sections, re-review on change), each section's owner, reviewers and
 * due date, and feedback campaigns asked for and closed, all from the document page.
 */

const DOC = "/documents/checkout-redesign";

async function asRole(page: Page, role: "approver" | "commenter" | "viewer") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

test("an owner sets the decider, mandatory reviewers, required sections and re-review, and they stay set", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await expect(sheet).toContainText("Default policy");

  await sheet.getByRole("button", { name: "Choose the decider" }).click();
  await sheet.getByRole("option", { name: /approver@example\.com/ }).click();
  await expect(sheet.getByTestId("decider")).toContainText("Approver");

  await sheet.getByRole("button", { name: "Add a mandatory reviewer" }).click();
  // Only approvers and owners can approve: a commenter is not offered.
  await expect(sheet.getByRole("option", { name: /commenter@example\.com/ })).toHaveCount(0);
  await sheet.getByRole("option", { name: /admin@example\.com/ }).click();
  await expect(sheet.getByTestId("mandatory-reviewers")).toContainText("Admin");

  await sheet.getByRole("checkbox", { name: "2. Problem" }).check();
  await sheet.getByRole("checkbox", { name: /Ask for re-review/ }).uncheck();
  await sheet.getByRole("button", { name: "Save review settings" }).click();
  await expect(sheet).toHaveCount(0);

  // Reopened (and after a reload), the document's own policy shows what was saved.
  await page.reload();
  await page.getByRole("button", { name: "Review settings" }).click();
  await expect(sheet).toContainText("Set for this document");
  await expect(sheet.getByTestId("decider")).toContainText("Approver");
  await expect(sheet.getByTestId("mandatory-reviewers")).toContainText("Admin");
  await expect(sheet.getByRole("checkbox", { name: "2. Problem" })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /Ask for re-review/ })).not.toBeChecked();

  // A decider can be cleared again.
  await sheet.getByRole("button", { name: "Remove Approver" }).click();
  await sheet.getByRole("button", { name: "Save review settings" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "Review settings", exact: true }).click();
  await expect(sheet.getByTestId("decider")).toContainText("Any approver");
});

test("an approver sets a section's owner, reviewers and due date in place", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  const panel = page.getByTestId("section-assignments");
  // Seeded: goal-trace is owned by the signed-in member, due Oct 24.
  const seeded = panel.locator('[data-section-key="goal-trace"]');
  await expect(seeded).toContainText("Owner Admin");
  await expect(seeded).toContainText("Due Oct 24");

  const row = panel.locator('[data-section-key="problem"]');
  await expect(row).toContainText("No owner");
  await row.getByRole("button", { name: "Edit owner and reviewers of 2. Problem" }).click();
  await row.getByRole("button", { name: "Choose the owner" }).click();
  await row.getByRole("option", { name: /commenter@example\.com/ }).click();
  await row.getByRole("button", { name: "Add a reviewer" }).click();
  await row.getByRole("option", { name: /approver@example\.com/ }).click();
  await row.getByLabel("Due date").fill("2026-11-02");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Owner Commenter");
  await expect(row).toContainText("Approver");
  await expect(row).toContainText("Due Nov 2");

  await page.reload();
  await expect(panel.locator('[data-section-key="problem"]')).toContainText("Owner Commenter");
  await expect(panel.locator('[data-section-key="problem"]')).toContainText("Due Nov 2");
});

test("an approver asks for feedback, then closes and reopens the campaign", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  const panel = page.getByTestId("campaigns");
  await expect(panel).toContainText("Company-wide feedback");

  await panel.getByRole("button", { name: "Ask for feedback" }).click();
  await panel.getByLabel("Title").fill("Pilot clinic read-through");
  await panel.getByLabel("Message (optional)").fill("Read the scope and say what is missing.");
  await panel.getByRole("button", { name: "Send" }).click();
  const row = panel.getByRole("listitem").filter({ hasText: "Pilot clinic read-through" });
  await expect(row).toContainText("Open");
  await expect(row).toContainText("v2");

  await row.getByRole("button", { name: "Close Pilot clinic read-through" }).click();
  await expect(row).toContainText("Closed");
  await row.getByRole("button", { name: "Reopen Pilot clinic read-through" }).click();
  await expect(row).toContainText("Open");
});

test("a viewer reads the review setup with no controls they can never use (#370 owner rule)", async ({ page }) => {
  await asRole(page, "viewer");
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  // The policy still reads: the decider, reviewers and required sections as text.
  await expect(sheet.getByTestId("decider")).toContainText("Any approver");
  await expect(sheet.getByTestId("required-sections")).toBeVisible();
  // A viewer can never change it: no controls, no disabled-with-reason.
  await expect(sheet.getByTestId("review-reason")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Save review settings" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Choose the decider" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Add a mandatory reviewer" })).toHaveCount(0);
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close Review settings" }).click();

  const sections = page.getByTestId("section-assignments");
  await expect(sections.locator('[data-section-key="goal-trace"]')).toContainText("Owner Admin");
  await expect(sections.getByTestId("review-reason")).toHaveCount(0);
  await expect(sections.getByRole("button", { name: /^Edit owner and reviewers of / })).toHaveCount(0);
  const campaigns = page.getByTestId("campaigns");
  await expect(campaigns).toContainText("Company-wide feedback");
  await expect(campaigns.getByTestId("review-reason")).toHaveCount(0);
  await expect(campaigns.getByRole("button", { name: "Ask for feedback" })).toHaveCount(0);
  await expect(campaigns.getByRole("button", { name: /^(Close|Reopen) / })).toHaveCount(0);
});

test("an approver can assign sections and run campaigns, and sees the review settings without edit controls", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  await expect(page.getByTestId("section-assignments").getByRole("button", { name: "Edit owner and reviewers of 2. Problem" })).toBeEnabled();
  await expect(page.getByTestId("campaigns").getByRole("button", { name: "Ask for feedback" })).toBeEnabled();
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await expect(sheet.getByTestId("decider")).toContainText("Any approver");
  await expect(sheet.getByTestId("review-reason")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Save review settings" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Choose the decider" })).toHaveCount(0);
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
});

test("phone (390 px): the sheet and both panels fit, and an owner saves from the sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto(DOC);
  await expect(page.getByTestId("section-assignments")).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await sheet.getByRole("checkbox", { name: "4. Scope" }).check();
  const save = sheet.getByRole("button", { name: "Save review settings" });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await save.click();
  await expect(sheet).toHaveCount(0);
  const row = page.getByTestId("section-assignments").locator('[data-section-key="scope"]');
  await expect(row).toContainText("Required");
});

/** WCAG contrast of an element's text against the first opaque background behind it. */
async function textContrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bg: number[] | null = null;
    for (let n: Element | null = el; n && !bg; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) bg = c;
    }
    const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(bg ?? [255, 255, 255])];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme: the sheet, section rows and campaigns read well and an owner saves`, async ({ page }) => {
    // protects=issue #342 "light and dark themes read well"; fails_when=a theme does not apply,
    // logs a console error, or the review setup's text falls below WCAG AA on its background.
    const errors: string[] = [];
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
    await login(page);
    await page.goto(DOC);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const sections = page.getByTestId("section-assignments");
    await expect(sections.locator('[data-section-key="goal-trace"]')).toContainText("Owner Admin");
    await expect(page.getByTestId("campaigns")).toContainText("Company-wide feedback");
    for (const sel of [
      '[data-testid="section-assignments"] [data-section-key="goal-trace"] span.font-semibold',
      '[data-testid="section-assignments"] [data-section-key="problem"] div.text-sm > *',
      '[data-testid="campaigns"] li span.text-sm',
    ]) {
      expect(await textContrast(page, sel), `${theme}: ${sel}`).toBeGreaterThanOrEqual(4.5);
    }

    await page.getByRole("button", { name: "Review settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Review settings" });
    await expect(sheet.getByTestId("decider")).toContainText("Any approver");
    for (const sel of ['[role="dialog"] [data-testid="decider"] span', '[role="dialog"] fieldset label span']) {
      expect(await textContrast(page, sel), `${theme}: ${sel}`).toBeGreaterThanOrEqual(4.5);
    }
    await sheet.getByRole("checkbox", { name: "4. Scope" }).check();
    await sheet.getByRole("button", { name: "Save review settings" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(sections.locator('[data-section-key="scope"]')).toContainText("Required");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(errors).toEqual([]);
  });
}

test("after a 409 on a section's assignment the form shows the other person's change, and Save does not overwrite it", async ({ context, page }) => {
  // protects=issue #342 review fixes 4 item 1; fails_when=after a 409 the form keeps the stale
  // values with the new lock_version, so a second Save silently overwrites the other change.
  await context.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, "approver"] as const);
  await login(page);
  await page.goto(DOC);
  const mine = page.getByTestId("section-assignments").locator('[data-section-key="problem"]');
  await mine.getByRole("button", { name: "Edit owner and reviewers of 2. Problem" }).click();
  await mine.getByRole("button", { name: "Choose the owner" }).click();
  await mine.getByRole("option", { name: /commenter@example\.com/ }).click();

  // Someone else, in another tab, sets the owner first.
  const other = await context.newPage();
  await other.goto(DOC);
  const theirs = other.getByTestId("section-assignments").locator('[data-section-key="problem"]');
  await theirs.getByRole("button", { name: "Edit owner and reviewers of 2. Problem" }).click();
  await theirs.getByRole("button", { name: "Choose the owner" }).click();
  await theirs.getByRole("option", { name: /approver@example\.com/ }).click();
  await theirs.getByRole("button", { name: "Save" }).click();
  await expect(theirs).toContainText("Owner Approver");

  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine).toContainText("Someone else changed this");
  // The form now holds what is saved, and says what changed.
  await expect(mine.getByRole("button", { name: "Remove Approver" })).toBeVisible();
  await expect(mine.getByRole("button", { name: "Remove Commenter" })).toHaveCount(0);
  await expect(mine.getByTestId("assignment-changed")).toContainText("Owner: Approver (was No owner)");

  // Saving again keeps the other person's owner.
  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine).toContainText("Owner Approver");
  await other.reload();
  await expect(other.getByTestId("section-assignments").locator('[data-section-key="problem"]')).toContainText("Owner Approver");
});

test("a double click on Close closes the campaign once, with no conflict", async ({ page }) => {
  // protects=issue #342 review fixes 4 item 2; fails_when=Close/Reopen stays enabled while in
  // flight, so a double click sends a second PATCH with the old lock_version and shows a 409.
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  const panel = page.getByTestId("campaigns");
  const row = panel.getByRole("listitem").filter({ hasText: "Company-wide feedback" });
  await expect(row).toContainText("Open");
  const close = row.getByRole("button", { name: "Close Company-wide feedback" });
  // The button's disabled state is short-lived: note whether it was ever disabled.
  await close.evaluate((el) => {
    const w = window as unknown as { wasDisabled?: boolean };
    w.wasDisabled = false;
    new MutationObserver(() => (w.wasDisabled ||= el.hasAttribute("disabled"))).observe(el, { attributes: true });
  });
  await close.dblclick();
  await expect(row).toContainText("Closed");
  // While the change was in flight the button waited, so the second click sent nothing.
  expect(await page.evaluate(() => (window as unknown as { wasDisabled?: boolean }).wasDisabled)).toBe(true);
  await expect(row.getByRole("button", { name: "Reopen Company-wide feedback" })).toBeEnabled();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("review settings show View only to members who are not owners, and not to owners (#370 owner rule)", async ({ browser }) => {
  // protects=issue #342 review fixes 4 item 3; fails_when=a read-only Review settings sheet has
  // no View only label, or an owner's editable sheet shows one.
  for (const role of ["viewer", "commenter", "approver", null] as const) {
    const page = await browser.newPage();
    if (role) await asRole(page, role);
    await login(page);
    await page.goto(DOC);
    await page.getByRole("button", { name: "Review settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Review settings" });
    await expect(sheet.getByTestId("decider")).toContainText("Any approver");
    await expect(sheet.getByText("View only", { exact: true })).toHaveCount(role ? 1 : 0);
    await page.close();
  }
});
