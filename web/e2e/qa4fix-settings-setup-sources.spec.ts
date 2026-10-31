import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4 fixes on Home's Set up checklist, Settings › Sources and the baseline's way back
 * (qa4-settings-2 to -7), driven through the UI over the mock API as the owner.
 */

const setupRow = (page: Page, key: string) => page.getByTestId("home-setup").getByTestId(`setup-row-${key}`);

async function openHome(page: Page) {
  await login(page);
  await expect(page.getByTestId("home-setup")).toBeVisible();
}

async function openSources(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
  await expect(page.getByRole("list", { name: "My sources" })).toBeVisible();
}

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-settings-2: Pick sources says what its count is, not a number that reads as the whole list", async ({ page }) => {
    await openHome(page);
    const status = setupRow(page, "sources").getByTestId("setup-status");
    await expect(status).toHaveText(/^\d+ sources? with content$/);
    await expect(status).not.toHaveText(/ read$/);
  });

  test("qa4-settings-3: Invite team counts only invites still open, never an expired one", async ({ page }) => {
    await openHome(page);
    // One invite is open, the other is past its 14 days (Members shows it as expired).
    await expect(setupRow(page, "invite").getByTestId("setup-status")).toHaveText(/^\d+ people · 1 invited$/);
    // A month on, both have expired: none is said to be invited.
    await page.clock.setSystemTime(new Date("2026-11-30T12:00:00Z"));
    await page.reload();
    await expect(setupRow(page, "invite").getByTestId("setup-status")).toHaveText(/^\d+ people$/);
  });

  test("qa4-settings-4: the Company domains step lands on the domains section, marked", async ({ page }) => {
    await openHome(page);
    await setupRow(page, "domains").getByTestId("setup-action").click();
    await expect(page).toHaveURL(/\/settings\/sources\?from=setup#company-domains$/);
    const domains = page.getByTestId("company-domains");
    await expect(domains).toHaveAttribute("data-highlight", "true");
    await expect(domains).toBeInViewport();
  });

  test("qa4-settings-5: Build baseline's Review opens the baseline with a way back to Home", async ({ page }) => {
    await openHome(page);
    const build = setupRow(page, "build_baseline").getByTestId("setup-action");
    await expect(build).toHaveText("Review");
    await build.click();
    await expect(page).toHaveURL(/\/baseline\?from=setup$/);
    await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
    const back = page.getByTestId("baseline-back-home");
    await expect(back).toHaveText("Back to Home");
    await back.click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("home-setup")).toBeVisible();
  });

  test("qa4-settings-6: a source that lost access reads Needs attention, and the header counts it", async ({ page }) => {
    await openSources(page);
    const docs = page.getByRole("listitem", { name: "Product docs" });
    await expect(docs).toContainText("Lost access");
    await expect(docs.getByTestId("source-status")).toHaveText("Needs attention");
    const folders = page.getByRole("listitem", { name: "Drive folders" });
    await expect(folders.getByTestId("reconnect-to-choose")).toBeVisible();
    await expect(folders.getByTestId("source-status")).toHaveText("Needs attention");
    // Legacy all-hands chat, Product docs and Drive folders each need a person.
    await expect(page.getByTestId("sources-attention")).toHaveText("3 need attention");
    // A source that reads all it picked is still Active.
    await expect(page.getByRole("listitem", { name: "Product chat" }).getByTestId("source-status")).toHaveText("Active");
  });

  test("qa4-settings-7: a source whose token expired offers Reconnect beside the error", async ({ page }) => {
    await openSources(page);
    const repo = page.getByRole("listitem", { name: "Example repo" });
    await expect(repo.getByTestId("last-error")).toHaveText("The connection was rejected: token expired");
    const reconnect = repo.getByRole("link", { name: "Reconnect Example repo" });
    await expect(reconnect).toBeVisible();
    await reconnect.click();
    await expect(page).toHaveURL(/\/settings\/connections$/);
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  });
});
