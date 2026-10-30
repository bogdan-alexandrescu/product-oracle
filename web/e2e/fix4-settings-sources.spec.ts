import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * QA fixes on Settings › Sources (round 4), walked through the UI as a person would.
 *
 * no_claim for every test here: the in-browser mock stands in for the API (the seeded
 * sources carry what the API's SourceOut returns: picks, their saved names, sync notes).
 */

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

  test("qa-settings-23: picks read by name, never by raw id; an unnamed pick reads as unknown", async ({ page }) => {
    // fails_when=a row shows a Slack channel id or a Drive folder id as its name.
    await login(page);
    await page.goto("/settings/sources");

    // Saved before names were kept: counted as unknown channels, the ids only in the title.
    const legacy = page.getByRole("listitem", { name: "Legacy all-hands chat" });
    const picks = legacy.getByTestId("source-picks");
    await expect(picks).toHaveText("120 unknown channels");
    await expect(picks).toHaveAttribute("title", /^No name saved for C9001LEGACY, C9002LEGACY/);
    await expect(legacy).not.toContainText("C9001LEGACY");

    // A Drive folder by its name.
    const folders = page.getByRole("listitem", { name: "Drive folders" });
    await expect(folders.getByTestId("source-folders")).toHaveText("Product planning");
    await expect(folders).not.toContainText("1FolderProductExample");

    // A channel left out by its name, not its id.
    const chat = page.getByRole("listitem", { name: "Product chat" });
    await expect(chat.getByRole("list", { name: "Sync notes for Product chat" })).toContainText("#partner-launch");
    await expect(chat).not.toContainText("C0777PARTNER");
  });

  test("qa-settings-25: a channel left out says why and what to do, with an info tip", async ({ page }) => {
    // fails_when=a bare "No access" chip sits beside the channel with no reason or next step.
    await login(page);
    await page.goto("/settings/sources");
    const chat = page.getByRole("listitem", { name: "Product chat" });
    const note = chat.getByRole("listitem", { name: "Skipped: #partner-launch" });
    await expect(note).toContainText("shared from outside the company");
    await expect(note).toContainText("Nothing to do: Oracle never reads it.");
    await expect(note.getByText("No access", { exact: true })).toHaveCount(0);
    await note.getByRole("button", { name: "About why #partner-launch is skipped" }).click();
    await expect(page.getByRole("tooltip")).toContainText("only the company's own channels are read");
  });

  test("qa-onboarding-18 / qa-settings-24: one Add a source, plain eyebrow", async ({ page }) => {
    // fails_when=the page offers Add a source twice or more, or the panel's eyebrow reads "Source · new".
    await login(page);
    await page.goto("/settings/sources");
    await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a source" })).toHaveCount(1);
    await expect(page.getByText("Add a source", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Source · new")).toHaveCount(0);
    const panel = page.getByRole("complementary", { name: "New source" });
    await expect(panel.getByText("Your sources", { exact: true })).toBeVisible();
  });
});
