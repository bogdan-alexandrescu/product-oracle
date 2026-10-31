import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * fix4-settings review minors on Settings, driven through the UI on the mock layer as the
 * owner: the pricing owner's hint when none is chosen, the Slack card's wording before an
 * install, the API tokens page naming My account's section as it is titled, a Slack source's
 * Save saying why it waits, theme names when the themes cannot load, and a tapped template or
 * theme brought into view wherever the panel sits under the list.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const withScenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

test("pricing owner: with none chosen, the hint names who decides instead of asking for another owner", async ({ page }) => {
  await withScenario(page, "pricing");
  await login(page);
  await page.goto("/settings/company");
  const pricing = page.getByTestId("pricing-owner-panel");
  await expect(pricing.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(pricing.getByTestId("pricing-owner-save-reason")).toHaveText("Not chosen yet: the earliest owner, Avery Stone, decides until you pick someone else.");
  // Once chosen, the hint asks for another owner.
  await pricing.getByRole("combobox", { name: "Decides prices" }).selectOption({ label: "Riley Park" });
  await pricing.getByRole("button", { name: "Save" }).click();
  await expect(pricing.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(pricing.getByTestId("pricing-owner-save-reason")).toHaveText("Pick another owner to save it.");
});

test("pricing owner: the only owner is told how to choose someone else", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const pricing = page.getByTestId("pricing-owner-panel");
  await expect(pricing.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(pricing.getByTestId("pricing-owner-save-reason")).toHaveText("Avery Stone is the only owner: make another member an owner to choose someone else.");
});

test("Connections: the Slack card says what the app does once installed, beside Not installed", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-connections").click();
  const slack = page.getByTestId("connection-card-slack").filter({ visible: true }).getByTestId("company-slack");
  await expect(slack).toContainText("Not installed");
  await expect(slack).toContainText("Once installed for the company, it posts the weekly report");
  await expect(slack).not.toContainText("Installed once");
});

test("API tokens: the link names My account's section as it is titled there", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  const where = page.getByTestId("tokens-made-where");
  await where.getByRole("link", { name: "My account › Personal API tokens" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId("tokens-panel")).toContainText("Personal API tokens");
});

test("Sources: editing a Slack source with no channel left says why Save waits", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit channels" }).click();
  const picker = chat.getByRole("group", { name: "Slack channels" });
  await picker.getByRole("checkbox", { name: "#product" }).uncheck();
  await picker.getByRole("checkbox", { name: "#customer-feedback" }).uncheck();
  await expect(chat.getByRole("button", { name: "Save channels" })).toBeDisabled();
  await expect(chat.getByTestId("save-channels-reason")).toHaveText("Pick a channel to save");
  await picker.getByRole("checkbox", { name: "#product" }).check();
  await expect(chat.getByRole("button", { name: "Save channels" })).toBeEnabled();
  await expect(chat.getByTestId("save-channels-reason")).toHaveCount(0);
});

test("Templates: when the themes cannot load, a suggested theme still reads as words, not …", async ({ page }) => {
  await page.addInitScript(([key, path]) => localStorage.setItem(key, path), [MOCK_FAIL_KEY, "/v1/themes"]);
  await login(page);
  await page.goto("/settings/templates");
  await page.getByTestId("template-row-outcome-roadmap").click();
  const inspector = page.getByTestId("template-inspector");
  await expect(inspector.getByRole("heading", { level: 2 })).toHaveText("Outcome roadmap");
  await expect(inspector).toContainText("Suggested theme");
  // Give a failed load time to settle: the name never stays "…".
  await page.waitForTimeout(1500);
  await expect(page.getByText("…", { exact: true })).toHaveCount(0);
  await expect(inspector).toContainText("Roadmap board");
});

test.describe("tablet", () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test("qa-settings-44: between phone and desktop, tapping a template or theme brings its panel into view", async ({ page }) => {
    await login(page);
    for (const [path, rowId, panelId, name] of [
      ["/settings/templates", "template-row-outcome-roadmap", "template-inspector", "Outcome roadmap"],
      ["/settings/themes", "theme-row-roadmap-board", "theme-inspector", "Roadmap board"],
    ]) {
      await page.goto(path);
      const panel = page.getByTestId(panelId);
      await expect(panel).toBeVisible();
      const row = page.getByTestId(rowId);
      await row.scrollIntoViewIfNeeded();
      const box = (await row.boundingBox())!;
      await row.click({ position: { x: box.width - 8, y: 6 } });
      await expect(panel.getByRole("heading", { level: 2 })).toHaveText(name);
      await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(400);
      await expect.poll(async () => (await panel.boundingBox())!.y).toBeGreaterThanOrEqual(-1);
    }
  });
});

test("qa-settings-37: a tab a role cannot open names the owners and says where its button goes", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/settings/trash");
  const gate = page.getByTestId("not-for-role");
  await expect(gate).toContainText("Not available for your role");
  await expect(gate).toContainText("Ask an owner (Avery Stone) if you need it.");
  await expect(gate.getByRole("link", { name: "Open Settings" })).toHaveCount(0);
  await gate.getByRole("link", { name: "Open Members" }).click();
  await expect(page).toHaveURL(/\/settings\/members$/);
});

test("Time zone: focusing the picker keeps the saved zone, and the active option is the selected one", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const panel = page.getByTestId("timezone-panel");
  const zone = panel.getByRole("combobox", { name: "Company time zone" });
  await zone.fill("tokyo");
  await zone.press("ArrowDown");
  await zone.press("Enter");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");

  await page.getByRole("heading", { level: 1 }).click();
  await zone.click();
  await expect(zone).toHaveAttribute("aria-expanded", "true");
  await expect(zone).toHaveValue(/\(Tokyo\)/);
  const list = panel.getByRole("listbox", { name: "Time zones" });
  await expect(list.getByRole("option").first()).toBeVisible();
  await zone.press("ArrowDown");
  const active = await zone.getAttribute("aria-activedescendant");
  expect(active).toBeTruthy();
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("id", active!);
  // Typing still narrows the list.
  await zone.fill("berl");
  await expect(list.getByRole("option")).toHaveCount(1);
  await zone.press("Escape");
  await expect(zone).toHaveValue(/\(Tokyo\)/);
});

test("qa-onboarding-36: a half-written invite asks before the browser's Back drops it", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("pat@example.com");

  await page.evaluate(() => history.back());
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(form.getByLabel("Email")).toHaveValue("pat@example.com");

  await page.evaluate(() => history.back());
  await page.getByRole("alertdialog", { name: "Discard your changes?" }).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test("qa-onboarding-10: removing a domain says whether Google sign-in is lost, as the sign-in rules have it", async ({ page }) => {
  await withScenario(page, "empty");
  await login(page);
  await page.goto("/settings/sources");
  const domains = page.getByTestId("company-domains");
  // example.com is also allowed by this Oracle's own setup: its sign-in stays.
  await domains.getByRole("button", { name: "Remove example.com" }).click();
  let dialog = page.getByRole("alertdialog", { name: "Remove example.com?" });
  await expect(dialog).toContainText("every doc in a picked Drive folder is skipped");
  await expect(dialog).toContainText("People at example.com can still sign in with Google: this Oracle's own setup allows that domain.");
  await expect(dialog).not.toContainText("can no longer sign in");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A domain only this list allows loses Google sign-in with it.
  const add = domains.getByRole("form", { name: "Add a company domain" });
  await add.getByLabel("Add a domain").fill("example.org");
  await add.getByRole("button", { name: "Add" }).click();
  await domains.getByRole("button", { name: "Remove example.org" }).click();
  dialog = page.getByRole("alertdialog", { name: "Remove example.org?" });
  await expect(dialog).toContainText("Anyone at example.org who is not a member yet can no longer sign in with Google, even with an invite.");
  await expect(dialog).toContainText("Members already in keep their access.");
});
