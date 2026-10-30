import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 2, onboarding lane: a customer interview link (/i/<token>) that cannot be used is
 * refused in plain words that say why: a link that was never made (or is mistyped) is not
 * valid; a real link past its 7 days has expired. On the mock's "empty" scenario (a new
 * company), driven through the UI as a person would: the expired link is made on the
 * Requests page and the browser's clock moved past its expiry.
 */

const NOT_VALID = "This link isn't valid — ask for a new one.";
const EXPIRED = "This link has expired.";
const NOW = new Date("2026-10-29T12:00:00Z");
const EIGHT_DAYS_LATER = new Date(NOW.getTime() + 8 * 86_400_000);

/** A new company: the "empty" scenario, its mock data reset. */
async function emptyCompany(page: Page) {
  await page.goto("/icon.svg");
  await page.evaluate(() => {
    localStorage.removeItem("po-mock-db-v2");
    localStorage.setItem("po-mock-scenario", "empty");
  });
}

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`qa-onboarding-33 / qa-onboarding-46: an unknown link says it isn't valid (${name})`, async ({ page }) => {
    // qa-onboarding-33: a mistyped link read "This link has expired."
    await page.setViewportSize(viewport);
    await emptyCompany(page);
    await page.goto("/i/i-not-a-real-link");
    await expect(page.getByTestId("interview-refused")).toHaveText(NOT_VALID);
    await expect(page.getByText(EXPIRED)).toHaveCount(0);
    // No sign-in and no way into the interview.
    await expect(page).toHaveURL(/\/i\/i-not-a-real-link$/);
    await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("qa-onboarding-46: a link made through the UI, opened past its 7 days, says it has expired", async ({ page }) => {
  // qa-onboarding-46: no spec drove an expired link through the UI.
  await page.clock.setSystemTime(NOW);
  await emptyCompany(page);
  await login(page);

  // Requests → Interview a customer → Draft questions → Create link, as a member does.
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await page.getByRole("button", { name: "Interview a customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Interview a customer" });
  await dialog.getByLabel("Customer name").fill("Rosa Park");
  await dialog.getByRole("button", { name: "A topic" }).click();
  await dialog.getByLabel("Topic in your words").fill("Paying suppliers");
  await dialog.getByRole("button", { name: "Next" }).click();
  const guide = page.getByRole("dialog", { name: "Draft questions" });
  await expect(guide.getByTestId("guide-question").first()).toBeVisible();
  await guide.getByRole("button", { name: "Create link" }).click();
  const created = page.getByRole("dialog", { name: "Link created" });
  const url = await created.getByLabel("Interview link").inputValue();
  const link = new URL(url).pathname;
  await created.getByRole("button", { name: "Done" }).click();

  // Eight days on, the customer opens it: it has expired, in words, not as an unknown link.
  await page.clock.setSystemTime(EIGHT_DAYS_LATER);
  await page.goto(link);
  await expect(page.getByTestId("interview-refused")).toHaveText(EXPIRED);
  await expect(page.getByText(NOT_VALID)).toHaveCount(0);

  // A mistyped copy of the same link is not valid.
  await page.goto(`${link}x`);
  await expect(page.getByTestId("interview-refused")).toHaveText(NOT_VALID);
});
