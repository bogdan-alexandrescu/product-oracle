import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA findings on Requests (qa-onboarding-1, qa-onboarding-9, rirs-9 … rirs-40): the New request
 * dialog, the header's triage control, the queue's rows, the To decide address and an
 * interview's page, driven through the UI on the mock API, at desktop and phone width.
 */

const PHONE = { width: 390, height: 844 };

/** From the rail, as a person gets there. */
async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
}

const rows = (page: Page) => page.getByTestId("request-row");
const tab = (page: Page, id: "all" | "new" | "themes" | "interviews") => page.getByTestId(`requests-tab-${id}`).filter({ visible: true });

test("qa-onboarding-1, qa-onboarding-50: New request asks before Escape or Cancel throws typed work away", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill("Export invoices as a spreadsheet");
  await dialog.getByLabel("What it is and why").fill("Finance copies every invoice by hand each month.");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Title")).toHaveValue("Export invoices as a spreadsheet");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toHaveCount(0);

  // Nothing typed: Cancel closes at once.
  await page.getByRole("button", { name: "New request" }).first().click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("rirs-34: filing an empty request says so under Title, which takes focus", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByRole("button", { name: "File request" }).click();
  const title = dialog.getByLabel("Title");
  await expect(dialog.getByTestId("new-request-title-note")).toHaveText("Give the request a title");
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute("aria-describedby", "new-request-title-note");
  // The note sits right under the field, not at the foot of the dialog.
  const field = (await title.boundingBox())!;
  const note = (await dialog.getByTestId("new-request-title-note").boundingBox())!;
  expect(note.y - (field.y + field.height)).toBeLessThan(24);
  await title.fill("Export invoices");
  await expect(title).not.toHaveAttribute("aria-invalid", "true");
});

test("qa-onboarding-9: the daily triage time is in the company's time zone, 12-hour", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await page.getByTestId("triage-menu").click();
  await expect(page.getByRole("switch", { name: /^Auto-sort new requests daily at 7:00 AM PT/ })).toBeVisible();

  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption("Europe/Berlin");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");

  await page.goto("/home");
  await openRequests(page);
  await page.getByTestId("triage-menu").click();
  await expect(page.getByRole("switch", { name: /^Auto-sort new requests daily at 7:00 AM Berlin time/ })).toBeVisible();
});

test("rirs-35: the header holds one Auto-sort control and two primary actions", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const actions = page.getByTestId("requests-actions");
  await expect(actions.getByRole("button", { name: "Auto-sort: Off" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Interview a customer" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "New request" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Sort now", exact: true })).toHaveCount(0);
  await expect(actions.getByRole("switch")).toHaveCount(0);

  await page.getByTestId("triage-menu").click();
  const panel = page.getByTestId("triage-menu-panel");
  await expect(panel.getByRole("switch", { name: /^Auto-sort new requests daily/ })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sort now", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("rirs-32: a box that cannot be ticked says which requests can be", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const fresh = rows(page).filter({ has: page.getByText("New", { exact: true }) }).first();
  const box = fresh.getByTestId("request-choose").getByRole("checkbox");
  await expect(box).toBeDisabled();
  await expect(box).toHaveAttribute("title", /Only qualified requests not yet behind a brief or PRD can be ticked to start a PRD/);
  await expect(box).toHaveAttribute("title", /^Qualify this request first/);
});

test("rirs-33: Unverified sits in the State cell, not alone on the title line", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const badge = page.getByTestId("request-unverified").first();
  await expect(badge).toBeVisible();
  await expect(badge.locator("xpath=ancestor::*[@data-field='state']")).toHaveCount(1);
});

test("rirs-36: To decide has its own address; the old one leads there", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await tab(page, "new").click();
  await expect(page).toHaveURL(/\/requests\/to-decide$/);
  await expect(tab(page, "new")).toHaveAttribute("aria-current", "page");
  await page.goto("/requests/new");
  await expect(page).toHaveURL(/\/requests\/to-decide$/);
  await expect(tab(page, "new")).toHaveAttribute("aria-current", "page");
});

test("rirs-40, rirs-26: an interview's page has a way back and says when its link expires in days", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await tab(page, "interviews").click();
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  const back = page.getByTestId("interview-back").filter({ visible: true });
  await expect(back).toHaveText("← Interviews");
  await expect(page.getByTestId("interview-link-expires")).toHaveText(/^in \d+ days, [A-Z][a-z]{2} \d{1,2}$/);
  await expect(page.getByTestId("interview-about")).not.toContainText(/, 20\d\d/);
  await back.click();
  await expect(page).toHaveURL(/\/requests\/interviews$/);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("rirs-9: request cards wrap Goal, Theme and Asked by instead of cutting them", async ({ page }) => {
    await login(page);
    await page.goto("/requests");
    await expect(rows(page).first()).toBeVisible();
    const cut = await page.getByTestId("request-list").evaluate((list) =>
      [...list.querySelectorAll<HTMLElement>("[data-field=goal] [title], [data-field=goal] [data-testid=goal-chip] span, [data-field=theme] [title], [data-field=asker] [title]")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent),
    );
    expect(cut).toEqual([]);
  });
});
