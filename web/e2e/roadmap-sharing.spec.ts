import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * O5 lane 5 (spec-O5 "Screens and copy", owner answer O5-Q5: every link has a passcode):
 * a roadmap's Audience switch, the Share sheet with its passcode shown once, the Links
 * table with View log, Extend, New passcode and Revoke, the signed-out /s/<token> page with
 * its passcode form, the Plan > Roadmap documents Shared column and the owners' Inbox row.
 * The "sharing" scenario seeds a published roadmap (Platform roadmap, autumn v1), one Team link
 * with two views, and two links Oracle revoked when their creator left.
 */

const DOC = "/documents/example-labs-roadmap";

async function sharing(page: Page, email?: string) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page, email);
}

/** Creates a link through the Share sheet and returns its address and passcode, as shown once. */
async function createLink(page: Page, audience: string, label: string, passcode?: string) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Audience").selectOption({ label: audience });
  await sheet.getByLabel("Label").fill(label);
  if (passcode) await sheet.getByLabel("Passcode (optional)").fill(passcode);
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  return { sheet, url, code };
}

test("an owner switches the audience: Board hides its sections and goal-less items", async ({ page }) => {
  await sharing(page);
  await page.goto(DOC);
  const audience = page.getByRole("radiogroup", { name: "Audience" });
  // The document's default audience (the picker's answer) is preselected.
  await expect(audience.getByRole("radio", { name: "Team" })).toHaveAttribute("aria-checked", "true");
  const team = page.frameLocator('iframe[title="Roadmap for Team"]');
  await expect(team.getByRole("heading", { name: "Dependencies and owners" })).toBeVisible();
  await expect(team.getByRole("heading", { name: "Ops console cleanup" })).toBeVisible();

  await audience.getByRole("radio", { name: "Board" }).click();
  await expect(page).toHaveURL(/[?&]audience=board/);
  const board = page.frameLocator('iframe[title="Roadmap for Board"]');
  await expect(board.getByText("Audience Board", { exact: true })).toBeVisible();
  await expect(board.getByRole("heading", { name: "Dependencies and owners" })).toHaveCount(0);
  await expect(board.getByRole("heading", { name: "Ops console cleanup" })).toHaveCount(0);
  await expect(board.getByText("1 item serves no confirmed goal and is left out.")).toBeVisible();

  // The URL holds the audience: a reload keeps it.
  await page.reload();
  await expect(page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true");
});

test("share a Board link: the address and passcode are shown once; the holder needs the passcode", async ({ page }) => {
  await sharing(page);
  await page.goto(`${DOC}?audience=board`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  // The sheet preselects the page's audience and 14 days, with downloads allowed.
  await expect(sheet.getByLabel("Audience")).toHaveValue("board");
  await expect(sheet.getByLabel("Expires")).toHaveValue("14d");
  await expect(sheet.getByLabel("Allow PDF download")).toBeChecked();
  await expect(sheet.getByText("A downloaded PDF can't be revoked")).toBeVisible();
  await expect(sheet.getByLabel("Label")).toHaveAttribute("placeholder", "Board, October meeting");
  await sheet.getByLabel("Label").fill("Board, October meeting");
  await sheet.getByRole("button", { name: "Create link" }).click();

  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{20,}$/);
  // Oracle made the passcode: four groups of four.
  expect(code).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  await expect(sheet.getByText(/Only people you send this link and passcode to can open it\. It ends on .*Nov/)).toBeVisible();
  await expect(sheet.getByText("This passcode is shown once. Send it apart from the link.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Copy passcode" })).toBeVisible();
  await sheet.getByRole("button", { name: "Done" }).click();

  const links = page.getByTestId("share-links");
  const row = links.getByRole("row").filter({ hasText: "Board, October meeting" });
  await expect(row).toContainText("Board");
  await expect(row).toContainText("v1");
  await expect(row).toContainText("Admin");
  await expect(row.getByTestId("share-state")).toHaveText("Active");
  await expect(row.getByTestId("share-views")).toHaveText("0");
  // The token is gone: no Copy on the row.
  await expect(row.getByRole("button", { name: /Copy/ })).toHaveCount(0);

  // A link holder, signed out, in a fresh browser: the passcode form first.
  // A link holder: the mock keeps its state in this browser's storage, so the holder opens
  // the link in a second tab of it; the page itself calls only the public share routes.
  const holder = await page.context().newPage();
  await holder.goto(new URL(url).pathname);
  await expect(holder.getByRole("heading", { name: "Enter the passcode" })).toBeVisible();
  await expect(holder.getByText("Example Co")).toHaveCount(0);
  await holder.getByLabel("Passcode").fill("wrong-pass-code");
  await holder.getByRole("button", { name: "Open" }).click();
  await expect(holder.getByText("That passcode did not open a link.")).toBeVisible();
  await holder.getByLabel("Passcode").fill(code);
  await holder.getByRole("button", { name: "Open" }).click();
  const shared = holder.frameLocator('iframe[title="Shared roadmap"]');
  await expect(shared.getByText("Audience Board", { exact: true })).toBeVisible();
  await expect(holder.getByRole("button", { name: "Download PDF" })).toBeVisible();
});

test("the Links table: View log, New passcode and Revoke, and the ended page", async ({ page }) => {
  await sharing(page);
  await page.goto(DOC);
  const { url, code, sheet } = await createLink(page, "Board", "Board, October meeting", "board-oct-2026");
  expect(code).toBe("board-oct-2026");
  await sheet.getByRole("button", { name: "Done" }).click();

  // Open the link with its passcode in this browser (one view), then come back.
  const path = new URL(url).pathname;
  await page.goto(path);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.frameLocator('iframe[title="Shared roadmap"]').getByText("Audience Board", { exact: true })).toBeVisible();

  await page.goto(DOC);
  const row = page.getByTestId("share-links").getByRole("row").filter({ hasText: "Board, October meeting" });
  await expect(row.getByTestId("share-views")).toHaveText("1");
  await row.getByRole("button", { name: "View log" }).click();
  const log = page.getByRole("dialog", { name: "View log: Board, October meeting" });
  await expect(log.getByText("Counts browsers, not people. Oracle never records who opened a link.")).toBeVisible();
  await expect(log.getByTestId("view-entry")).toHaveCount(1);
  await expect(log.getByTestId("view-entry").first()).toContainText("Page");
  await expect(log.getByTestId("distinct-browsers")).toHaveText("1 browser");
  await expect(log.getByTestId("view-day")).toHaveCount(1);
  await log.getByRole("button", { name: "Done" }).click();

  // A new passcode keeps the link: the old one stops opening it, the new one is shown once.
  await row.getByRole("button", { name: "New passcode" }).click();
  const rotate = page.getByRole("dialog", { name: "New passcode" });
  await rotate.getByRole("button", { name: "Make a new passcode" }).click();
  const fresh = await rotate.getByLabel("Passcode", { exact: true }).inputValue();
  expect(fresh).not.toBe(code);
  await expect(rotate.getByText("This passcode is shown once. Send it apart from the link.")).toBeVisible();
  await rotate.getByRole("button", { name: "Done" }).click();

  // The rotation ended this browser's opening: the old passcode no longer opens it, the new one does.
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Enter the passcode" })).toBeVisible();
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("That passcode did not open a link.")).toBeVisible();
  await page.getByLabel("Passcode").fill(fresh);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.frameLocator('iframe[title="Shared roadmap"]').getByText("Audience Board", { exact: true })).toBeVisible();

  await page.goto(DOC);
  await expect(row.getByTestId("share-views")).toHaveText("2");
  await row.getByRole("button", { name: "Revoke" }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke link" });
  await revoke.getByLabel("Reason (optional)").fill("Meeting moved");
  await revoke.getByRole("button", { name: "Revoke link" }).click();
  await expect(row.getByTestId("share-state")).toHaveText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  // The holder's next request is refused, with no company name.
  await page.goto(path);
  await expect(page.getByText("This link has ended. Ask the person who sent it for a new one.")).toBeVisible();
  await expect(page.getByText("Example Co")).toHaveCount(0);
});

test("Extend and Move to a newer version keep the link", async ({ page }) => {
  await sharing(page);
  await page.goto(DOC);
  const row = page.getByTestId("share-links").getByRole("row").filter({ hasText: "Team, all-hands" });
  await expect(row).toContainText("v1");
  await row.getByRole("button", { name: "Extend" }).click();
  const extend = page.getByRole("dialog", { name: "Extend link" });
  await extend.getByLabel("Expires").selectOption("90d");
  await extend.getByRole("button", { name: "Extend" }).click();
  await expect(row.getByTestId("share-expires")).toContainText("Jan");
});

for (const email of ["viewer@example.com", "commenter@example.com"]) {
  test(`${email.split("@")[0]}s switch audience but see no Share action, no links and no Public`, async ({ page }) => {
    await sharing(page, email);
    await page.goto(DOC);
    const audience = page.getByRole("radiogroup", { name: "Audience" });
    await audience.getByRole("radio", { name: "Board" }).click();
    await expect(page.frameLocator('iframe[title="Roadmap for Board"]').getByText("Audience Board", { exact: true })).toBeVisible();
    await expect(audience.getByRole("radio", { name: "Public" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("share-links")).toHaveCount(0);
  });
}

test("an approver shares Board, Team and Engineering, never Public", async ({ page }) => {
  await sharing(page, "approver@example.com");
  await page.goto(DOC);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  const options = sheet.getByLabel("Audience").locator("option");
  await expect(options).toHaveText(["Board", "Team", "Engineering", "Public (owners only)"]);
  await expect(sheet.getByLabel("Audience").locator('option[value="public"]')).toBeDisabled();
  // The seeded Team link is an owner's: an approver may revoke it (not Public), not extend it.
  await sheet.getByRole("button", { name: "Cancel" }).click();
  const row = page.getByTestId("share-links").getByRole("row").filter({ hasText: "Team, all-hands" });
  await expect(row.getByRole("button", { name: "Revoke" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Extend" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "New passcode" })).toHaveCount(0);
});

test("an unpublished roadmap asks to publish first", async ({ page }) => {
  await sharing(page);
  await page.goto("/documents/usage-alerts-roadmap");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await expect(sheet.getByText("Publish this version first")).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Publish" })).toHaveAttribute("href", "/documents/usage-alerts-roadmap/publish");
  await expect(sheet.getByRole("button", { name: "Create link" })).toHaveCount(0);
});

test("Plan > Roadmap documents shows each roadmap's active links and next expiry", async ({ page }) => {
  await sharing(page);
  await page.goto("/plan/documents");
  const row = page.getByRole("row").filter({ hasText: "Platform roadmap, autumn" });
  await expect(row.getByTestId("shared-cell")).toContainText("1 active");
  await expect(row.getByTestId("shared-cell")).toContainText(/ends .*Nov/);
  const other = page.getByRole("row").filter({ hasText: "Usage alerts roadmap" });
  await expect(other.getByTestId("shared-cell")).toHaveText("—");
});

test("owners' Inbox: links revoked when their creator left, with Re-share and Dismiss", async ({ page }) => {
  await sharing(page);
  await page.goto("/inbox");
  const need = page.getByTestId("inbox-needs").getByRole("row").filter({ hasText: "Links revoked" });
  await expect(need).toContainText("Links revoked: former.pm left · 2 links");
  await expect(need.getByRole("link", { name: "Re-share" })).toHaveAttribute("href", "/documents/example-labs-roadmap?share=board");
  await need.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("inbox-needs").getByRole("row").filter({ hasText: "Links revoked" })).toHaveCount(0);
});

test("Re-share opens the Share sheet on the document, in the link's audience", async ({ page }) => {
  await sharing(page);
  await page.goto("/documents/example-labs-roadmap?share=board");
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await expect(sheet.getByLabel("Audience")).toHaveValue("board");
});
