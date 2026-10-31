import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA fixes on Settings › Sources, Settings › Connections, the Set up checklist's Pick sources
 * step and the Build the baseline sheet, walked through the UI as a person would.
 *
 * no_claim for every test here: the in-browser mock stands in for the API (api/tests/test_setup.py
 * covers the API's Pick sources rule; api/tests/test_connection_providers.py the Slack label).
 */

const setup = (page: Page) => page.getByTestId("home-setup");
const row = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);
const sheet = (page: Page) => page.getByRole("dialog", { name: "Build the baseline" });

async function newCompany(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
}

async function backToHome(page: Page) {
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("Pick sources: an empty Uploads source does not tick it, the build sheet warns, a file ticks it", async ({ page }) => {
  // protects=qa-onboarding-11/41/24 and the Add source reason (qa-onboarding-17); fails_when=an
  // empty source ticks Pick sources, the build sheet says nothing of empty sources, the row
  // reads "0 item(s)" or the empty list does not lead to Add a source.
  await newCompany(page);
  await login(page);
  await expect(setup(page).getByTestId("panel-count")).toHaveText("2 of 8");
  await expect(row(page, "sources").getByTestId("setup-status")).toHaveText("None");

  // Open from the checklist: the empty list points to the Add a source form.
  await row(page, "sources").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);
  const empty = page.getByTestId("sources-empty");
  await expect(empty).toContainText("No sources yet");
  // One way in: the header's Add a source (qa-onboarding-18).
  await expect(empty.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Add a source" }).click();
  const form = page.getByRole("form", { name: "Add a source" });
  await expect(form.getByLabel("Name")).toBeFocused();
  // Add source says why it is greyed out.
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();
  await expect(form.getByTestId("add-source-reason")).toHaveText("Name the source to add it");
  await form.getByLabel("Name").fill("Research notes");
  await expect(form.getByTestId("add-source-reason")).toHaveCount(0);
  await form.getByRole("button", { name: "Add source" }).click();
  const notes = page.getByRole("listitem", { name: "Research notes" });
  await expect(notes.getByTestId("source-items")).toHaveText("No items yet — upload files to add some");
  await expect(notes).not.toContainText("item(s)");
  await expect(notes).not.toContainText("never synced");

  // An empty source does not tick Pick sources.
  await backToHome(page);
  await expect(setup(page).getByTestId("panel-count")).toHaveText("2 of 8");
  await expect(row(page, "sources")).toHaveAttribute("data-done", "false");

  // The build sheet warns there is nothing to read.
  await row(page, "build_baseline").getByRole("link", { name: "Open" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("build-no-items")).toContainText("Your sources have no items yet, so the build has nothing to read.");
  await sheet(page).getByRole("link", { name: "Add files or sync a source" }).click();
  // Opened from Set up, the build sheet keeps the way back to Home (fix4-plan, qa-onboarding-17).
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);

  // A file in it: Pick sources is done and counts it.
  await notes.getByLabel("Upload files to Research notes").setInputFiles([
    { name: "interview.md", mimeType: "text/markdown", buffer: Buffer.from("# Interview\nThe export button is hard to find.") },
  ]);
  await expect(notes.getByRole("status")).toHaveText("Uploaded 1 file.");
  await expect(notes.getByTestId("source-items")).toHaveText("1 item");
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-home").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(setup(page).getByTestId("panel-count")).toHaveText("3 of 8");
  await expect(row(page, "sources")).toHaveAttribute("data-done", "true");
  await expect(row(page, "sources").getByTestId("setup-status")).toHaveText("1 source with content");

  await row(page, "build_baseline").getByRole("link", { name: "Open" }).click();
  // The estimate reads "$7.00 estimated · below the $50 approval line · starts at once" (qa-onboarding-27).
  await expect(sheet(page).getByTestId("build-estimate")).toContainText("estimated");
  await expect(sheet(page).getByTestId("build-no-items")).toHaveCount(0);
});

test("Sources: plain counts and names, Add a source is the header's main button", async ({ page }) => {
  // protects=qa-settings-25/26/27/45/17; fails_when=a row shows channel ids, Fireflies' API
  // address or the repo twice, counts read "item(s)" or "1 Errors", the header's primary
  // button is Search sources, a skipped note runs together, or Drive domains do not point to
  // Members.
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await expect(chat.getByTestId("source-picks")).toHaveText("#product, #customer-feedback");
  await expect(chat.getByTestId("source-items")).toHaveText("2 items");

  const calls = page.getByRole("listitem", { name: "Customer calls" });
  await expect(calls).toBeVisible();
  await expect(calls).not.toContainText("https://");
  await expect(calls.getByTestId("source-items")).toHaveText("No items yet");

  const repo = page.getByRole("listitem", { name: "Example repo" });
  await expect(repo.getByTestId("code-map-example-org/example-app")).toBeVisible();
  await expect(repo.getByText("example-org/example-app", { exact: true })).toHaveCount(1);
  await expect(repo.getByTestId("source-items")).toHaveText("1 item");

  // One source in error: "1 Error", not "1 Errors".
  const errors = page.getByTestId("stat-errors");
  await expect(errors).toContainText("Error");
  await expect(errors).not.toContainText("Errors");

  // The header: Add a source is the primary button and takes you to the form.
  const add = page.getByRole("button", { name: "Add a source" });
  await expect(add).toHaveAttribute("data-variant", "primary");
  await expect(page.getByRole("link", { name: "Search sources" })).not.toHaveAttribute("data-variant", "primary");
  await add.click();
  await expect(page.getByRole("form", { name: "Add a source" }).getByLabel("Name")).toBeFocused();

  // Drive notes in words: a dash before the folder's note, "Skipped" apart from its reason.
  const notes = page.getByRole("list", { name: "Sync notes for Product docs" });
  await expect(notes.getByRole("listitem", { name: "Lost access to Vendor research" })).toHaveText(
    /Vendor research\s*— its docs are hidden until Oracle can read it again/,
  );
  const skipped = notes.getByRole("listitem").filter({ hasText: "owned outside example.com" });
  await expect(skipped.getByText("Skipped", { exact: true })).toBeVisible();
  const chip = await skipped.getByText("Skipped", { exact: true }).boundingBox();
  // One line: the chip is no taller than a chip.
  expect(chip!.height).toBeLessThan(30);

  // Company email domains say how they differ from sign-in domains.
  const hint = page.getByTestId("company-domains-hint");
  await expect(hint).toContainText("Which owners’ Drive files are read.");
  await expect(hint.getByRole("link", { name: "Members › Sign-in" })).toHaveAttribute("href", "/settings/members");
});

test("Connections: Connect says why it waits, a bad token is turned down under the field", async ({ page }) => {
  // protects=qa-settings-9, qa-onboarding-17/22/23 on a phone; fails_when=Connect is greyed
  // with no reason, "not-a-token" connects or says nothing, the token's tip opens on its own,
  // the row reads "token" or "pat @ Example", or Paste a token sits next to Reconnect.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/settings/connections");
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  const token = slack.getByLabel("Token", { exact: true });
  await expect(token).toBeFocused();
  await expect(page.getByRole("tooltip").filter({ visible: true })).toHaveCount(0);
  await expect(slack).toContainText("A Slack user token from a Slack app.");

  const connect = slack.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeDisabled();
  await expect(slack).toContainText("Paste a token to connect");

  await token.fill("not-a-token");
  await expect(slack).not.toContainText("Paste a token to connect");
  await connect.click();
  const error = slack.getByTestId("token-error");
  await expect(error).toHaveText("Slack did not accept this token. Check that you copied all of it, then paste it again.");
  await expect(token).toHaveAttribute("aria-invalid", "true");
  await expect(slack).toContainText("Not connected");

  await token.fill("example-slack-1234");
  await expect(error).toHaveCount(0);
  await connect.click();
  await expect(slack.getByText("Connected with a token")).toBeVisible();
  await expect(slack).toContainText("pat in Example");
  await expect(slack).not.toContainText("pat @ Example");
  await expect(slack.getByRole("button", { name: "Reconnect" })).toHaveCount(1);
  await expect(slack.getByRole("button", { name: "Paste a token" })).toHaveCount(0);
  await expect(slack.getByRole("button", { name: "Add another account" })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test("Connections: opening Paste a token leaves the neighbouring card its own height", async ({ page }) => {
  // protects=qa-settings-39; fails_when=the cards of a row grow together.
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto("/settings/connections");
  const github = page.getByTestId("connection-card-github");
  const slack = page.getByTestId("connection-card-slack");
  const before = (await github.boundingBox())!.height;
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await expect(slack.getByLabel("Token", { exact: true })).toBeVisible();
  expect((await slack.boundingBox())!.height).toBeGreaterThan(before + 40);
  expect((await github.boundingBox())!.height).toBe(before);
});
