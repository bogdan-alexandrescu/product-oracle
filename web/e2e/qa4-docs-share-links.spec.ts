import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 4, docs-share lane, "links" group: a roadmap's Share links (View log, Extend,
// Revoke, the Share sheet) and the link holder's /s/<token> page. The "sharing" scenario seeds
// the published Platform roadmap, autumn (its Team, all-hands link ends 11 days from the mock's
// now) and Usage alerts roadmap, not yet published, with no links.

const DOC = "/documents/example-labs-roadmap";
const UNPUBLISHED = "/documents/usage-alerts-roadmap";
const FRAME = 'iframe[title="Shared roadmap"]';

async function sharing(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
}

/** An owner makes a link for `audience` with downloads on; returns its path and passcode. */
async function makeLink(page: Page, audience: "board" | "team" = "board", label = "Board, November meeting") {
  await page.goto(`${DOC}?audience=${audience}`);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Label").fill(label);
  await sheet.getByLabel("Allow PDF download").check();
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  return { path: new URL(url).pathname, code };
}

/** This tab opens the link as its holder. */
async function open(page: Page, path: string, code: string) {
  await page.goto(path);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.frameLocator(FRAME).getByText(/^Shared with you/)).toBeVisible();
}

const linkRow = (page: Page, label: string) => page.getByTestId("share-links").getByRole("row").filter({ hasText: label });

async function viewLog(page: Page, label: string) {
  await page.goto(DOC);
  await linkRow(page, label).getByRole("button", { name: "View log" }).click();
  return page.getByRole("dialog", { name: `View log: ${label}` });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-docs-share-6: the View log names one time zone and its day headers match the rows", async ({ page }) => {
    // 9:30 PM on Oct 22 in the Company time zone (Pacific), already Oct 23 in UTC.
    await page.clock.setSystemTime(new Date("2026-10-23T04:30:00Z"));
    await sharing(page);
    const { path, code } = await makeLink(page, "team", "Team, late review");
    await open(page, path, code);
    const log = await viewLog(page, "Team, late review");
    await expect(log.getByTestId("view-zone")).toContainText("Pacific Time");
    await expect(log).not.toContainText("UTC");
    const entry = log.getByTestId("view-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(/Oct 22, 2026, 9:3\d PM P[DS]T/);
    await expect(log.getByTestId("view-day")).toHaveCount(1);
    await expect(log.getByTestId("view-day")).toContainText("Oct 22, 2026");
    await expect(log.getByTestId("view-day")).not.toContainText("Oct 23");
  });

  test("qa4-docs-share-27: the View log counts page views and downloads apart", async ({ page }) => {
    await sharing(page);
    const { path, code } = await makeLink(page);
    await open(page, path, code);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    await download;
    const log = await viewLog(page, "Board, November meeting");
    await expect(log.getByTestId("view-entry")).toHaveCount(2);
    await expect(log).toContainText("1 page view · 1 download · 1 browser");
    await expect(log).not.toContainText("2 views");
  });

  test("qa4-docs-share-25: Download PDF saves a file named after the roadmap and the date", async ({ page }) => {
    await sharing(page);
    const { path, code } = await makeLink(page);
    await open(page, path, code);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    const name = (await download).suggestedFilename();
    expect(name).not.toBe("roadmap.pdf");
    expect(name).toMatch(/^Platform roadmap, autumn - [A-Z][a-z]{2} \d{1,2}, \d{4}\.pdf$/);
  });

  test("qa4-docs-share-7: Extend shows the new end and never offers a shorter one", async ({ page }) => {
    await sharing(page);
    await page.goto(DOC);
    await linkRow(page, "Team, all-hands").getByRole("button", { name: "Extend" }).click();
    const extend = page.getByRole("dialog", { name: "Extend link" });
    const expires = extend.getByLabel("Expires");
    // The link ends 11 days from now: 24 hours and 7 days would end it sooner.
    for (const key of ["24h", "7d"]) {
      const option = expires.locator(`option[value="${key}"]`);
      await expect(option).toBeDisabled();
      await expect(option).toContainText("would end it sooner");
    }
    await expect(expires.locator('option[value="14d"]')).toBeEnabled();
    await expect(expires.locator('option[value="14d"]')).toContainText(/14 days from now · ends [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    await expect(expires).toHaveValue("14d");
    await expect(extend.getByTestId("extend-new-end")).toHaveText(/^The link will end on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
    await expires.selectOption("30d");
    const thirty = (await expires.locator('option[value="30d"]').innerText()).match(/ends (.+)$/)![1];
    await expect(extend.getByTestId("extend-new-end")).toHaveText(`The link will end on ${thirty}.`);
    await extend.getByRole("button", { name: "Extend" }).click();
    await expect(linkRow(page, "Team, all-hands").getByTestId("share-expires")).toHaveText(thirty);
  });

  test("qa4-docs-share-16: the empty Share links card names the Share a link button", async ({ page }) => {
    await sharing(page);
    await page.goto(UNPUBLISHED);
    const links = page.getByTestId("share-links");
    await expect(links).toContainText("No links yet. Use Share a link above to make one.");
    await expect(links).not.toContainText("Use Share above");
    await expect(page.getByRole("button", { name: "Share a link", exact: true })).toBeVisible();
  });

  test("qa4-docs-share-18: the Share sheet calls it a date source, as Plan › Dates does", async ({ page }) => {
    await sharing(page);
    await page.goto(UNPUBLISHED);
    await page.getByRole("button", { name: "Share a link", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Share roadmap" });
    await expect(sheet.getByText("Add a date source for each date on Plan › Dates", { exact: false })).toBeVisible();
    await expect(sheet).not.toContainText("schedule basis");
  });

  test("qa4-docs-share-23: Add a label first shows only after trying Create link without one", async ({ page }) => {
    await sharing(page);
    await page.goto(DOC);
    await page.getByRole("button", { name: "Share a link", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Share roadmap" });
    const create = sheet.getByRole("button", { name: "Create link" });
    await expect(sheet.getByLabel("Label (required)")).toBeVisible();
    await expect(sheet.getByText("Add a label first.")).toHaveCount(0);
    await create.click();
    await expect(sheet.getByRole("alert").filter({ hasText: "Add a label first." })).toBeVisible();
    await expect(sheet.getByLabel("Label (required)")).toBeFocused();
    await sheet.getByLabel("Label (required)").fill("Board, November meeting");
    await expect(sheet.getByText("Add a label first.")).toHaveCount(0);
  });

  test("qa4-docs-share-29, 30: Revoke says right away; the revoked row shows when, who and why, and the count matches", async ({ page }) => {
    await sharing(page);
    await page.goto(DOC);
    const row = linkRow(page, "Team, all-hands");
    await row.getByRole("button", { name: "Revoke" }).click();
    const revoke = page.getByRole("dialog", { name: "Revoke link" });
    await expect(revoke).toContainText("Team, all-hands stops working right away.");
    await expect(revoke).not.toContainText("next request");
    await revoke.getByLabel("Reason (optional)").fill("Meeting moved");
    await revoke.getByRole("button", { name: "Revoke link" }).click();
    await expect(row.getByTestId("share-state")).toHaveText("Revoked");
    // qa4fix-docs-share review: and who revoked it, by name.
    await expect(row.getByTestId("share-revoked")).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4} · by \S.* · Reason: Meeting moved$/);
    await expect(row.getByTestId("share-revoked")).not.toContainText("by A member");
    const count = page.locator('section[aria-label="Share links"]').getByTestId("panel-count");
    await expect(count).toHaveText(/^0 active · \d+ total$/);
  });

  test("qa4-docs-share-31: a revoked link opened with its right passcode does not blame the passcode", async ({ page }) => {
    await sharing(page);
    const { path, code } = await makeLink(page, "board", "Board, ended early");
    await page.goto(DOC);
    await linkRow(page, "Board, ended early").getByRole("button", { name: "Revoke" }).click();
    const revoke = page.getByRole("dialog", { name: "Revoke link" });
    await revoke.getByRole("button", { name: "Revoke link" }).click();
    await expect(linkRow(page, "Board, ended early").getByTestId("share-state")).toHaveText("Revoked");
    await page.goto(path);
    await page.getByLabel("Passcode").fill(code);
    await page.getByRole("button", { name: "Open" }).click();
    const note = page.getByRole("alert").filter({ hasText: /\S/ });
    await expect(note).toContainText("The passcode may be wrong, or the link may have ended.");
    await expect(note).not.toContainText("That passcode did not open a link");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa4-docs-share-5: the shared roadmap's cards stack in one column on a phone", async ({ page }) => {
    await sharing(page);
    const { path, code } = await makeLink(page, "team", "Team, phone check");
    await open(page, path, code);
    const frame = page.frameLocator(FRAME);
    const cards = frame.locator(".section-group > .group-body > .prd-section:not(.section-wide)");
    await expect(cards.first()).toBeVisible();
    const frameBox = (await page.getByTestId("shared-frame").boundingBox())!;
    const card = (await cards.first().boundingBox())!;
    // One column: a card takes most of the frame's width, not a third of it.
    expect(card.width).toBeGreaterThan(frameBox.width * 0.8);
  });

  test("qa4-docs-share-26: the shared page's title and Download PDF stack; no line starts with a separator", async ({ page }) => {
    await sharing(page);
    const { path, code } = await makeLink(page);
    await open(page, path, code);
    const header = page.getByTestId("shared-header");
    const title = (await header.getByRole("heading", { level: 1 }).boundingBox())!;
    const button = (await header.getByRole("button", { name: "Download PDF" }).boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    const lines = (await page.getByTestId("shared-about").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith("·")).toBe(false);
    await expect(page.getByTestId("shared-about")).toContainText("Link ends");
  });

  test("qa4-docs-share-28: a share link row on a phone labels its end date and views", async ({ page }) => {
    await sharing(page);
    await page.goto(DOC);
    const row = linkRow(page, "Team, all-hands");
    await expect(row.getByText("Ends", { exact: true })).toBeVisible();
    await expect(row.getByText("Views", { exact: true })).toBeVisible();
  });
});
