import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * qa-onboarding-3, -43: a new company's owner picks a Slack source (not an upload) from Home's
 * Set up, syncs it, and comes back with Back to Home. Home's Pick sources and Settings ›
 * Sources never contradict: the source is counted, and while nothing has been read from it the
 * step says so ("1 source · nothing read yet") and stays open, as the API's step rule has it.
 *
 * no_claim: the in-browser mock stands in for the API's /v1/setup and the Slack connector (its
 * sync reads nothing for a channel it holds no messages for); api/tests/test_setup.py covers
 * the API's rule that only a source with items ticks the step.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId("home-setup");
const row = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);
const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" });

async function backToHome(page: Page) {
  await settingsNav(page).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("Pick sources: a Slack source added and synced from Set up is counted on Home, as on Sources", async ({ page }) => {
  // protects=qa-onboarding-3/-43; fails_when=Home still says "None" for Pick sources while
  // Sources lists the source, the step ticks with nothing read, or the sync says it saw items
  // the source does not hold; no_claim=a real Slack workspace.
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  await expect(panel(page).getByTestId("panel-count")).toHaveText("2 of 8");
  await expect(row(page, "sources").getByTestId("setup-status")).toHaveText("None");

  // Connect tools first: Slack, with a pasted token.
  await row(page, "connect").getByRole("link", { name: "Open Connect tools" }).click();
  await expect(page).toHaveURL(/\/settings\/connections\?from=setup$/);
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-1234");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack.getByText("Connected")).toBeVisible();
  await backToHome(page);
  await expect(panel(page).getByTestId("panel-count")).toHaveText("3 of 8");

  // Pick sources: Slack, "Team chat", one channel; then Sync now.
  await row(page, "sources").getByRole("link", { name: "Open Pick sources" }).click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);
  await page.getByTestId("sources-empty").getByRole("button", { name: "Add a source" }).click();
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("slack");
  await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
  await form.getByLabel("Name").fill("Team chat");
  await form.getByRole("button", { name: "Paste ids" }).click();
  await form.getByLabel("Channel ids (one per line)").fill("C0TEAMCHAT");
  await form.getByRole("button", { name: "Add source" }).click();
  const chat = page.getByRole("listitem", { name: "Team chat" });
  await expect(chat).toBeVisible();
  await expect(page.getByRole("list", { name: "My sources" }).getByRole("listitem")).toHaveCount(1);
  await chat.getByRole("button", { name: "Sync now" }).click();
  // The sync says what it read: nothing yet, never items the source does not hold.
  await expect(chat.getByRole("status")).toContainText("Synced: 0 items seen");

  // Back to Home: the source is counted, and the step says what is missing.
  await backToHome(page);
  const status = row(page, "sources").getByTestId("setup-status");
  await expect(status).toHaveText("1 source · nothing read yet");
  await expect(status).not.toHaveText("None");
  await expect(row(page, "sources")).toHaveAttribute("data-done", "false");
  await expect(panel(page).getByTestId("panel-count")).toHaveText("3 of 8");

  // Sources, opened again from the step, lists the same one source.
  await row(page, "sources").getByRole("link", { name: "Open Pick sources" }).click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);
  await expect(page.getByRole("list", { name: "My sources" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem", { name: "Team chat" })).toBeVisible();

  // An upload with a file beside it: two sources, one read; the step is done and says both.
  await page.getByRole("button", { name: "Add a source" }).first().click();
  await form.getByLabel("Kind").selectOption("upload");
  await form.getByLabel("Name").fill("Research notes");
  await form.getByRole("button", { name: "Add source" }).click();
  const notes = page.getByRole("listitem", { name: "Research notes" });
  await notes.getByLabel("Upload files to Research notes").setInputFiles([
    { name: "interview.md", mimeType: "text/markdown", buffer: Buffer.from("# Interview\nThe export button is hard to find.") },
  ]);
  await expect(notes.getByTestId("source-items")).toHaveText("1 item");
  await expect(page.getByRole("list", { name: "My sources" }).getByRole("listitem")).toHaveCount(2);
  await backToHome(page);
  await expect(row(page, "sources")).toHaveAttribute("data-done", "true");
  await expect(row(page, "sources").getByTestId("setup-status")).toHaveText("2 sources · 1 read");
  await expect(panel(page).getByTestId("panel-count")).toHaveText("4 of 8");
});
