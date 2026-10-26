import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * v2 screen 3: the Evidence inspector for a PRD version (picks.md 3: C's coverage matrix as
 * the main view, A's section table + inspector as the second view). Driven through the UI
 * on the mock as each role would. The "evidence" scenario adds section links to
 * Checkout redesign PRD v2 (evidence, a restricted source item, a stale and a claim link)
 * and one to the approved Usage alerts PRD v1.
 */

const DOC = "/documents/checkout-redesign";

async function open(page: Page, email?: string, scenario = "evidence") {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

/** Opens v2's Document tab and goes to Evidence by its version tab, as a person would. */
async function evidenceTab(page: Page, email?: string) {
  await open(page, email);
  await page.goto(`${DOC}/v/2`);
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/evidence/);
  await expect(page.getByTestId("evidence-matrix")).toBeVisible();
}

const column = (page: Page, key: string) => page.getByTestId("evidence-matrix").locator(`th[data-section="${key}"]`);
const cell = (page: Page, target: string, key: string) =>
  page.getByTestId("evidence-matrix").locator(`tr[data-target]`, { hasText: target }).locator(`td[data-section="${key}"]`);

test("evidence: the owner reads the coverage matrix and links a target to an unsupported section", async ({ page }) => {
  await evidenceTab(page);
  const tab = page.getByTestId("version-tab-evidence").filter({ visible: true });
  await expect(tab).toHaveAttribute("aria-current", "page");
  // Sections as columns; a section with neither links nor citations is flagged.
  await expect(column(page, "metrics")).toHaveAttribute("data-gap", "true");
  await expect(column(page, "problem")).not.toHaveAttribute("data-gap", "true");
  await expect(page.getByTestId("evidence-unsupported")).toContainText("unsupported");
  // Targets as rows, grouped; a cell is the link's kind and confidence, dashed when stale.
  await expect(page.getByTestId("evidence-matrix").getByText("Baseline items")).toBeVisible();
  await expect(page.getByTestId("evidence-matrix").getByText("Draft citations")).toBeVisible();
  await expect(cell(page, "Usage export", "goal-trace")).toHaveAttribute("data-stale", "true");
  await expect(cell(page, "Guided setup", "scope")).toContainText("Tests");
  // The per-section totals: links · citations.
  await expect(page.getByTestId("evidence-totals").locator('td[data-section="metrics"]')).toHaveText("0 · 0");

  // A cell opens the target-centred inspector: every section that links it.
  await cell(page, "Guided setup", "scope").getByRole("button").click();
  const insp = page.getByRole("complementary", { name: "Guided setup" });
  await expect(insp.getByText("Links in v2")).toBeVisible();
  await expect(insp.getByTestId("evidence-link")).toHaveCount(1);
  await expect(insp.getByRole("button", { name: "Remove" })).toBeVisible();

  // Link to another section: Metrics is offered first, marked unsupported.
  const form = insp.getByRole("form", { name: "Link to another section" });
  await form.getByLabel("Section").selectOption({ label: "7. Success metrics (metrics) · unsupported" });
  await form.getByLabel("Kind").selectOption("implements");
  await form.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByText("Link added.")).toBeVisible();
  await expect(insp.getByTestId("evidence-link")).toHaveCount(2);
  await expect(column(page, "metrics")).not.toHaveAttribute("data-gap", "true");
  await expect(cell(page, "Guided setup", "metrics")).toContainText("Impl");
});

test("evidence: past 6 sections the matrix scrolls inside its panel, never the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await evidenceTab(page);
  const scroller = page.getByTestId("evidence-matrix-scroll");
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("evidence: the filter chips hide citations and keep only stale links", async ({ page }) => {
  await evidenceTab(page);
  const m = page.getByTestId("evidence-matrix");
  await page.getByRole("button", { name: /^Citations/ }).click();
  await expect(m.getByText("Draft citations")).toHaveCount(0);
  await page.getByRole("button", { name: /^Stale only/ }).click();
  await expect(m.locator("tr[data-target]")).toHaveCount(2);
  await expect(m.locator("tr[data-target]", { hasText: "Usage export" })).toBeVisible();
});

test("evidence: the approver's section view lists links strongest first, the draft's citations, and removes a link", async ({ page }) => {
  await evidenceTab(page, "approver@example.com");
  await page.getByRole("group", { name: "Evidence view" }).getByRole("button", { name: "Sections" }).click();
  const table = page.getByRole("grid", { name: "Sections" });
  await expect(table).toBeVisible();
  await expect(page).toHaveURL(/view=sections/);
  // No links or citations: the unsupported sections only.
  await page.getByRole("group", { name: "Sections shown" }).getByRole("button", { name: /No links or citations/ }).click();
  await expect(table.getByRole("row", { name: /Success metrics/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Goal trace/ })).toHaveCount(0);
  await page.getByRole("group", { name: "Sections shown" }).getByRole("button", { name: /All sections/ }).click();

  await table.getByRole("row", { name: /Goal trace/ }).click();
  const insp = page.getByRole("complementary", { name: "1. Goal trace" });
  await expect(insp.getByText("strongest first")).toBeVisible();
  const links = insp.getByTestId("evidence-link");
  // Scored links first, highest confidence first; unscored last.
  const scores = await links.locator("[data-confidence]").evaluateAll((els) => els.map((e) => e.getAttribute("data-confidence")));
  const scored = scores.filter((s) => s !== "").map(Number);
  expect(scored).toEqual([...scored].sort((a, b) => b - a));
  expect(scores.indexOf("")).toBeGreaterThanOrEqual(scored.length === scores.length ? -1 : scored.length);
  // The claim link shows its claim; the stale one says so.
  await expect(insp.getByText("“Week-1 activation rises once the cost shows early.”")).toBeVisible();
  await expect(insp.getByText("Stale link", { exact: true })).toBeVisible();
  // The draft's own citation in this section.
  await expect(insp.getByTestId("evidence-citation")).toContainText("c:c3");

  const before = await links.count();
  await links.filter({ hasText: "Usage export" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Link removed.")).toBeVisible();
  await expect(links).toHaveCount(before - 1);
});

test("evidence: the approver adds a claim link from an unsupported section", async ({ page }) => {
  await open(page, "approver@example.com");
  await page.goto(`${DOC}/v/2/evidence?view=sections`);
  const table = page.getByRole("grid", { name: "Sections" });
  await table.getByRole("row", { name: /Success metrics/ }).click();
  const insp = page.getByRole("complementary", { name: "7. Success metrics" });
  await expect(insp.getByText("Nothing backs this section yet: no section links and no citations in the draft.")).toBeVisible();
  const form = insp.getByRole("form", { name: "Add a section link" });
  await form.getByLabel("Kind").selectOption("claims");
  await expect(form.getByLabel(/^Claim/)).toBeDisabled();
  await form.getByLabel("Precision").selectOption("claim");
  await form.getByLabel("Links to").selectOption({ label: "Guided setup · feature:f.guided-setup" });
  await expect(form.getByRole("button", { name: "Add link" })).toBeDisabled();
  await form.getByLabel(/^Claim/).fill("Guided setup lifts week-1 activation.");
  await form.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByText("Link added.")).toBeVisible();
  await expect(insp.getByTestId("evidence-link")).toHaveCount(1);
  await expect(insp.getByText("“Guided setup lifts week-1 activation.”")).toBeVisible();
  await expect(table.getByRole("row", { name: /Success metrics/ })).not.toContainText("unsupported");
});

test("evidence: partial targets — a restricted source shows its kind only, a removed source says so", async ({ page }) => {
  await evidenceTab(page, "approver@example.com");
  const restricted = page.getByTestId("evidence-matrix").locator("tr[data-target]", { hasText: "Restricted source" });
  await expect(restricted).toBeVisible();
  await restricted.locator('td[data-section="problem"]').getByRole("button").click();
  const insp = page.getByRole("complementary", { name: "Restricted source" });
  await expect(insp.getByText("Restricted: someone else’s source. Only its kind is shown.")).toBeVisible();
  // The approver may still remove the link.
  await expect(insp.getByRole("button", { name: "Remove" })).toBeVisible();

  await page.getByTestId("evidence-matrix").locator("tr[data-target]", { hasText: "Onboarding review" }).locator('td[data-section="risks"]').getByRole("button").click();
  const removed = page.getByRole("complementary", { name: "Onboarding review (meeting)" });
  await expect(removed.getByText("Source removed", { exact: true })).toBeVisible();
  await expect(removed.getByText("Stale link")).toBeVisible();
});

for (const who of ["commenter", "viewer"] as const) {
  test(`evidence: a ${who} reads the evidence with no Remove and no link form`, async ({ page }) => {
    await evidenceTab(page, `${who}@example.com`);
    // Drawn once: the header has it for a viewer, the evidence toolbar for a commenter.
    await expect(page.getByText("View only", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await cell(page, "Guided setup", "scope").getByRole("button").click();
    const insp = page.getByRole("complementary", { name: "Guided setup" });
    await expect(insp.getByTestId("evidence-link")).toHaveCount(1);
    await expect(insp.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(insp.getByRole("form")).toHaveCount(0);
    if (who === "commenter") {
      await expect(page.getByText("Section links are added by approvers.", { exact: false })).toBeVisible();
    }
  });
}

test("evidence: an approved version's links are pinned, read only even for the owner", async ({ page }) => {
  await open(page);
  await page.goto("/documents/usage-alerts/v/1/evidence?view=sections");
  await expect(page.getByText("v1 is approved: its evidence links are pinned. Read only.")).toBeVisible();
  await page.getByRole("grid", { name: "Sections" }).getByRole("row", { name: /Behaviour/ }).click();
  const insp = page.getByRole("complementary", { name: "1. Behaviour" });
  await expect(insp.getByTestId("evidence-link").first()).toBeVisible();
  await expect(insp.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(insp.getByRole("form")).toHaveCount(0);
});

test("evidence: ?section= naming no section says so and shows all sections again", async ({ page }) => {
  await open(page);
  await page.goto(`${DOC}/v/2/evidence?section=pricing`);
  await expect(page.getByText("v2 has no section pricing.")).toBeVisible();
  await page.getByRole("button", { name: "Show all sections" }).click();
  await expect(page.getByTestId("evidence-matrix")).toBeVisible();
  await expect(page).not.toHaveURL(/section=/);
});

test("evidence: a version that does not exist offers the latest", async ({ page }) => {
  await open(page);
  await page.goto(`${DOC}/v/7/evidence`);
  await expect(page.getByText("Version 7 of Checkout redesign PRD was not found.")).toBeVisible();
  await page.getByRole("link", { name: "Go to the latest version (v2)" }).click();
  await expect(page).toHaveURL(/\/v\/2\/evidence$/);
  await expect(page.getByTestId("evidence-matrix")).toBeVisible();
});

test("evidence: a version with no links and no citations is empty, with Link a section for the owner", async ({ page }) => {
  await open(page);
  await page.goto("/documents/online-deposits/v/3");
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  await expect(page.getByText("No section of v3 is linked to evidence yet, and the draft cites nothing.")).toBeVisible();
  await page.getByRole("button", { name: "Link a section" }).click();
  await expect(page.getByRole("form", { name: "Add a section link" }).first()).toBeVisible();
});

test("evidence: on a phone the matrix is a list per target, a tap opens the sheet, nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "approver@example.com");
  await page.goto(`${DOC}/v/2/evidence`);
  const list = page.getByTestId("evidence-list");
  await expect(list).toBeVisible();
  const row = list.getByRole("button", { name: /Guided setup/ });
  await expect(row).toContainText("4. Scope");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await row.click();
  const sheet = page.getByRole("dialog", { name: "Guided setup" });
  await expect(sheet.getByTestId("evidence-link")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Close" }).click();
  // The section view on a phone: stacked rows, a sheet per section.
  await page.getByRole("group", { name: "Evidence view" }).getByRole("button", { name: "Sections" }).click();
  await page.getByRole("grid", { name: "Sections" }).getByRole("row", { name: /Goal trace/ }).click();
  await expect(page.getByRole("dialog", { name: "1. Goal trace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("evidence: dark theme renders the matrix with no sideways page scroll", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await evidenceTab(page);
  await expect(column(page, "metrics")).toHaveAttribute("data-gap", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("evidence: a section counts as unsupported only when nothing under it is supported, and the title never does", async ({ page }) => {
  await evidenceTab(page);
  // The level-1 title is never flagged.
  await expect(column(page, "title")).toBeVisible();
  await expect(column(page, "title")).not.toHaveAttribute("data-gap", "true");
  // 5. Proposed flow has nothing of its own, but 5.2 under it cites the draft's sources.
  await expect(column(page, "s-5")).not.toHaveAttribute("data-gap", "true");
  await expect(page.getByTestId("evidence-totals").locator('td[data-section="s-5"]')).toHaveText("0 · 0");
  await expect(page.getByTestId("evidence-totals").locator('td[data-section="s-5"]')).not.toHaveAttribute("data-gap", "true");
  // Leaf sections with nothing behind them still are.
  for (const key of ["users", "s-5-1", "s-5-3", "metrics"]) await expect(column(page, key)).toHaveAttribute("data-gap", "true");
  await expect(page.getByTestId("evidence-totals").locator('td[data-section="s-5-1"]')).toHaveAttribute("data-gap", "true");
  await expect(page.getByTestId("evidence-unsupported")).toHaveText("4 sections unsupported");

  // "Link to another section" marks only those sections unsupported.
  await cell(page, "Guided setup", "scope").getByRole("button").click();
  const select = page.getByRole("complementary", { name: "Guided setup" }).getByRole("form", { name: "Link to another section" }).getByLabel("Section");
  await expect(select.locator("option", { hasText: "5. Proposed flow" })).toHaveText("5. Proposed flow (s-5)");
  await expect(select.locator("option", { hasText: "Checkout redesign PRD" })).toHaveText("Checkout redesign PRD (title)");
  await expect(select.locator("option", { hasText: "5.1 Cart review" })).toHaveText("5.1 Cart review (s-5-1) · unsupported");

  // The section view and its "No links or citations" filter follow the same rule.
  await page.getByRole("group", { name: "Evidence view" }).getByRole("button", { name: "Sections" }).click();
  await page.getByRole("group", { name: "Sections shown" }).getByRole("button", { name: /No links or citations/ }).click();
  const table = page.getByRole("grid", { name: "Sections" });
  await expect(table.getByRole("row", { name: /5\.1 Cart review/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /5\. Proposed flow/ })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Checkout redesign PRD/ })).toHaveCount(0);
});

test("evidence: the note on rendered pages shows once on a desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await evidenceTab(page);
  await expect(page.getByText(/Rendered pages never show these links/).filter({ visible: true })).toHaveCount(1);
});

test("evidence: removing a target's last link in the coverage view still says Link removed.", async ({ page }) => {
  await evidenceTab(page);
  await cell(page, "Guided setup", "scope").getByRole("button").click();
  const insp = page.getByRole("complementary", { name: "Guided setup" });
  await insp.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Link removed.")).toBeVisible();
  await expect(page.getByTestId("evidence-matrix").locator("tr[data-target]", { hasText: "Guided setup" })).toHaveCount(0);
});

test("evidence: a link names who made it", async ({ page }) => {
  await evidenceTab(page, "approver@example.com");
  await cell(page, "Guided setup", "scope").getByRole("button").click();
  const insp = page.getByRole("complementary", { name: "Guided setup" });
  await expect(insp.getByTestId("evidence-link")).toContainText("Admin · ");
});

test("evidence: the coverage chips turn phone-sized at 600 px, as the rest of the screen", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await evidenceTab(page);
  const chip = page.getByRole("group", { name: "Rows shown" }).getByRole("button", { name: /^Links/ });
  expect((await chip.boundingBox())!.height).toBeLessThan(40);
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(async () => (await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("evidence: Cancel clears the Add a section link form", async ({ page }) => {
  await open(page, "approver@example.com");
  await page.goto(`${DOC}/v/2/evidence?view=sections`);
  await page.getByRole("grid", { name: "Sections" }).getByRole("row", { name: /Success metrics/ }).click();
  const form = page.getByRole("complementary", { name: "7. Success metrics" }).getByRole("form", { name: "Add a section link" });
  await form.getByLabel("Kind").selectOption("claims");
  await form.getByLabel("Precision").selectOption("claim");
  await form.getByLabel("Links to").selectOption({ label: "Guided setup · feature:f.guided-setup" });
  await form.getByLabel(/^Claim/).fill("Guided setup lifts week-1 activation.");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByLabel("Links to")).toHaveValue("");
  await expect(form.getByLabel("Kind")).toHaveValue("evidences");
  await expect(form.getByLabel("Precision")).toHaveValue("section");
  await expect(form.getByRole("button", { name: "Add link" })).toBeDisabled();
});
