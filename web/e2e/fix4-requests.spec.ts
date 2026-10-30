import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login, signOut } from "./helpers";

/*
 * Fix 4 QA findings on Requests (qa-work-8, qa-work-35 … qa-work-44, qa-onboarding-26,
 * cld-6), driven through the UI on the mock API, at desktop and phone width where the layout
 * differs.
 */

const PHONE = { width: 390, height: 844 };

/** From the rail, as a person gets there. */
async function openRequests(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) > 600) await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  else {
    // A phone: Requests is under the tab bar's More.
    await page.getByTestId("tab-bar").getByTestId("tab-more").click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Requests" }).click();
  }
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

/** A new company: the "empty" scenario, its mock data reset. */
async function emptyCompany(page: Page) {
  await page.goto("/icon.svg");
  await page.evaluate(() => {
    localStorage.removeItem("po-mock-db-v2");
    localStorage.setItem("po-mock-scenario", "empty");
  });
}

const rows = (page: Page) => page.getByTestId("request-row");
const row = (page: Page, title: string) => rows(page).filter({ has: page.getByRole("button", { name: title, exact: true }) });
const inspector = (page: Page) => page.getByTestId("request-inspector");

/** Sets the Company time zone on Settings › Company, as an owner does. */
async function setZone(page: Page, zone: string) {
  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption(zone);
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await page.goto("/home");
}

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 640 }],
  ["phone", PHONE],
] as const) {
  test(`qa-work-8: the Start a PRD bar stays on screen, the boxes are labelled and a greyed box says why (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    await openRequests(page);
    await expect(page.getByTestId("request-list-head-choose")).toHaveText("Start a PRD");
    await expect(page.getByTestId("request-list-head-choose")).toBeVisible();
    // A greyed-out box says why on the row, not only in a hover tip.
    const fresh = row(page, "Dark mode");
    await expect(fresh.getByTestId("request-choose").getByRole("checkbox")).toBeDisabled();
    await expect(fresh.getByTestId("request-choose-why")).toHaveText("Qualify it to start a PRD");
    await expect(fresh.getByTestId("request-choose-why")).toBeVisible();

    // A qualified row far down the list: ticked, the bar is at the bottom of the screen.
    const low = row(page, "Weekly summary email");
    await low.scrollIntoViewIfNeeded();
    await low.getByRole("checkbox").check();
    const bar = page.getByTestId("start-prd-bar");
    await expect(bar.getByRole("button", { name: "Start a PRD from 1 request" })).toBeInViewport();
    const box = (await bar.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    // Scrolled back to the top, it is still in view.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar.getByRole("button", { name: "Start a PRD from 1 request" })).toBeInViewport();
  });
}

test("qa-work-39: 'Request' heads the titles and State sits over the state chips", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const head = page.getByTestId("request-list-head");
  await expect(page.getByTestId("request-list-head-title")).toHaveText("Request");
  const titleHead = (await page.getByTestId("request-list-head-title").boundingBox())!;
  const stateHead = (await head.getByText("State", { exact: true }).boundingBox())!;
  const first = rows(page).first();
  const title = (await first.getByRole("button").first().boundingBox())!;
  const chip = (await first.locator("[data-field=state]").boundingBox())!;
  expect(Math.abs(titleHead.x - title.x)).toBeLessThan(2);
  expect(Math.abs(stateHead.x - chip.x)).toBeLessThan(2);
  // "Request" is on its own line, above the columns' names.
  expect(titleHead.y + titleHead.height).toBeLessThanOrEqual(stateHead.y + 1);
});

test("qa-onboarding-26: Auto-sort reads the same for every role", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/requests");
  await expect(page.getByTestId("daily-triage-state")).toHaveText("Auto-sort: Off");
  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/requests");
  await expect(page.getByTestId("daily-triage-state")).toHaveText("Auto-sort: Off");
  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto("/requests");
  await expect(page.getByTestId("triage-menu")).toHaveText("Auto-sort: Off");
});

test("qa-onboarding-26: a new company's Auto-sort reads the same for every role", async ({ page }) => {
  await emptyCompany(page);
  await login(page, "viewer@example.com");
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page.getByTestId("daily-triage-state")).toHaveText("Auto-sort: Off");
  await signOut(page);
  await login(page);
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page.getByTestId("triage-menu")).toHaveText("Auto-sort: Off");
  await expect(page.getByText(/Auto-sort off/)).toHaveCount(0);
});

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", PHONE],
] as const) {
  test(`qa-work-35: Interview a customer is the same dialog as New request (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    await openRequests(page);
    if (name === "phone") await page.getByTestId("requests-more").click();
    await page.getByRole("button", { name: "Interview a customer" }).click();
    const dialog = page.getByRole("dialog", { name: "Interview a customer" });
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    const cancel = dialog.getByTestId("dialog-footer").getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeVisible();
    const border = await cancel.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    expect(border).toBeGreaterThan(0);
    // The segmented control is as wide as its options, not the dialog's row.
    const about = (await dialog.getByRole("group", { name: "What to learn about" }).boundingBox())!;
    const option = await dialog
      .getByRole("group", { name: "What to learn about" })
      .getByRole("button")
      .evaluateAll((els) => els.reduce((w, el) => w + el.getBoundingClientRect().width, 0));
    expect(about.width).toBeLessThan(option + 8);

    // Typed work asks before it is thrown away.
    await dialog.getByLabel("Customer name").fill("Rosa Park");
    await cancel.click();
    await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByLabel("Customer name")).toHaveValue("Rosa Park");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toHaveCount(0);
  });
}

test("qa-work-36: the Auto-sort panel keeps '7:00 AM PT' together and has one info tip", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await page.getByTestId("triage-menu").click();
  const panel = page.getByTestId("triage-menu-panel");
  const label = panel.getByRole("switch", { name: /^Auto-sort new requests daily at 7:00 AM PT/ });
  await expect(label).toBeVisible();
  const text = await panel.locator("label").filter({ has: page.getByTestId("daily-triage-switch") }).textContent();
  expect(text).toContain("7:00 AM PT");
  await expect(panel.getByRole("button", { name: /^About / })).toHaveCount(1);
  await panel.getByRole("button", { name: "About Auto-sort and Sort now" }).click();
  await expect(page.getByText("While Auto-sort is on, Oracle sorts new requests every day at 7:00 AM PT")).toBeVisible();
});

test("qa-work-37: filing a request under a title already filed warns, and opens the one filed", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const before = await row(page, "Dark mode").count();
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill("dark mode");
  await dialog.getByLabel("What it is and why").fill("Night shifts need a dark screen.");
  await dialog.getByRole("button", { name: "File request" }).click();
  const warn = dialog.getByTestId("new-request-duplicate");
  await expect(warn).toContainText("This looks like a request already filed");
  await expect(warn).toContainText("Dark mode");
  await warn.getByRole("button", { name: "Open it" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "Dark mode")).toHaveCount(before);
  await expect(row(page, "Dark mode")).toHaveAttribute("aria-current", "true");
  await expect(inspector(page).getByRole("heading", { name: "Dark mode" })).toBeVisible();

  // File anyway: one filed a moment ago warns too; then a second is filed on purpose.
  await page.getByRole("button", { name: "New request" }).first().click();
  await dialog.getByLabel("Title").fill("Gift cards");
  await dialog.getByLabel("What it is and why").fill("Shops want to sell gift cards.");
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "New request" }).first().click();
  await dialog.getByLabel("Title").fill("Gift cards");
  await dialog.getByLabel("What it is and why").fill("Shops want to sell gift cards.");
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog.getByTestId("new-request-duplicate")).toContainText("filed just now");
  await dialog.getByRole("button", { name: "File anyway" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "Gift cards")).toHaveCount(2);
});

test("qa-work-38: Save links waits for a change; the two PRD labels differ", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  await row(page, "Weekly summary email").getByRole("button", { name: "Weekly summary email" }).click();
  const save = inspector(page).getByRole("button", { name: "Save links" });
  await expect(save).toBeDisabled();
  await expect(inspector(page).getByTestId("request-prd-section")).toContainText("New PRD");
  await expect(inspector(page).getByTestId("request-prd-section").getByRole("button", { name: "Start a PRD" })).toBeVisible();
  await inspector(page).getByLabel("Linked PRD").selectOption({ index: 1 });
  await expect(save).toBeEnabled();
  await inspector(page).getByLabel("Linked PRD").selectOption("");
  await expect(save).toBeDisabled();
});

test("qa-work-40: a viewer has no Replies to send filter; an approver has", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/requests");
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByTestId("request-filters").getByLabel("Search requests")).toBeVisible();
  await expect(page.getByTestId("request-filters").getByLabel("Replies to send")).toHaveCount(0);
  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto("/requests");
  await expect(page.getByTestId("request-filters").getByLabel("Replies to send")).toBeVisible();
});

test("qa-work-44: interview rows look clickable; the interview's page has one way back and one date", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await page.getByTestId("requests-tab-interviews").filter({ visible: true }).click();
  const ana = page.getByTestId("interview-row").filter({ hasText: "Ana Lima" });
  await expect(ana.getByTestId("interview-row-open")).toBeVisible();
  await ana.click();
  await expect(page).toHaveURL(/\/requests\/interviews\/[^/]+$/);
  await expect(page.getByTestId("interview-back").filter({ visible: true })).toHaveText("← Interviews");
  await expect(page.getByTestId("requests-nav")).toHaveCount(0);
  await expect(page.getByTestId("requests-nav-top")).toHaveCount(0);
  const about = page.getByTestId("interview-about");
  await expect(about.getByTestId("interview-link-made")).toBeVisible();
  // Created by names who; the day is the link's, once.
  await expect(about).toContainText(/Created by\s*Admin\s*Link made/);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-work-41: Requests opens with one primary button; the rest are under More", async ({ page }) => {
    await login(page);
    await openRequests(page);
    const actions = page.getByTestId("requests-actions");
    expect((await actions.boundingBox())!.height).toBeLessThan(56);
    await expect(actions.getByRole("button", { name: "New request" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Interview a customer" })).toHaveCount(0);
    await expect(page.getByTestId("triage-menu")).toHaveCount(0);
    await page.getByTestId("requests-more").click();
    const more = page.getByTestId("requests-more-panel");
    await expect(more.getByRole("button", { name: "Interview a customer" })).toBeVisible();
    await more.getByTestId("triage-menu").click();
    await expect(page.getByRole("switch", { name: /^Auto-sort new requests daily/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(more).toHaveCount(0);
  });

  test("qa-work-43: request boxes and Oracle follows up are big enough to tap", async ({ page }) => {
    await login(page);
    await openRequests(page);
    const slot = (await page.getByTestId("request-choose").first().boundingBox())!;
    expect(slot.width).toBeGreaterThanOrEqual(24);
    expect(slot.height).toBeGreaterThanOrEqual(24);
    const box = (await page.getByTestId("request-choose").first().getByRole("checkbox").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(20);
  });
});

test.describe("phone, a brief's questions", () => {
  test.use({ viewport: PHONE });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
    });
  });

  test("qa-work-43: the 'Oracle follows up' switch has a 24 px hit area or more", async ({ page }) => {
    await login(page);
    await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
    const label = page.getByTestId("follow-up-switch");
    await expect(label).toBeVisible();
    const box = (await label.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);
    // A tap on the label's words turns it.
    const sw = page.getByRole("switch", { name: "Oracle follows up" });
    await expect(sw).toBeChecked();
    await label.click({ position: { x: 40, y: box.height / 2 } });
    await expect(sw).not.toBeChecked();
  });
});

for (const [zone, said] of [
  ["America/New_York", "7:00 AM ET"],
  ["Europe/Berlin", "7:00 AM Berlin time"],
  ["Asia/Tokyo", "7:00 AM Tokyo time"],
] as const) {
  test(`cld-6: the daily Auto-sort time in ${zone} reads "${said}"`, async ({ page }) => {
    await login(page);
    await setZone(page, zone);
    await openRequests(page);
    await page.getByTestId("triage-menu").click();
    await expect(page.getByRole("switch", { name: new RegExp(`^Auto-sort new requests daily at ${said}`) })).toBeVisible();
    // Other times keep their short zone names (only the triage time reads as a city).
    await expect(page.getByTestId("triage-menu-panel")).not.toContainText(/\bCES?T\b|GMT\+/);
  });
}
