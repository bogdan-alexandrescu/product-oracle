import { expect, test, type Locator, type Page } from "./test";

import { MOCK_DENY_KEY, MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login, openSection, openTab, outlineRow, sectionStrip } from "./helpers";

// QA pass 3, docs lane: the version page /documents/<doc>/v/<n> (Saved carts v2, a PRD with a
// brief; Clinic outreach v5, a PRD without one; the early shipping cost technical brief) and a
// PRD's Review settings, driven as a person.

const CARTS = "/documents/saved-carts/v/2";
const OUTREACH = "/documents/clinic-outreach/v/5";
const TECH_BRIEF = "/documents/checkout-redesign-early-shipping-cost-spec/v/2";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const panel = (page: Page) => page.getByTestId("review-panel").filter({ visible: true });
const reviewBar = (page: Page) => page.getByTestId("review-bar").filter({ visible: true }).first();

async function asRole(page: Page, role: "viewer" | "commenter" | "approver" | "owner") {
  await page.addInitScript(([k, r]) => localStorage.setItem(k, r), [MOCK_ROLE_KEY, role] as const);
}

async function openVersion(page: Page, url: string) {
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("document-sections")).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const box = async (l: Locator) => (await l.boundingBox())!;

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-docs-20: a failed report is one state, saying what failed and when, with a Try again that writes them", async ({ page }) => {
    await openVersion(page, CARTS);
    await openTab(page, "History");
    const reports = page.getByTestId("history-reports").filter({ visible: true }).getByTestId("reports-panel");
    const failed = reports.getByTestId("reports-failed");
    await expect(failed).toContainText("The reports could not be written on Oct 18, 4:12 PM PDT.");
    // One state: no "No reports yet." and no Failed chip beside the alert.
    await expect(reports).not.toContainText("No reports yet.");
    await expect(reports.getByTestId("job-failed")).toHaveCount(0);
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(failed).toHaveCount(0);
    await expect(reports.getByTestId("job-failed")).toHaveCount(0);
  });

  test("qa-docs-20: someone who may not ask Oracle to write is told who can try again", async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_DENY_KEY, "create_llm_job"] as const);
    await openVersion(page, CARTS);
    await openTab(page, "History");
    const reports = page.getByTestId("history-reports").filter({ visible: true }).getByTestId("reports-panel");
    await expect(reports.getByTestId("reports-failed")).toHaveText(
      "The reports could not be written on Oct 18, 4:12 PM PDT. An approver can try again.",
    );
    await expect(reports.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("qa-docs-72: a suggestion names its section by title; one or two items show no filters", async ({ page }) => {
    await openVersion(page, `${OUTREACH}#metrics`);
    await openTab(page, "Feedback");
    const card = panel(page).getByTestId("suggestion").filter({ hasText: "Calls blocked by the outbound check" });
    await expect(card).toContainText("Proposed text for 2. Metrics");
    await expect(card).not.toContainText("#metrics");

    // Saved carts has no feedback: one whole-draft comment is listed with no filter rows.
    await page.goto(CARTS);
    await expect(page.getByTestId("document-sections")).toBeVisible();
    await panel(page).getByRole("button", { name: "Comment on the whole draft" }).click();
    await panel(page).getByRole("textbox", { name: "Comment on the whole draft" }).fill("Say who owns the reminder email.");
    await panel(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(panel(page).getByTestId("feedback-item").filter({ hasText: "Say who owns the reminder email." })).toBeVisible();
    await expect(panel(page).getByTestId("feedback-state")).toHaveCount(0);
    await expect(panel(page).getByTestId("inspector-scope")).toHaveCount(0);
    await expect(panel(page).getByTestId("feedback-kind")).toHaveCount(0);
  });

  test("qa-docs-72: a version written without a brief says why it has no Brief view or Present", async ({ page }) => {
    await openVersion(page, OUTREACH);
    await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
    const note = page.getByTestId("view-note");
    await expect(note).toContainText("Full document: all");
    await note.getByRole("button", { name: "About no brief" }).click();
    await expect(page.getByText("This version was written without a brief, so it has no Brief view and no Present.")).toBeVisible();
  });

  test("qa-docs-73: the outline's counts follow the filter; Full shows its sections, counts in the app font", async ({ page }) => {
    await openVersion(page, CARTS);
    const rail = sectionStrip(page);
    await rail.getByTestId("outline-filter").fill("zzz");
    await expect(rail.getByTestId("chip-all")).toHaveText(/All\s*0/);
    await expect(rail.getByTestId("chip-review")).toHaveText(/To review\s*0/);
    await expect(rail.getByTestId("outline-empty")).toContainText("No sections match");
    await rail.getByTestId("outline-filter").fill("");
    await expect(rail.getByTestId("chip-all")).toHaveText(/All\s*[1-9]/);

    await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
    // Both chapters open: the sections are in the outline, not only "Introduction 0/9".
    await expect(outlineRow(page, "summary")).toBeVisible();
    await expect(outlineRow(page, "milestones")).toBeVisible();
    const folded = rail.getByTestId("outline-folded-count").first();
    await expect(folded).toBeVisible();
    expect(await folded.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
  });

  test("qa-docs-74: the review buttons say the action; one hint; the state shows the choice", async ({ page }) => {
    await openVersion(page, CARTS);
    const summary = await openSection(page, "summary");
    const bar = summary.getByTestId("review-bar");
    await bar.getByRole("group", { name: "Verdict for Summary" }).getByRole("button", { name: "Approve" }).click();
    await expect(bar.getByTestId("verdict-pending")).toHaveText("Approved");
    await expect(bar.getByTestId("verdict-none")).toHaveCount(0);
    await expect(bar.getByTestId("verdict-submit")).toHaveText("Approve");
    await expect(bar.getByRole("button", { name: /^Save/ })).toHaveCount(0);
    await bar.getByTestId("verdict-submit").click();
    await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
    await expect(bar.getByTestId("verdict-state")).not.toContainText("Not reviewed");

    const goal = await openSection(page, "goal-trace");
    const gbar = goal.getByTestId("review-bar");
    await gbar.getByRole("group", { name: "Verdict for Goal trace" }).getByRole("button", { name: "Request changes" }).click();
    await expect(gbar.getByTestId("verdict-submit")).toHaveText("Request changes");
    await expect(gbar.getByTestId("verdict-submit")).toBeDisabled();
    // One hint for the one thing the button waits for.
    await expect(gbar.getByTestId("verdict-save-hint")).toHaveText("Write a note first: the writer sees it");
    await expect(gbar.getByTestId("verdict-note-hint")).toHaveCount(0);
    await expect(gbar.getByText(/the writer sees it/)).toHaveCount(1);
  });

  test("qa-docs-75: the export formats line up in columns, and the menu leaves the review totals in view", async ({ page }) => {
    await openVersion(page, CARTS);
    await page.getByTestId("version-toolbar").getByRole("button", { name: "Export", exact: true }).click();
    const b = (name: string) => box(page.getByRole("button", { name, exact: true }));
    const [pdf, briefPdf, deckPdf] = await Promise.all([b("Export PDF"), b("Export brief PDF"), b("Export deck PDF")]);
    expect(briefPdf.x).toBe(pdf.x);
    expect(deckPdf.x).toBe(pdf.x);
    const [html, briefHtml] = await Promise.all([b("Export HTML"), b("Export brief HTML")]);
    expect(briefHtml.x).toBe(html.x);
    const [md, pptx] = await Promise.all([b("Export MD"), b("Export deck PPTX")]);
    expect(pptx.x).toBe(md.x);
    expect(pptx.width).toBe(md.width);

    const menu = page.getByRole("button", { name: "Export PDF", exact: true }).locator("xpath=ancestor::div[contains(@class,'shadow-tip')][1]");
    const totals = await box(panel(page).getByTestId("stat-reviewed"));
    expect(overlaps(await box(menu), totals)).toBe(false);
    expect(overlaps(await box(menu), await box(panel(page)))).toBe(false);
  });

  test("qa-docs-76: the section menu's items say what happens", async ({ page }) => {
    await openVersion(page, CARTS);
    const summary = await openSection(page, "summary");
    await summary.getByRole("button", { name: "Actions for Summary" }).click();
    const menu = summary.getByRole("menu", { name: "Actions for Summary" });
    for (const name of ["Edit the text yourself", "Ask Oracle to rewrite", "Ask a teammate a question", "Start a discussion"]) {
      await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
    }
    for (const old of [/^Edit section/, /^Refine section/, /^Discuss this section/]) {
      await expect(menu.getByRole("menuitem", { name: old })).toHaveCount(0);
    }
    await menu.getByRole("menuitem", { name: "Ask Oracle to rewrite" }).click();
    await expect(summary.getByTestId("refine-panel")).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const [what, url] of [
      ["saved carts", CARTS],
      ["a technical brief", TECH_BRIEF],
    ] as const) {
      test(`qa-docs-77: a viewer sees one status line and who reviews, on ${what} (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await asRole(page, "viewer");
        await openVersion(page, url);
        const bar = reviewBar(page);
        await expect(bar.getByTestId("verdict-state")).toBeVisible();
        await expect(bar.getByTestId("review-bar-note")).toHaveText("Approvers review sections.");
        await expect(bar.getByRole("group", { name: /^Verdict for/ })).toHaveCount(0);
        // No empty grey box: a line on the page's own background, no border.
        const look = await bar.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, border: s.borderTopWidth };
        });
        expect(look.bg).toBe("rgba(0, 0, 0, 0)");
        expect(look.border).toBe("0px");
        expect((await box(bar)).height).toBeLessThan(40);
      });
    }
  }

  test("qa-docs-28: Review settings opens as a side panel on a wide screen, with no drag handle", async ({ page }) => {
    await login(page);
    await page.goto("/documents/checkout-redesign");
    await page.getByRole("button", { name: "Review settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Review settings" });
    await expect(dialog).toBeVisible();
    const d = await box(dialog);
    expect(d.width).toBeLessThanOrEqual(520);
    expect(d.x + d.width).toBeGreaterThanOrEqual(DESKTOP.width - 1);
    expect(d.height).toBeGreaterThanOrEqual(DESKTOP.height - 1);
    await expect(page.getByTestId("sheet-review-settings").getByTestId("sheet-handle")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-docs-28: on a phone Review settings stays the bottom sheet", async ({ page }) => {
    await login(page);
    await page.goto("/documents/checkout-redesign");
    await page.getByRole("button", { name: "Review settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Review settings" });
    await expect(dialog).toBeVisible();
    expect((await box(dialog)).width).toBe(PHONE.width);
    await expect(page.getByTestId("sheet-review-settings").getByTestId("sheet-handle")).toBeVisible();
  });

  test("qa-docs-74: the review buttons keep one row on a phone with the action labels", async ({ page }) => {
    await openVersion(page, CARTS);
    const bar = reviewBar(page);
    await bar.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(bar.getByTestId("verdict-submit")).toHaveText("Approve");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });
});
