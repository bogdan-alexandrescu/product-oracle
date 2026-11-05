import { expect, test } from "./test";

import { login, openSection } from "./helpers";

/**
 * Nov 4 gap: a roadmap version page had no Build draft button, so changes staged on a
 * roadmap had no way into its next draft. An owner requests changes on a roadmap section,
 * stages the item for the agents, and Build draft 2 · 1 staged (next to Approve version)
 * starts the next draft.
 *
 * Fixture: usage-alerts-roadmap v1 (Summary, Items by horizon), nothing staged.
 */
const ROADMAP = "/documents/usage-alerts-roadmap/v/1";
const ASK = "Should spend limits move to Next?";

test("a roadmap section's staged change shows Build draft, and Build starts the next draft", async ({ page }) => {
  await login(page);
  await page.goto(ROADMAP);
  await expect(page.getByTestId("document-sections")).toBeVisible();
  const header = page.getByTestId("doc-header");
  const build = header.getByTestId("build-draft").filter({ visible: true });
  await expect(header.getByRole("button", { name: "Approve version" })).toBeVisible();
  await expect(build).toHaveCount(0);

  const bar = (await openSection(page, "summary")).getByTestId("review-bar");
  await bar.getByRole("group", { name: /^Verdict for/ }).getByRole("button", { name: "Request changes" }).click();
  await bar.getByLabel(/What should change/).fill(ASK);
  await bar.getByTestId("verdict-submit").click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Changes requested");

  const panel = page.getByTestId("review-panel").filter({ visible: true });
  const item = panel.getByTestId("feedback-item").filter({ hasText: ASK });
  await item.getByRole("button", { name: "Stage for agents" }).click();
  await expect(item.getByTestId("agent-staged")).toHaveText("Staged for draft 2 · agents");

  await expect(build).toContainText("Build draft 2");
  await expect(build.getByTestId("build-draft-count")).toHaveText("· 1 staged");
  await build.click();
  const sheet = page.getByTestId("next-draft-sheet");
  await expect(sheet.getByTestId("agent-list").getByTestId("agent-item")).toContainText(ASK);
  await sheet.getByRole("button", { name: "Build draft 2" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByText("Feedback loop").filter({ visible: true }).first()).toBeVisible();
});
