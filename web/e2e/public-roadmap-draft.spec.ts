import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * #651 review: Draft public texts on the Public check (spec-O5 §2, owner answer O5-Q7),
 * changelog links that open in a new tab from the sandboxed Public page, and a viewer on a
 * roadmap whose default audience is Public. The "sharing-public" scenario is the "sharing"
 * roadmap with Public as its default audience and no public texts yet.
 */

const DOC = "/documents/example-labs-roadmap";
const CHANGELOG = "https://changelog.example.org/alerts";

async function scenario(page: Page, name: string, email?: string) {
  await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), name);
  await login(page, email);
}

test("Draft public texts: Oracle drafts a text for each item with none, for a person to approve", async ({ page }) => {
  await scenario(page, "sharing-public");
  await page.goto(DOC);
  await page.getByRole("link", { name: "Public version" }).click();
  const rows = page.getByTestId("public-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.getByText("No public text yet.")).toHaveCount(5);

  await page.getByRole("button", { name: "Draft public texts" }).click();
  const status = page.getByTestId("public-draft");
  await expect(status).toHaveText("Oracle drafted 4 public texts. Check each one before you approve it.");
  // The item that serves no confirmed goal gets none; every draft waits for a person.
  await expect(rows.getByTestId("public-state").filter({ hasText: "Draft" })).toHaveCount(4);
  await expect(rows.filter({ hasText: "Ops console cleanup" }).getByText("No public text yet.")).toBeVisible();
  await expect(page.getByTestId("public-check")).toHaveText("Not checked yet");
  await expect(page.getByRole("button", { name: "Mark as checked" })).toBeDisabled();

  // Nothing left to draft: the job says so.
  await page.getByRole("button", { name: "Draft public texts" }).click();
  await expect(status).toHaveText("Every item that serves a goal already has a public text.");
});

test("Draft public texts while Oracle only observes words for people outside", async ({ page }) => {
  await scenario(page, "sharing-public");
  await page.goto("/settings/autonomy");
  await page.getByTestId("autonomy-row-external_messages").getByRole("group").getByRole("button", { name: "Observe", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /^Change / });
  await sheet.getByLabel("Why").fill("We write these ourselves");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  await page.goto(`${DOC}/public`);
  await page.getByRole("button", { name: "Draft public texts" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Oracle is set to observe words for people outside" })).toBeVisible();
  await expect(page.getByTestId("public-row").getByText("No public text yet.")).toHaveCount(5);
});

test("a changelog link opens in a new tab from the preview, the audience view and the shared page", async ({ page }) => {
  await page.context().route("https://changelog.example.org/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Changelog</title><h1>Alerts changelog</h1>" }),
  );
  await scenario(page, "sharing");
  await page.goto(`${DOC}/public`);
  const rows = page.getByTestId("public-row");
  const falcon = rows.filter({ hasText: "Falcon alerts rework" });
  await falcon.getByRole("button", { name: "Edit" }).click();
  await falcon.getByLabel("Changelog link").fill(CHANGELOG);
  await falcon.getByRole("button", { name: "Approve" }).click();
  await expect(falcon.getByTestId("public-state")).toHaveText("Approved");

  const open = async (frame: string) => {
    const popup = page.waitForEvent("popup");
    await page.frameLocator(frame).getByRole("link", { name: "Read the changelog" }).click();
    const tab = await popup;
    await expect(tab).toHaveURL(CHANGELOG);
    await expect(tab.getByRole("heading", { name: "Alerts changelog" })).toBeVisible();
    await tab.close();
  };
  await open('iframe[title="Public page preview"]');

  await rows.filter({ hasText: "Northwind bulk import" }).getByRole("button", { name: "Exclude" }).click();
  await page.getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByTestId("public-check")).toContainText("Checked by Admin");

  await page.getByRole("link", { name: "Back to the roadmap" }).click();
  await page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Public" }).click();
  await open('iframe[title="Roadmap for Public"]');

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Audience").selectOption("public");
  await sheet.getByLabel("Label").fill("Customers, autumn");
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.goto(new URL(url).pathname);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await open('iframe[title="Shared roadmap"]');
  await expect(page).toHaveURL(new URL(url).pathname);
});

test("a viewer on a roadmap whose default audience is Public sees the Team view, not an error", async ({ page }) => {
  await scenario(page, "sharing-public", "viewer@example.com");
  await page.goto(DOC);
  const audience = page.getByRole("radiogroup", { name: "Audience" });
  await expect(audience.getByRole("radio", { name: "Team" })).toHaveAttribute("aria-checked", "true");
  await expect(audience.getByRole("radio", { name: "Public" })).toHaveCount(0);
  const view = page.getByTestId("audience-view");
  await expect(view.locator('iframe[title="Roadmap for Team"]')).toBeVisible();
  await expect(view.getByRole("alert")).toHaveCount(0);
});
