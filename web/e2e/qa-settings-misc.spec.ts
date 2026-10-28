import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass on Settings › Webhooks, Connections, Autonomy and Analytics (qa-settings-24, 26,
 * 28, 34), driven as a person would on the mock layer.
 */

async function openSettings(page: Page, tab: string, heading: string, email?: string) {
  await login(page, email);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId(`nav-${tab}`).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${tab}$`));
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

test("qa-settings-24: no webhooks yet is an empty state with what they are for and New webhook", async ({ page }) => {
  await openSettings(page, "webhooks", "Webhooks");
  const empty = page.getByTestId("webhooks-empty");
  await expect(empty).toContainText("No webhooks yet");
  await expect(empty).toContainText("A webhook tells another tool");
  // No column headers above nothing.
  await expect(page.getByRole("columnheader")).toHaveCount(0);
  // One New webhook button, in the empty state; it opens the sheet.
  await expect(page.getByRole("button", { name: "New webhook" })).toHaveCount(1);
  await empty.getByRole("button", { name: "New webhook" }).click();
  await expect(page.getByRole("dialog", { name: "New webhook" })).toBeVisible();
});

test("qa-settings-24: an approver may add a webhook from the empty state too", async ({ page }) => {
  await openSettings(page, "webhooks", "Webhooks", "approver@example.com");
  const empty = page.getByTestId("webhooks-empty");
  await expect(empty).toContainText("No webhooks yet");
  await expect(empty.getByRole("button", { name: "New webhook" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-settings-26 (${scheme}): Paste a token is an outlined button; the active count is a plain header chip`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openSettings(page, "connections", "Connections");
    for (const key of ["slack", "notion", "fireflies"]) {
      const paste = page.getByTestId(`connection-card-${key}`).getByRole("button", { name: "Paste a token" });
      await expect(paste).toHaveCSS("border-top-width", "1px");
      await expect(paste).toHaveCSS("border-top-style", "solid");
    }
    const active = page.getByTestId("active-count");
    await expect(active).toHaveText("0 active");
    // Filled like every other page's header chips: no outline.
    await expect(active).toHaveCSS("border-top-width", "0px");
  });
}

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) =>
  row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

test("qa-settings-28: pressing the current level opens nothing", async ({ page }) => {
  await openSettings(page, "autonomy", "Autonomy");
  // Keep the baseline current is at Act, its only limit fixed: nothing to change there.
  const act = step(page, "baseline", "Act");
  await expect(act).toHaveAttribute("aria-pressed", "true");
  await act.click();
  await expect(page.getByTestId("autonomy-sheet")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row(page, "baseline").getByRole("button", { name: "Change limits" })).toHaveCount(0);
});

test("qa-settings-28: the sheet names a level as the step does", async ({ page }) => {
  await openSettings(page, "autonomy", "Autonomy");
  await step(page, "priorities", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Order priorities" });
  await expect(sheet.getByTestId("autonomy-from")).toContainText("Now Recommend:");
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Becomes Act:");
  await expect(sheet).not.toContainText("Act within limits");
  await sheet.getByRole("button", { name: "Cancel" }).click();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`qa-settings-28 (${viewport.name}): the level controls line up, locks or not`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openSettings(page, "autonomy", "Autonomy");
    await expect(step(page, "vision", "Act")).toBeDisabled();
    const groups = page.getByTestId("autonomy-steps");
    await expect(groups.first()).toBeVisible();
    const boxes = await groups.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      }),
    );
    expect(boxes.length).toBeGreaterThan(5);
    for (const b of boxes) expect(b).toEqual(boxes[0]);
    // Nothing runs off the screen.
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll).toBeLessThanOrEqual(0);
  });
}

test("qa-settings-34: Project ID, and the Host choice in regular weight under a bold label", async ({ page }) => {
  await openSettings(page, "analytics", "Analytics");
  await expect(page.getByLabel("Project ID", { exact: true })).toBeVisible();
  await expect(page.getByText("Project id", { exact: true })).toHaveCount(0);
  const host = page.getByLabel("Host", { exact: true });
  await expect(host).toHaveCSS("font-weight", "400");
  await expect(page.getByText("Host", { exact: true })).toHaveCSS("font-weight", "600");
});
