import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Fix round 4 for Launches and Changelog (qa-plan-13, -15, -57, -58), driven through the UI on
 * the mock API as a person would. The default company has no launch, no changelog entry and
 * no approved roadmap; "launches" seeds three launches, an approved roadmap and entries, two
 * of them published and public; "roadmap-diff" has an approved roadmap and no launch.
 */

const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });

async function start(page: Page, opts: { scenario?: string; role?: "viewer" | "commenter" | "approver" } = {}) {
  if (opts.scenario) await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, opts.scenario] as const);
  if (opts.role) await page.addInitScript(([k, r]) => localStorage.setItem(k, r), [MOCK_ROLE_KEY, opts.role] as const);
  await login(page);
}

/* ------------------------------------------ Launches ------------------------------------------ */

test("qa-plan-13: with no approved roadmap, New launch is disabled with the reason and the way forward", async ({ page }) => {
  await start(page);
  await page.goto("/roadmap/launches");
  const empty = page.getByTestId("launches-empty");
  const button = empty.getByRole("button", { name: "New launch" });
  await expect(button).toBeDisabled();
  const why = empty.getByTestId("new-launch-blocked");
  await expect(why).toContainText("Usage alerts PRD has no approved roadmap yet");
  await expect(button).toHaveAttribute("aria-describedby", "new-launch-why");
  await expect(why.getByRole("link", { name: "Usage alerts roadmap" })).toHaveAttribute("href", "/documents/usage-alerts-roadmap");
  // No dialog that can only say Close.
  await button.click({ force: true });
  await expect(page.getByTestId("new-launch-dialog")).toHaveCount(0);
});

test("qa-plan-13: with an approved roadmap, New launch opens on its items", async ({ page }) => {
  await start(page, { scenario: "roadmap-diff" });
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("new-launch-blocked")).toHaveCount(0);
  await page.getByTestId("launches-empty").getByRole("button", { name: "New launch" }).click();
  const dialog = page.getByTestId("new-launch-dialog");
  await expect(dialog.getByTestId("launch-item-option").first()).toBeVisible();
});

test("qa-plan-15: with no launch, New launch is offered once, in the empty state", async ({ page }) => {
  await start(page, { scenario: "roadmap-diff" });
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("launches-empty").getByRole("button", { name: "New launch" })).toBeVisible();
  await expect(header(page).getByRole("button", { name: "New launch" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New launch" }).filter({ visible: true })).toHaveCount(1);
});

test("qa-plan-15: with launches, New launch is the header's", async ({ page }) => {
  await start(page, { scenario: "launches" });
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("launch-row").first()).toBeVisible();
  await expect(header(page).getByRole("button", { name: "New launch" })).toBeEnabled();
});

/* ------------------------------------------ Changelog ------------------------------------------ */

for (const role of ["viewer", "commenter"] as const) {
  test(`qa-plan-57: a ${role} sees no disabled Export and no hint to publish`, async ({ page }) => {
    await start(page, { role });
    await page.goto("/roadmap/changelog");
    await expect(page.getByTestId("changelog-empty")).toBeVisible();
    await expect(page.getByTestId("export-md")).toHaveCount(0);
    await expect(page.getByTestId("export-html")).toHaveCount(0);
    await expect(page.getByTestId("export-why")).toHaveCount(0);
    await expect(page.getByText("Publish a public entry to export it")).toHaveCount(0);
  });
}

test("qa-plan-57: an approver still sees why Export waits", async ({ page }) => {
  await start(page);
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("export-md")).toBeDisabled();
  await expect(page.getByTestId("export-why")).toHaveText(
    "Nothing to export yet: export gives the published public entries. Publish a public entry to export it.",
  );
});

test("qa-plan-58: the empty Changelog holds its New entry button, and it opens the form", async ({ page }) => {
  await start(page);
  await page.goto("/roadmap/changelog");
  const empty = page.getByTestId("changelog-empty");
  await expect(empty).not.toContainText("Use New entry");
  // One New entry while empty: the card's.
  await expect(header(page).getByRole("button", { name: "New entry" })).toHaveCount(0);
  await empty.getByRole("button", { name: "New entry" }).click();
  await expect(page.getByRole("dialog", { name: "New entry" })).toBeVisible();
});

test("qa-plan-58: a viewer's empty Changelog has no New entry", async ({ page }) => {
  await start(page, { role: "viewer" });
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "New entry" })).toHaveCount(0);
});
