import { expect, test, type Page, mockNow } from "./test";

import { login, openSection, section, selectText, signOut } from "./helpers";

/*
 * H8 Board and investor drafts (issue #198, criterion 10): Company › Updates, the New update
 * sheet that drafts with Oracle, the Asks placeholder, the unverified-date block on Approve,
 * the two-slide board deck, who sees updates, and the phone page. The mock company starts
 * with two synthetic updates for the fictional "Example Co", seen by owners and approvers:
 * "Investor update · September 2026" (approved) and "Board update · October 2026" (in
 * review, one date in its timeline rests on no verified basis).
 * Each test states its card: protects / fails_when / no_claim.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Company › Updates from the rail, as a person gets there. */
async function openUpdates(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  // Company opens on its first tab (Strategy since H4).
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-updates").click();
  await expect(page).toHaveURL(/\/company\/updates$/);
}

/** Opens an update's latest version from the Updates table. */
async function openUpdate(page: Page, title: string) {
  await page.getByTestId("updates-table").getByRole("link", { name: title }).click();
  await page.getByRole("link", { name: /^Open latest/ }).click();
  await expect(page).toHaveURL(/\/documents\/[^/]+\/v\/\d+/);
}

test("10a: New update › Investor update drafts with Oracle: metrics first, Asks highlighted, Company › Updates", async ({ page }) => {
  // protects=an owner opens Company › Updates, clicks New update, picks Investor update, sees
  // the period prefilled (the day after the last approved investor update, Sep 30, through
  // today) and the title "Investor update · <month>", clicks Draft with Oracle and lands on the
  // new update, whose Oracle draft opens on Metrics then Asks, the Asks placeholder highlighted,
  // Company highlighted in the rail and the crumb "Company › Updates"; fails_when=New update is
  // missing, the period or title is not prefilled, the draft is not written by the run, Metrics
  // is not first, the placeholder is not highlighted, or the page names PRDs; no_claim=the real
  // agents' wording, the API's estimate figures (the mock runtime writes a fixed draft).
  await login(page);
  await openUpdates(page);
  await page.getByRole("button", { name: "New update" }).click();
  const sheet = page.getByRole("dialog", { name: "New update" });
  await sheet.getByRole("radio", { name: /Board product section/ }).check();
  await sheet.getByRole("radio", { name: /Investor update/ }).check();
  const now = mockNow();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  await expect(sheet.getByLabel("From", { exact: true })).toHaveValue("2026-10-01");
  await expect(sheet.getByLabel("To", { exact: true })).toHaveValue(today);
  const title = `Investor update · ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  await expect(sheet.getByLabel("Title")).toHaveValue(title);
  await sheet.getByRole("button", { name: "Draft with Oracle" }).click();

  await expect(page).toHaveURL(/\/documents\/investor-update-[a-z0-9-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).first();
  await expect(crumb).toContainText("Company › Updates");
  await expect(page.getByTestId("app-nav").getByTestId("nav-company")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("app-nav").getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");
  // The run's draft is the latest version (v2 after the template's v1).
  await page.getByRole("link", { name: "Open latest (v2)" }).click();
  const rail = page.getByTestId("outline-rail").filter({ visible: true });
  const rows = rail.locator("a[data-outline-key]");
  await expect(rows.nth(0)).toHaveAttribute("data-outline-key", "metrics");
  await expect(rows.nth(1)).toHaveAttribute("data-outline-key", "asks");
  await expect(section(page, "metrics")).toBeVisible();
  await expect(section(page, "metrics").getByRole("table")).toContainText("Weekly active teams");
  const asks = await openSection(page, "asks");
  const placeholder = asks.getByTestId("asks-placeholder");
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toContainText("Owner to fill: what you need from investors this month");
  await expect(placeholder).toHaveCSS("border-top-width", "2px");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).first()).toContainText("Company › Updates");
  await expect(page.getByTestId("app-nav").getByTestId("nav-company")).toHaveAttribute("aria-current", "page");
});

test("10b: a version with an unverified date shows the marker and Approve is disabled: Resolve 1 unverified date", async ({ page }) => {
  // protects=the board update's v1 writes "2027-01-19", which no verified schedule basis of any
  // PRD with an active track supports: the timeline shows the "unverified" marker after it, and
  // the owner's Approve version is disabled with the tooltip "Resolve 1 unverified date"; the
  // verified Beta date carries no marker; fails_when=the marker is missing, the verified date is
  // marked, or Approve is enabled or names another count; no_claim=the API's date parser (the
  // mock checks ISO dates against the seeded bases).
  await login(page);
  await openUpdates(page);
  await openUpdate(page, "Board update · October 2026");
  const timeline = await openSection(page, "timeline");
  const marks = timeline.locator("[data-date-mark]");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText("unverified");
  await expect(marks.first()).toHaveAttribute("data-date-mark", "unverified");
  const approve = page.getByRole("button", { name: "Approve version" });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute("title", "Resolve 1 unverified date");
  await expect(page.getByTestId("approve-blocked")).toContainText("Resolve 1 unverified date");
  // The owner reviews sections of an update.
  await expect(timeline.getByRole("group", { name: "Verdict for Timeline" })).toBeVisible();
});

test("10c: Present on a board update shows its brief as 2 slides", async ({ page }) => {
  // protects=the board update's front matter groups its six brief sections into two slides:
  // Present shows the title slide, "Product in one line" (with Goals under it), "Timeline" (with
  // shipped, slipped and the asks under it), then Sources and data points; fails_when=each brief
  // section becomes its own slide, or a group loses a section; no_claim=the PPTX export's layout.
  await login(page);
  await openUpdates(page);
  await openUpdate(page, "Board update · October 2026");
  await page.getByRole("link", { name: "Present" }).click();
  await expect(page).toHaveURL(/\/present$/);
  const present = page.getByTestId("present-mode");
  const counter = page.getByTestId("slide-counter");
  // Title, the two product slides, Sources and data points.
  await expect(counter).toHaveText("1 / 4");
  await page.keyboard.press("ArrowRight");
  const slide1 = present.getByRole("region", { name: "Slide 2 of 4: Product in one line" });
  await expect(slide1).toBeVisible();
  await expect(present.getByRole("heading", { name: "Goals: where we are" })).toBeVisible();
  await expect(slide1).toContainText("Weekly active teams");
  await page.keyboard.press("ArrowRight");
  const slide2 = present.getByRole("region", { name: "Slide 3 of 4: Timeline" });
  await expect(slide2).toBeVisible();
  for (const h of ["Shipped since last board", "What slipped or did not work", "Decisions we need from the board"]) {
    await expect(present.getByRole("heading", { name: h })).toBeVisible();
  }
  await page.keyboard.press("ArrowRight");
  await expect(present.getByRole("region", { name: "Slide 4 of 4: Sources and data points" })).toBeVisible();
  await expect(counter).toHaveText("4 / 4");
});

test("10d: an approver sees and comments on updates without verdicts or Approve; a commenter sees none", async ({ page }) => {
  // protects=an approver has the Updates tab with both seeded updates, no New update, no row
  // menu, and on an update can comment but has no section verdict buttons and no Approve; a
  // commenter has no Updates tab, /company/updates answers "Not found", the update's own page
  // does not open, and the Sources search finds nothing from an update ("Larkspur" is written
  // only in the updates); fails_when=an approver gets owner controls or cannot comment, or a
  // commenter sees the tab, the list, the update or a search hit; no_claim=the API's 404s on
  // every route (api/tests cover them); the mock search covers source items only.
  await login(page, "approver@example.com");
  await openUpdates(page);
  const rows = page.getByTestId("update-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Board update · October 2026");
  await expect(rows.nth(1)).toContainText("Investor update · September 2026");
  await expect(rows.nth(0).getByTestId("update-visibility")).toHaveText("Owners and approvers");
  await expect(page.getByRole("button", { name: "New update" })).toHaveCount(0);
  await expect(page.getByTestId("update-share")).toHaveCount(0);

  await openUpdate(page, "Board update · October 2026");
  const headline = section(page, "headline");
  await expect(headline).toBeVisible();
  await expect(headline.getByRole("group", { name: /^Verdict for / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  // #370: an approver can never approve an update, so no note about it either.
  await expect(page.getByTestId("owner-approves-note")).toHaveCount(0);
  await selectText(page, "headline", "Usage alerts are ready for beta");
  await page.getByRole("button", { name: /^Comment(\s+c)?$/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Say how many pilot teams are ready for the beta.");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Say how many pilot teams are ready for the beta.").first()).toBeVisible();

  await signOut(page);
  await login(page, "commenter@example.com");
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  const tabs = page.getByRole("navigation", { name: "Company" });
  await expect(tabs.getByTestId("company-tab-decisions")).toBeVisible();
  await expect(tabs.getByTestId("company-tab-updates")).toHaveCount(0);
  await page.goto("/company/updates");
  await expect(page.getByTestId("updates-not-found")).toContainText("Updates are for owners and approvers");
  await expect(page.getByTestId("update-row")).toHaveCount(0);
  await page.goto("/documents/board-update-2026-10");
  await expect(page.getByRole("heading", { level: 1, name: "Document not found" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Board update · October 2026" })).toHaveCount(0);
  await page.goto("/sources");
  await page.getByLabel("Search", { exact: true }).fill("Larkspur");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Nothing in your sources matches “Larkspur”.")).toBeVisible();
  await expect(page.getByTestId("search-hit")).toHaveCount(0);
});

test("10f: Share… › Share with the whole company, with a reason: the row's chip reads Company", async ({ page }) => {
  // protects=an owner presses a row's Share…, gives a reason, and the
  // row's chip reads "Company" (and still does after a reload); a commenter can then open that
  // update; fails_when=the menu item is missing, no reason is asked, the chip does not change,
  // or the update stays hidden from the company; no_claim=the audit event (the API records it).
  await login(page);
  await openUpdates(page);
  const row = page.getByTestId("update-row").filter({ hasText: "Investor update · September 2026" });
  await expect(row.getByTestId("update-visibility")).toHaveText("Owners and approvers");
  await row.getByRole("button", { name: "Share Investor update · September 2026 with the whole company" }).click();
  const dialog = page.getByRole("dialog", { name: "Share with the whole company" });
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByText("Say why")).toBeVisible();
  await dialog.getByLabel("Reason").fill("The team asked to read the September numbers.");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByTestId("update-visibility")).toHaveText("Company");
  await page.reload();
  await expect(page.getByTestId("update-row").filter({ hasText: "Investor update · September 2026" }).getByTestId("update-visibility")).toHaveText(
    "Company",
  );
  // The other update stays with owners and approvers.
  await expect(page.getByTestId("update-row").filter({ hasText: "Board update · October 2026" }).getByTestId("update-visibility")).toHaveText(
    "Owners and approvers",
  );
  await expect(row.getByRole("button", { name: "Limit Investor update · September 2026 to owners and approvers" })).toBeVisible();

  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/documents/investor-update-2026-09");
  await expect(page.getByRole("heading", { level: 1, name: "Investor update · September 2026" })).toBeVisible();
});

test("10e: at 390 px an update reads one section at a time, with no sideways scroll", async ({ page }) => {
  // protects=on a phone the Updates list and an update's version fit the width, and the
  // version shows one section at a time with Previous / Next between them, as for PRDs;
  // fails_when=the page scrolls sideways or several sections show at once; no_claim=Chromium's
  // layout only.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByTestId("tab-bar").getByTestId("tab-more").click();
  await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Company" }).click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-updates").click();
  await expect(page.getByTestId("update-row")).toHaveCount(2);
  const width = () => page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
  let w = await width();
  expect(w.sw).toBe(w.iw);
  await openUpdate(page, "Board update · October 2026");
  await expect(section(page, "headline")).toBeVisible();
  await expect(page.locator("section[data-section-key]").filter({ visible: true })).toHaveCount(1);
  w = await width();
  expect(w.sw).toBe(w.iw);
  await page.getByRole("link", { name: "Next section: Goals: where we are" }).filter({ visible: true }).click();
  await expect(section(page, "goals")).toBeVisible();
  await expect(section(page, "headline")).toHaveCount(0);
  await expect(page.locator("section[data-section-key]").filter({ visible: true })).toHaveCount(1);
  w = await width();
  expect(w.sw).toBe(w.iw);
});
