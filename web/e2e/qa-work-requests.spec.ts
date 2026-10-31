import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on Requests (qa-shell-33, qa-work-5 … qa-work-45): its tabs (All requests, To
 * decide, Themes, Interviews) and a customer interview's page, driven through the UI on the
 * mock API, at desktop and at phone width (390 x 844).
 */

const PHONE = { width: 390, height: 844 };

/** From the rail, as a person gets there. */
async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

const tab = (page: Page, id: "all" | "new" | "themes" | "interviews") => page.getByTestId(`requests-tab-${id}`).filter({ visible: true });
const rows = (page: Page) => page.getByTestId("request-row");
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).filter({ visible: true }).first().boundingBox())!;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/**
 * How far a list draws past its own box or the screen. Its panel clips what overflows, so the
 * page never scrolls sideways: the list itself (a table's column widths, a row) is measured.
 */
const overflow = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .filter({ visible: true })
    .first()
    .evaluate((root) => {
      const lists = [root, ...root.querySelectorAll("table, ul")] as HTMLElement[];
      const rows = [...root.querySelectorAll("tr, li")].map((r) => r.getBoundingClientRect().right - window.innerWidth);
      return Math.max(...lists.map((el) => el.scrollWidth - el.clientWidth), ...rows);
    });
const goalFilter = (page: Page) => page.getByTestId("request-filters").getByLabel("Goal", { exact: true });

test("qa-work-37: one row of tabs with names that do not clash with the New chip or button", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await expect(page.getByTestId("requests-nav").getByRole("link")).toHaveText(["All requests", "To decide", /^Themes\s*\d*$/, "Interviews"]);
  await expect(page.getByRole("button", { name: /^Queue/ })).toHaveCount(0);
  await tab(page, "themes").click();
  await expect(page).toHaveURL(/\/requests\/themes$/);
  await expect(page.getByTestId("theme-row").first()).toBeVisible();
});

test("qa-work-5: the header's triage line says what its count is, apart from the found panel", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  await page.getByTestId("triage-menu").click();
  await page.getByRole("button", { name: "Sort now", exact: true }).click();
  const status = page.getByTestId("triage-status");
  await expect(status).toContainText("Oracle's last triage left suggestions on 4 requests", { timeout: 15_000 });
  await expect(status).not.toContainText("4 suggestions,");
});

test("qa-work-38: daily triage is one switch that says its own state", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await page.getByTestId("triage-menu").click();
  const daily = page.getByRole("switch", { name: /^Auto-sort new requests daily at 7:00 AM PT\s*Off$/ });
  await expect(daily).not.toBeChecked();
  await expect(page.getByText("Daily triage is off")).toHaveCount(0);
  await daily.click();
  await expect(page.getByRole("switch", { name: /^Auto-sort new requests daily at 7:00 AM PT\s*On, runs as Admin$/ })).toBeChecked();
});

test("qa-work-35, qa-work-36: every row has a checkbox slot and its fields in one labelled order", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const count = await rows(page).count();
  await expect(page.getByTestId("request-choose")).toHaveCount(count);
  // Not every request can start a PRD: those boxes are there, disabled, with the reason on hover.
  const disabled = page.getByTestId("request-choose").locator("input:disabled");
  expect(await disabled.count()).toBeGreaterThan(0);
  const title = (i: number) => rows(page).nth(i).getByRole("button").first();
  const xs = await Promise.all([0, 1, 2, 3].map(async (i) => (await title(i).boundingBox())!.x));
  for (const x of xs) expect(Math.abs(x - xs[0])).toBeLessThan(1);

  await expect(page.getByTestId("request-list-head")).toHaveText(/State\s*Goal\s*Theme\s*Asked by\s*Channel\s*Age/);
  for (const i of [0, 1, 2]) {
    const fields = await rows(page).nth(i).locator("[data-field]").evaluateAll((els) => els.map((e) => e.getAttribute("data-field")));
    expect(fields).toEqual(["state", "goal", "theme", "asker", "channel", "age"]);
  }
});

test("qa-work-6, qa-work-41: To decide rows open the request; ages, not dates; the same header actions", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await tab(page, "new").click();
  await expect(page).toHaveURL(/\/requests\/to-decide$/);
  const first = rows(page).first();
  await expect(first).toBeVisible();
  expect(await first.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  for (const age of await page.getByTestId("request-age").allTextContents()) expect(age).toMatch(/^(now|\d+(m|h|d|w|mo|y))$/);
  await expect(page.getByTestId("new-requests")).not.toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(page.getByText("Checked", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Interview a customer" })).toBeVisible();

  const title = (await first.getByRole("button").first().textContent())!.trim();
  await first.click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("request-inspector").getByRole("heading", { name: title })).toBeVisible();

  await tab(page, "interviews").click();
  await expect(page).toHaveURL(/\/requests\/interviews$/);
  await expect(page.getByRole("button", { name: "New request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Interview a customer" })).toBeVisible();
});

test("qa-work-16: New request offers the list's goals and a Channel select", async ({ page }) => {
  await login(page);
  await openRequests(page);
  // fix-work review: the goals arrive after the rows; read the options once they are there.
  await expect(goalFilter(page).locator("option", { hasText: "Cut early churn" })).toHaveCount(1);
  const listGoals = (await goalFilter(page).locator("option").allTextContents()).filter((g) => g !== "Any goal");
  expect(listGoals).toContain("Cut early churn");
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await expect(dialog.getByTestId("new-request-goal").first()).toBeVisible();
  const offered = (await dialog.getByTestId("new-request-goal").allTextContents()).map((g) => g.replace("(not confirmed yet)", "").trim());
  expect(offered).toEqual(listGoals);
  const channel = dialog.getByLabel("Channel");
  expect(await channel.evaluate((el) => el.tagName)).toBe("SELECT");
  const options = await channel.locator("option").allTextContents();
  for (const c of ["In app", "Support", "Sales", "Slack"]) expect(options).toContain(c);
  await channel.selectOption({ label: "Support" });
  await dialog.getByLabel("Asked by").fill("A buyer");
  await dialog.getByLabel("Title").fill("Pay by invoice");
  await dialog.getByLabel("What it is and why").fill("Finance teams want an invoice, not a card.");
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(rows(page).filter({ hasText: "Pay by invoice" })).toContainText("Support");
});

test("qa-work-12: the interview's Questions choice says what each does", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "Interview a customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Interview a customer" });
  await expect(dialog.getByRole("button", { name: "Oracle drafts them", exact: true })).toBeVisible();
  const hint = dialog.getByTestId("interview-questions-hint");
  await expect(hint).toContainText("Oracle writes questions");
  await dialog.getByRole("button", { name: "Use the pricing question set", exact: true }).click();
  await expect(hint).toContainText("Six fixed questions");
});

test("qa-work-43, qa-work-44, qa-work-45: an interview's page says what to do, with one way back", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await tab(page, "interviews").click();
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  await expect(page).toHaveURL(/\/requests\/interviews\/[^/]+$/);
  const header = page.locator("[data-page-header]");
  await expect(header.getByRole("heading", { name: /Ana Lima/ })).toBeAttached();
  // qa-work-44 (fix4): one way back, "← Interviews"; the Requests tabs are not drawn here.
  await expect(header.getByRole("link", { name: "Interviews", exact: true })).toHaveCount(0);
  await expect(header.getByTestId("interview-back")).toHaveText("← Interviews");
  await expect(header.getByRole("button", { name: "Withdraw link" })).toBeVisible();
  await expect(page.getByTestId("interview-link-note")).toContainText("can't be shown or copied again");
  await expect(page.getByTestId("interview-link-note")).toContainText("If Ana Lima lost it, use Make a new link; the old link stops working.");
  await expect(page.getByTestId("interview-transcript-empty")).toHaveText("Ana Lima hasn't opened the link yet. If you didn't send it, make a new link.");
  await expect(page.getByTestId("interview-snapshot-empty")).toContainText("once Ana Lima finishes the interview");
  await expect(page.getByTestId("interview-requests-empty")).toContainText("once they finish the interview");
  for (const old of ["Nothing said yet", "No snapshot yet", "None yet"]) await expect(page.getByText(old, { exact: true })).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-shell-33: the tabs sit in the same place, at the top, on every Requests tab", async ({ page }) => {
    await login(page);
    await page.goto("/requests");
    await expect(rows(page).first()).toBeVisible();
    const at = await box(page, "requests-nav-top");
    expect(at.y).toBeLessThan(200);
    for (const [id, url] of [
      ["new", /\/requests\/to-decide$/],
      ["interviews", /\/requests\/interviews$/],
      ["all", /\/requests$/],
    ] as const) {
      await tab(page, id).click();
      await expect(page).toHaveURL(url);
      const here = await box(page, "requests-nav-top");
      expect(Math.abs(here.y - at.y)).toBeLessThan(1);
    }
  });

  test("qa-work-39, qa-work-40: header actions and filters fill the width; row controls are 44 px", async ({ page }) => {
    await login(page);
    await page.goto("/requests");
    await expect(rows(page).first()).toBeVisible();
    // qa-work-41 (fix4): one line, New request and More; Interview a customer sits under More.
    const actions = await box(page, "requests-actions");
    expect(actions.height).toBeLessThan(56);
    for (const name of ["New request", "More"]) {
      const b = (await page.getByTestId("requests-actions").getByRole("button", { name, exact: true }).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId("requests-more").click();
    const interview = (await page.getByTestId("requests-more-panel").getByRole("button", { name: "Interview a customer" }).boundingBox())!;
    expect(interview.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId("requests-more").click();
    const filters = page.getByTestId("request-filters");
    const widths = await Promise.all(
      ["Search requests", "State", "Goal", "Theme"].map(async (n) => (await filters.getByLabel(n, { exact: true }).boundingBox())!.width),
    );
    for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThan(1);

    const slot = (await page.getByTestId("request-choose").first().boundingBox())!;
    expect(slot.width).toBeGreaterThanOrEqual(44);
    expect(slot.height).toBeGreaterThanOrEqual(44);
    const title = (await rows(page).first().getByRole("button").first().boundingBox())!;
    expect(title.height).toBeGreaterThanOrEqual(44);
    expect((await tab(page, "new").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("qa-work-42, fix-work review: To decide and Interviews fit the phone's width, lists and all", async ({ page }) => {
    await login(page);
    await page.goto("/requests");
    await expect(rows(page).first()).toBeVisible();
    await tab(page, "new").click();
    await expect(rows(page).first()).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // The panel clips, so the page alone never scrolls: the list's columns and rows must fit too.
    expect(await overflow(page, "new-requests")).toBeLessThanOrEqual(0);
    await tab(page, "interviews").click();
    await expect(page.getByTestId("interview-row").first()).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await overflow(page, "interviews-table")).toBeLessThanOrEqual(0);
  });
});

test("fix-work review: New request does not offer a rejected goal", async ({ page }) => {
  await login(page);
  await page.goto("/baseline");
  await page.getByTestId("goal-g.early-churn").getByRole("button", { name: "Cut early churn" }).click();
  const d = page.getByRole("dialog", { name: "Cut early churn" });
  await d.getByRole("button", { name: "Reject" }).click();
  const ask = d.getByRole("form", { name: "Reject" });
  await ask.getByLabel("Reason").fill("Not a goal this year.");
  await ask.getByRole("button", { name: "Reject" }).click();
  await expect(d.getByRole("status").filter({ hasText: "Rejected" })).toBeVisible();

  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  const goals = dialog.getByTestId("new-request-goal");
  await expect(goals.filter({ hasText: "Raise activation" })).toHaveCount(1);
  await expect(goals.filter({ hasText: "Cut early churn" })).toHaveCount(0);
  await expect(dialog).not.toContainText("(not confirmed yet)");
});

test("fix-work review: To decide asks for the New requests, so ones past the queue's first 200 still show", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "requests-many"));
  await login(page);
  await openRequests(page);
  // All requests holds the newest 200: decided ones only, here.
  await expect(rows(page).filter({ hasText: "Decided request 1" }).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "Dark mode" })).toHaveCount(0);
  await tab(page, "new").click();
  await expect(page).toHaveURL(/\/requests\/to-decide$/);
  for (const title of ["Bulk edit prices", "Dark mode", "Save my card for the next order", "Pay by bank transfer"]) {
    await expect(rows(page).filter({ hasText: title })).toHaveCount(1);
  }
  await expect(page.getByTestId("requests-empty")).toHaveCount(0);
  // All requests stays in the page, hidden, while To decide shows.
  await expect(page.getByTestId("new-requests").getByTestId("request-row").filter({ hasText: "Decided request" })).toHaveCount(0);
});

test("fix-work review: the Themes tab shows its count, and keeps up with a new theme", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const count = page.getByTestId("requests-tab-themes-count").filter({ visible: true });
  await expect(count).toHaveText("3");
  await tab(page, "themes").click();
  await page.getByLabel("New theme").fill("Payments");
  await page.getByRole("button", { name: "Create theme" }).click();
  await expect(page.getByTestId("theme-row").filter({ hasText: "Payments" })).toBeVisible();
  await expect(count).toHaveText("4");
  await tab(page, "all").click();
  await expect(count).toHaveText("4");
});

test("fix-work review: filters, ticked requests and the open request stay across the tabs", async ({ page }) => {
  await login(page);
  await openRequests(page);
  const filters = page.getByTestId("request-filters");
  await expect(goalFilter(page).locator("option", { hasText: "Raise activation" })).toHaveCount(1);
  await goalFilter(page).selectOption({ label: "Raise activation" });
  await filters.getByLabel("Search requests").fill("e");
  await rows(page).filter({ hasText: "Weekly summary email" }).getByRole("checkbox", { name: "Select Weekly summary email" }).check();
  await rows(page).filter({ hasText: "Weekly summary email" }).getByRole("button", { name: "Weekly summary email" }).click();
  await expect(page.getByTestId("request-inspector").getByRole("heading", { name: "Weekly summary email" })).toBeVisible();

  await tab(page, "themes").click();
  await expect(page.getByTestId("theme-row").first()).toBeVisible();
  await tab(page, "all").click();
  await expect(rows(page).first()).toBeVisible();
  await expect(goalFilter(page).locator("option:checked")).toHaveText("Raise activation");
  await expect(filters.getByLabel("Search requests")).toHaveValue("e");
  await expect(rows(page).filter({ hasText: "Weekly summary email" }).getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("button", { name: "Start a PRD from 1 request" })).toBeVisible();
  await expect(page.getByTestId("request-inspector").getByRole("heading", { name: "Weekly summary email" })).toBeVisible();

  // To decide keeps the goal and the search it shares with All requests.
  await tab(page, "new").click();
  await expect(page).toHaveURL(/\/requests\/to-decide$/);
  const toDecide = page.getByTestId("new-requests");
  await expect(toDecide.getByLabel("Goal", { exact: true }).locator("option:checked")).toHaveText("Raise activation");
  await expect(toDecide.getByLabel("Search requests")).toHaveValue("e");
});
