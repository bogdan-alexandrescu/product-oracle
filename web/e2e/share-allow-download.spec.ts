import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * O5 owner decision (2026-10-26): the shared page /s/<token> shows Download PDF only when the
 * link allows downloads. An owner creates a link in the Share sheet with "Allow PDF download"
 * off or on; a link holder opens it with its passcode, and again after a reload (the page then
 * reads the link's status, which answers allow_download once the passcode opened it).
 */

const DOC = "/documents/example-labs-roadmap";

async function shareBoard(page: Page, label: string, download: boolean) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  await page.goto(`${DOC}?audience=board`);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Label").fill(label);
  const allow = sheet.getByLabel("Allow PDF download");
  if (download) await allow.check();
  else await allow.uncheck();
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  // The holder opens the link in a second tab of this browser (the mock keeps its state here).
  const holder = await page.context().newPage();
  await holder.goto(new URL(url).pathname);
  await expect(holder.getByRole("heading", { name: "Enter the passcode" })).toBeVisible();
  // Locked: nothing about the link, so no Download PDF either.
  await expect(holder.getByRole("button", { name: "Download PDF" })).toHaveCount(0);
  await holder.getByLabel("Passcode").fill(code);
  await holder.getByRole("button", { name: "Open" }).click();
  const shared = holder.frameLocator('iframe[title="Shared roadmap"]');
  await expect(shared.getByText(/^Shared with you/)).toBeVisible();
  return holder;
}

test("a link with downloads off: the shared page shows no Download PDF", async ({ page }) => {
  const holder = await shareBoard(page, "Board, no downloads", false);
  await expect(holder.getByRole("button", { name: "Download PDF" })).toHaveCount(0);
  await holder.reload();
  await expect(holder.frameLocator('iframe[title="Shared roadmap"]').getByText(/^Shared with you/)).toBeVisible();
  await expect(holder.getByRole("button", { name: "Download PDF" })).toHaveCount(0);
});

test("a link with downloads on: the shared page shows Download PDF and it downloads", async ({ page }) => {
  const holder = await shareBoard(page, "Board, with downloads", true);
  await expect(holder.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await holder.reload();
  await expect(holder.frameLocator('iframe[title="Shared roadmap"]').getByText(/^Shared with you/)).toBeVisible();
  const button = holder.getByRole("button", { name: "Download PDF" });
  await expect(button).toBeVisible();
  const download = holder.waitForEvent("download");
  await button.click();
  expect((await download).suggestedFilename()).toMatch(/^Platform roadmap, autumn - [A-Z][a-z]{2} \d{1,2}, \d{4}\.pdf$/);
});
