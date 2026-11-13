import { expect, test, type Page } from "./test";

import { login, standInClaudePage } from "./helpers";

/*
 * QA fixes on Settings › Claude accounts, Autonomy, Webhooks, Trash and Analytics, driven through
 * the UI on the mock layer as a person would.
 */

const settings = async (page: Page, nav: string) => {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByTestId(`nav-${nav}`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${nav}$`));
};

async function openAccounts(page: Page, phone = false) {
  await standInClaudePage(page);
  await login(page);
  // A phone has no Settings link in its bar: open the page itself.
  if (phone) await page.goto("/settings/claude-accounts");
  else await settings(page, "claude-accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
}

const detail = (page: Page) => page.getByTestId("account-detail");

// qa-settings-22: no raw id, the provider by its name, the sweep in plain words, one capitalisation.
test("claude accounts: the pane shows no id and reads in plain words", async ({ page }) => {
  await openAccounts(page);
  await expect(page.getByTestId("refresh-sweep")).toHaveText(/^Sign-ins checked \d+ min ago$/);
  await page.getByTestId("account-row-personal").getByRole("button").click();
  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: "personal" })).toBeVisible();
  await expect(pane).toContainText("Anthropic · Claude subscription");
  await expect(pane).not.toContainText("anthropic");
  await expect(pane).not.toContainText(/a1111111-/);
  await expect(pane.getByRole("button", { name: "Copy ID" })).toHaveCount(0);
  await page.getByTestId("account-row-spare").getByRole("button").click();
  await expect(pane.getByText("Not measured", { exact: true })).toBeVisible();
  await expect(pane.getByText("not measured", { exact: true })).toHaveCount(0);
});

// qa-settings-23 and qa-settings-24: a neutral Label placeholder; Remove says what to type.
test("claude accounts: the add form's placeholder is neutral and Remove is labelled", async ({ page }) => {
  await openAccounts(page);
  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: "old-laptop" })).toBeVisible();
  await expect(pane.getByText("Type old-laptop to confirm")).toBeVisible();
  const confirm = pane.getByLabel("Type old-laptop to confirm");
  await expect(confirm).not.toHaveAttribute("placeholder", /.+/);
  await page.getByRole("button", { name: "+ Add account" }).click();
  await expect(page.getByTestId("add-account").getByLabel("Label")).toHaveAttribute("placeholder", "e.g. team-laptop");
});

// qa-settings-42 (part): on a phone every button in the pane is a 44 px tap.
test("claude accounts: at 390 px the account's buttons are at least 44 px tall", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAccounts(page, true);
  const add = page.getByRole("button", { name: "+ Add account" });
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: "old-laptop" })).toBeVisible();
  for (const name of ["Remove", "Refresh now"]) {
    const b = pane.getByRole("button", { name, exact: true });
    await b.scrollIntoViewIfNeeded();
    expect((await b.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  const signIn = page
    .getByRole("status")
    .filter({ hasText: "old-laptop needs someone to sign in again" })
    .getByRole("button", { name: "Sign in again", exact: true });
  expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

const autonomyRow = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) =>
  autonomyRow(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// qa-settings-35: every row's control starts at the same x. F-71: a row with locked steps ends at
// its last level, so only the rows that reach Act share one right edge, near the row's own.
test("autonomy: every level control lines up, right-aligned", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await settings(page, "autonomy");
  const groups = page.getByTestId(/^autonomy-row-/).getByRole("group");
  await expect(groups.first()).toBeVisible();
  const boxes = await groups.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      const li = e.closest("li")!.getBoundingClientRect();
      const full = [...e.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Act");
      return { x: Math.round(r.left), right: Math.round(r.right), rowRight: Math.round(li.right), full };
    }),
  );
  expect(boxes.length).toBeGreaterThan(3);
  expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
  const full = boxes.filter((b) => b.full);
  expect(full.length).toBeGreaterThan(2);
  expect(new Set(full.map((b) => b.right)).size).toBe(1);
  // Right-aligned: an unlocked row's control ends near its row's right edge.
  for (const b of full) expect(b.rowRight - b.right).toBeLessThan(40);
  // The vision row has locked steps left out: its strip ends at Draft, in a full row's Draft column.
  await expect(step(page, "vision", "Act")).toHaveCount(0);
  const strip = (await autonomyRow(page, "vision").getByRole("group").boundingBox())!;
  const draft = (await step(page, "vision", "Draft").boundingBox())!;
  const fullDraft = (await step(page, "priorities", "Draft").boundingBox())!;
  expect(Math.abs(strip.x + strip.width - (draft.x + draft.width))).toBeLessThan(3);
  expect(Math.abs(draft.x - fullDraft.x)).toBeLessThan(2);
  expect(strip.x + strip.width).toBeLessThan(full[0].right - 20);
});

// qa-settings-36: clicking the level already set does nothing; Act's limits have their own button.
test("autonomy: clicking the current level opens nothing; Edit limits opens the sheet", async ({ page }) => {
  await login(page);
  await settings(page, "autonomy");
  const current = autonomyRow(page, "priorities").getByRole("group").locator('[aria-pressed="true"]');
  await current.click();
  await expect(page.getByTestId("autonomy-sheet")).toHaveCount(0);

  await step(page, "priorities", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Order priorities" });
  await sheet.getByLabel("Why").fill("Small moves are fine");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "priorities", "Act")).toHaveAttribute("aria-pressed", "true");

  await step(page, "priorities", "Act").click();
  await expect(page.getByTestId("autonomy-sheet")).toHaveCount(0);
  await autonomyRow(page, "priorities").getByRole("button", { name: "Edit limits" }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Most places moved")).toBeVisible();
});

// qa-settings-37: the empty Webhooks and Trash pages say what they are for.
test("webhooks and trash: their empty states explain themselves", async ({ page }) => {
  await login(page);
  await settings(page, "webhooks");
  const empty = page.getByTestId("webhooks-empty");
  await expect(empty).toContainText("No webhooks yet. Add one to tell Slack, Zapier or your own tools when runs change.");
  await empty.getByRole("button", { name: "Add your first webhook" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.goto("/settings");
  await page.getByTestId("nav-trash").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/settings\/trash$/);
  // One short line and where to delete from; the 30 days and who restores sit behind its (i).
  const trash = page.getByTestId("trash-empty");
  await expect(trash).toContainText("Trash is empty.");
  // Train BQ: the link reads "Open PRDs" (it still goes to /documents).
  await expect(trash.getByRole("link", { name: "Open PRDs" })).toHaveAttribute("href", "/documents");
  await trash.getByRole("button", { name: "About deleted items" }).click();
  await expect(trash.getByRole("tooltip")).toContainText("waits here for 30 days");
  await expect(trash.getByRole("tooltip")).toContainText("gone for good");
});

// qa-settings-46: Project ID with where to find it, the key's hint, and why Save waits.
// qa-f-72: both hints sit behind their field's (i), not loose text on the page.
test("analytics: the PostHog form says where to find each value and why Save waits", async ({ page }) => {
  await login(page);
  await settings(page, "analytics");
  const form = page.getByTestId("analytics-posthog");
  await expect(form.getByText("Project ID", { exact: true })).toBeVisible();
  await expect(form).not.toContainText("Project id");
  await form.getByRole("button", { name: "About where to find the project" }).click();
  await expect(form.getByRole("tooltip").filter({ hasText: "Find it in PostHog › Project settings." })).toBeVisible();
  await form.getByRole("button", { name: "About where to find the project" }).click();
  await form.getByRole("button", { name: "About making a key" }).click();
  await expect(
    form.getByRole("tooltip").filter({ hasText: "Make one in PostHog › Account settings › Personal API keys." }),
  ).toBeVisible();
  await form.getByRole("button", { name: "About making a key" }).click();
  const save = form.getByRole("button", { name: "Save" });
  await expect(save).toHaveAttribute("data-variant", "primary");
  await expect(save).toBeDisabled();
  await expect(form.getByTestId("analytics-save-why")).toBeVisible();
  await form.getByLabel("Project ID").fill("67890");
  await form.getByLabel("Personal API key").fill("phx_example_key_for_tests");
  // Owner's decision (Nov 5): with nothing saved no host is picked for them; Save waits for one.
  await expect(save).toBeDisabled();
  await expect(form.getByTestId("analytics-save-why")).toHaveText("Pick a host to save.");
  await form.getByLabel("Host").selectOption({ label: "EU" });
  await expect(save).toBeEnabled();
  await expect(form.getByTestId("analytics-save-why")).toHaveCount(0);
});
