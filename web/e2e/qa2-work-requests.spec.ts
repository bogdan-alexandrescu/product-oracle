import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, pickZone } from "./helpers";

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

  // Review minor: a click outside the form asks the same question before throwing typed work away.
  await page.getByRole("button", { name: "New request" }).first().click();
  await dialog.getByLabel("Title").fill("Export invoices as a spreadsheet");
  await page.getByTestId("dialog-backdrop").click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Title")).toHaveValue("Export invoices as a spreadsheet");
  await page.getByTestId("dialog-backdrop").click({ position: { x: 4, y: 4 } });
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toHaveCount(0);

  // Nothing typed: a click outside closes at once.
  await page.getByRole("button", { name: "New request" }).first().click();
  await page.getByTestId("dialog-backdrop").click({ position: { x: 4, y: 4 } });
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
  await pickZone(page, "Europe/Berlin");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");

  await page.goto("/home");
  await openRequests(page);
  await page.getByTestId("triage-menu").click();
  // A European zone reads by its short name, as Settings names it (qa-onboarding-38: CET, or CEST in summer).
  await expect(page.getByRole("switch", { name: /^Auto-sort new requests daily at 7:00 AM CES?T/ })).toBeVisible();
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
  // Review minor: typing /requests/new opens the New request form, over the To decide tab.
  await page.goto("/requests/new");
  const dialog = page.getByRole("dialog", { name: "New request" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/requests\/to-decide\?compose=request$/);
  await expect(tab(page, "new")).toHaveAttribute("aria-current", "page");
  // Closing it leaves the tab's own address, so a reload does not open it again.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/requests\/to-decide$/);
  await page.reload();
  await expect(tab(page, "new")).toHaveAttribute("aria-current", "page");
  await expect(dialog).toHaveCount(0);
  // An old link to one request still opens that request on To decide, with no form.
  await page.goto("/requests/new?request=00000000-0000-0000-0000-000000000000");
  await expect(page).toHaveURL(/\/requests\/to-decide\?request=/);
  await expect(dialog).toHaveCount(0);
});

test("rirs-36: a viewer typing /requests/new gets the To decide tab, with no form to fill", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "viewer"), MOCK_ROLE_KEY);
  await login(page);
  await page.goto("/requests/new");
  await expect(tab(page, "new")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("View only").first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New request" })).toHaveCount(0);
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

  // rirs-37: the strip's scroll arrows never sit on a tab label, at either end. /sources is a
  // Settings page: on a phone it picks its page from a select, no strip (qa-settings-41).
  for (const path of ["/requests", "/requests/interviews"]) {
    test(`rirs-37: the tab strip's arrows do not cover a tab on ${path}`, async ({ page }) => {
      await login(page);
      await page.goto(path);
      await expect(page.getByRole("button", { name: /^Scroll (tabs )?(left|right)$/ }).filter({ visible: true }).first()).toBeVisible();
      // At the start, and after swiping the strip to its end: no arrow on a tab's visible part.
      for (const end of [false, true]) {
        const overlaps = await page.evaluate((end) => {
          const out: string[] = [];
          for (const btn of document.querySelectorAll<HTMLElement>('button[aria-label^="Scroll"]')) {
            if (!btn.offsetWidth) continue;
            const wrap = btn.parentElement!;
            const strip = [...wrap.querySelectorAll<HTMLElement>("*")].find((e) => /auto|scroll/.test(getComputedStyle(e).overflowX));
            if (!strip) continue;
            if (end) strip.scrollLeft = strip.scrollWidth;
            const s = strip.getBoundingClientRect();
            const b = btn.getBoundingClientRect();
            for (const t of strip.querySelectorAll<HTMLElement>("a, [role=tab]")) {
              const r = t.getBoundingClientRect();
              const left = Math.max(r.left, s.left);
              const right = Math.min(r.right, s.right);
              if (right - left < 2) continue;
              if (b.left < right - 1 && b.right > left + 1 && b.top < r.bottom - 1 && b.bottom > r.top + 1) out.push(t.textContent ?? "");
            }
          }
          return out;
        }, end);
        expect(overlaps).toEqual([]);
      }
    });
  }
});
