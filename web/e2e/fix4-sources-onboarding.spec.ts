import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA onboarding fixes on Settings › Sources (round 4), walked through on a new company (the
 * mock's 'empty' scenario) through the UI as a person would.
 *
 * no_claim for every test here: the in-browser mock stands in for the API (api/tests cover
 * the Slack connector refusing a source without channels and the sign-in domain rule).
 */

async function newCompany(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "empty");
  });
  await login(page);
}

/** Home's Set up › Pick sources › Open. */
async function openPickSources(page: Page) {
  const action = page.getByTestId("setup-row-sources").getByTestId("setup-action");
  await expect(action).toHaveText("Open");
  await action.click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

  test("qa-onboarding-10/11: removing the last company domain names both effects and who loses access", async ({ page }) => {
    // fails_when=the confirm speaks only of Drive docs, is titled just "Remove" or cancels with "Back".
    await newCompany(page);
    await page.goto("/settings/sources");
    const domains = page.getByTestId("company-domains");
    await domains.getByRole("button", { name: "Remove example.com" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove example.com?" });
    await expect(dialog).toContainText("every doc in a picked Drive folder is skipped");
    // example.com is also allowed by the mock deployment's own setup (fix4-review-settings.spec
    // covers a domain only this list allows).
    await expect(dialog).toContainText("People at example.com can still sign in with Google");
    await expect(dialog.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Remove domain" })).toBeVisible();

    // Cancel keeps it.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(domains.getByRole("listitem", { name: "example.com" })).toBeVisible();
  });

  test("qa-onboarding-5/12: a Slack source waits for a channel; its dates name the zone in words", async ({ page }) => {
    // fails_when=Add source is allowed with no channel, or the note shows "America/Los_Angeles".
    await newCompany(page);
    await openPickSources(page);
    const form = page.getByRole("form", { name: "Add a source" });
    await form.getByLabel("Kind").selectOption("slack");
    await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
    await form.getByLabel("Name").fill("Product chat");
    const add = form.getByRole("button", { name: "Add source" });
    await expect(add).toBeDisabled();
    await expect(form.getByTestId("add-source-reason")).toHaveText("Pick a channel to add it");

    const picker = form.getByRole("group", { name: "Slack channels" });
    await expect(picker).toContainText("whole days in the Company time zone (Pacific Time (Los Angeles))");
    await expect(picker).not.toContainText("America/Los_Angeles");

    await picker.getByRole("checkbox", { name: "#product" }).check();
    await expect(form.getByTestId("add-source-reason")).toHaveCount(0);
    await expect(add).toBeEnabled();
  });

  test("qa-onboarding-4: after Sync now the result and the card agree", async ({ page }) => {
    // fails_when=Sync now reports items seen while the card says "No items yet".
    await newCompany(page);
    await openPickSources(page);
    const form = page.getByRole("form", { name: "Add a source" });
    await form.getByLabel("Kind").selectOption("slack");
    await form.getByRole("group", { name: "Slack channels" }).getByRole("checkbox", { name: "#product" }).check();
    await form.getByLabel("Name").fill("Product chat");
    await form.getByRole("button", { name: "Add source" }).click();

    const row = page.getByRole("listitem", { name: "Product chat" });
    await expect(row.getByTestId("source-picks")).toHaveText("#product");
    await row.getByRole("button", { name: "Sync now" }).click();
    // A Slack source's first sync reads its channel's messages (the mock as the connector,
    // fix4-company's qa-onboarding-3): the result and the card say the same count.
    await expect(row.getByRole("status")).toContainText("Synced: 2 items seen");
    await expect(row.getByTestId("source-items")).toHaveText("2 items");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "light" });

  test("qa-onboarding-18 / qa-settings-44: from Pick sources the add form is in view, one Add a source", async ({ page }) => {
    // fails_when=the form opens at the very bottom of the page, out of sight, or the empty
    // list repeats the header's Add a source button.
    await newCompany(page);
    await openPickSources(page);
    const empty = page.getByTestId("sources-empty");
    await expect(empty).toContainText("No sources yet");
    await expect(empty.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a source" })).toHaveCount(1);

    const name = page.getByRole("form", { name: "Add a source" }).getByLabel("Name");
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport();
  });
});
