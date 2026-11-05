import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * Visual QA pass A on Requests (RQ-1 … RQ-3): a tapped request under 1100 px opens in a sheet,
 * New request keeps its buttons in view with many goals, and the list's headers sit over their
 * values. Driven through the UI on the mock API.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 900, height: 1000 };

/** From the rail, or the tab bar's More on a phone, as a person gets there. */
async function openRequests(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) > 600) await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  else {
    await page.getByTestId("tab-bar").getByTestId("tab-more").click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Requests" }).click();
  }
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

const inView = async (page: Page, testId: string) => {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeLessThan(vp.height / 2);
};

for (const [name, viewport] of [
  ["phone", PHONE],
  ["tablet", TABLET],
] as const) {
  test(`RQ-1: a tapped request opens in a full-height sheet that closes back to the list (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    await openRequests(page);
    const row = page.getByTestId("request-row").nth(2);
    const title = (await row.getByRole("button").first().textContent())!.trim();
    await row.getByRole("button", { name: title, exact: true }).click();

    const sheet = page.getByRole("dialog", { name: "Request" });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.height)).toBe(viewport.height);
    await expect(sheet.getByTestId("request-inspector")).toContainText(title);
    await inView(page, "request-inspector");

    await sheet.getByRole("button", { name: "Close Request" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(row).toHaveAttribute("aria-current", "true");
    // The same row again opens it again.
    await row.click();
    await expect(page.getByRole("dialog", { name: "Request" }).getByTestId("request-inspector")).toContainText(title);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Request" })).toHaveCount(0);
  });
}

test("RQ-1: over 1100 px the request still opens beside the list, with no sheet", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await openRequests(page);
  await page.getByTestId("request-row").nth(2).click();
  await expect(page.getByTestId("request-inspector")).toBeVisible();
  await expect(page.getByTestId("request-sheet")).toHaveCount(0);
  const list = (await page.getByTestId("all-requests").boundingBox())!;
  const panel = (await page.getByTestId("request-inspector").boundingBox())!;
  expect(panel.x).toBeGreaterThan(list.x + list.width - 1);
});

test("RQ-2: with many goals, New request scrolls its body and keeps Cancel and File request in view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.addInitScript(([key]) => localStorage.setItem(key, "large"), [MOCK_SCENARIO_KEY] as const);
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).filter({ visible: true }).first().click();
  const dialog = page.getByTestId("new-request-dialog");
  await expect(dialog.getByTestId("new-request-goal").nth(25)).toBeAttached();
  for (const name of ["Cancel", "File request"]) {
    const box = (await dialog.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.y + box.height, name).toBeLessThanOrEqual(800);
    expect(box.y, name).toBeGreaterThanOrEqual(0);
  }
  // The goals scroll inside the dialog: the last one can be reached and ticked.
  const last = dialog.getByTestId("new-request-goal").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "File request", exact: true })).toBeInViewport();
});

test("RQ-3: Request heads the title, and State sits over the state chip", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await openRequests(page);
  const head = page.getByTestId("request-list-head");
  const first = page.getByTestId("request-row").first();
  const titleHead = (await page.getByTestId("request-list-head-title").boundingBox())!;
  const titleBox = (await first.getByRole("button").first().boundingBox())!;
  expect(Math.abs(titleHead.x - titleBox.x)).toBeLessThan(2);
  const state = (await head.getByText("State", { exact: true }).boundingBox())!;
  const chip = (await first.getByTestId("request-state").boundingBox())!;
  expect(Math.abs(state.x - chip.x)).toBeLessThan(2);
  // State is no longer the label over the title: it sits below "Request".
  expect(state.y).toBeGreaterThan(titleHead.y + titleHead.height - 1);
});
