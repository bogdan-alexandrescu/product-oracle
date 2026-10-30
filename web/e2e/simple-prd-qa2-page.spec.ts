import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 2, simple-prd lane: the one-pager page itself (its header, toolbar, lines, margin and
 * Present), the One-pagers list and the old /simple/prds address. Driven through the UI against
 * the mock (default scenario: Guided setup without a plan; "simple-plan" with one;
 * "simple-plan-undated"; "empty" for a new company). Invented data.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function scenario(page: Page, name: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
}

/** The one-pager at its address (the default scenario's list does not carry this PRD). */
async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByTestId("one-pager")).toBeVisible();
}

const line = (page: Page, id: string) => page.locator(`[data-line="${id}"]`);

async function editBet(page: Page, words: string) {
  const bet = line(page, "bets-1");
  await bet.hover();
  await bet.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill(words);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop · ${scheme}`, () => {
    test.use({ viewport: DESKTOP, colorScheme: scheme });

    test("editing a bet keeps its flow, with no detach note; the margin quotes the line, fits, and diffs only the words (qa-1, 2, 17, 19)", async ({ page }) => {
      await open(page);
      await editBet(page, "A setup checklist that shows the next step and how long it takes");
      // The owner's pick (qa-simple-prd-1, "Carry the flow over"): the flow stays with the bet.
      await expect(page.getByTestId("flow-detach-warning")).toHaveCount(0);
      await page.getByRole("button", { name: "Save" }).click();
      const note = page.getByRole("complementary", { name: "Changes and proposals" }).getByRole("note").first();
      await expect(note).toContainText("You changed “A setup checklist that shows…”");
      await expect(note).not.toContainText(/line \d/);
      await note.getByRole("button", { name: "See before/after" }).click();
      const diff = note.getByTestId("note-diff");
      await expect(diff.locator("ins").first()).toHaveText(/^\s*and how long it takes$/);
      await expect(diff.locator("pre")).toHaveCount(0);
      await expect(diff).not.toContainText("- A setup");
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways).toBeLessThanOrEqual(0);
      const box = (await diff.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(DESKTOP.width);
    });

    test("a line's sources read as text, inline, and Escape closes them (qa-16)", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: /A setup checklist that shows the next step/ }).click();
      const sources = page.getByRole("region", { name: "Sources of “A setup checklist that shows" });
      await expect(sources).toContainText("Invite suggestions from the admin's calendar");
      await expect(sources).not.toContainText("- A setup");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sources).toHaveCount(0);
    });

    test("undoing the last change drops the working-draft banner (qa-18)", async ({ page }) => {
      await open(page);
      await editBet(page, "A setup checklist with the next two steps");
      await page.getByRole("button", { name: "Save" }).click();
      const bar = page.getByRole("status", { name: "Working draft" });
      await expect(bar).toContainText("1 change");
      await page.getByRole("note").filter({ visible: true }).getByRole("button", { name: "Undo" }).click();
      await expect(line(page, "bets-1")).toHaveAttribute("data-state", "published");
      await expect(bar).toHaveCount(0);
    });

    test("one header and toolbar, one date style, no desk tint (qa-14, 43, 44)", async ({ page }) => {
      await open(page);
      await expect(page.getByTestId("one-pager-meta")).toContainText("Version 3 · Oct 20, 2026");
      await expect(page.getByTestId("one-pager-meta")).not.toContainText("published");
      await expect(page.getByRole("link", { name: "One-pagers" }).filter({ visible: true })).toHaveCount(2);
      const present = (await page.getByRole("button", { name: "Present" }).boundingBox())!;
      const pdf = (await page.getByRole("button", { name: "Export PDF" }).boundingBox())!;
      expect(Math.abs(present.height - pdf.height)).toBeLessThan(1);
      await expect(page.getByRole("button", { name: "Present" }).locator("svg")).toHaveCount(1);
      const detailed = page.getByRole("link", { name: "Open the detailed view" }).first();
      await expect(detailed).toHaveCSS("font-size", "15px");
      const link = (await detailed.boundingBox())!;
      expect(DESKTOP.width - (link.x + link.width)).toBeGreaterThan(24);
      await expect(page.getByTestId("one-pager")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    });

    test("Present hides the chrome, and leaving full screen ends it; Export shows a passing toast (qa-24, 25)", async ({ page }) => {
      await open(page);
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export PDF" }).click();
      expect((await download).suggestedFilename()).toBe("Guided setup v3 one-pager.pdf");
      const toast = page.getByRole("status").filter({ hasText: "PDF downloaded" });
      await expect(toast).toBeVisible();
      await expect(page.getByText(/^Saved /)).toHaveCount(0);
      await page.clock.runFor(5000);
      await expect(toast).toHaveCount(0);
      await page.getByRole("button", { name: "Present" }).click();
      const paper = page.getByTestId("one-pager");
      await expect(paper).toHaveAttribute("data-presenting", "true");
      for (const name of ["Export PDF", "Start review"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
      await expect(paper.getByRole("link", { name: "Open the detailed view" })).toHaveCount(0);
      await expect(paper.getByRole("link", { name: "One-pagers" })).toHaveCount(0);
      // Esc out of full screen: the browser says so with fullscreenchange.
      await page.evaluate(async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else document.dispatchEvent(new Event("fullscreenchange"));
      });
      await expect(paper).not.toHaveAttribute("data-presenting", "true");
    });

    test("a viewer reads why Start review is not theirs and sees no empty margin (qa-10, 34)", async ({ page }) => {
      await open(page, "viewer@example.com");
      const start = page.getByRole("button", { name: "Start review" });
      await expect(start).toBeDisabled();
      await expect(page.getByText("Ask an owner to start a review")).toBeVisible();
      await expect(page.getByText(/No changes yet/)).toBeHidden();
    });

    test("the owner's margin names itself (qa-34)", async ({ page }) => {
      await open(page);
      await expect(page.getByRole("complementary", { name: "Changes and proposals" })).toContainText("Changes and proposals");
    });

    test("a commenter's proposal shows its words; the hidden Propose takes no width (qa-35, 37)", async ({ page }) => {
      await open(page, "commenter@example.com");
      const problem = line(page, "problem-1");
      const row = (await problem.boundingBox())!;
      const words = (await problem.getByTestId("one-pager-line-text").locator("..").boundingBox())!;
      expect(words.width).toBeGreaterThan(row.width - 24);
      const bet = line(page, "bets-2");
      await bet.hover();
      await bet.getByRole("button", { name: "Propose wording for “Invite suggestions from the admin's" }).click();
      await page.getByLabel("New wording for").fill("Invite suggestions from shared contacts");
      await page.getByRole("button", { name: "Propose", exact: true }).click();
      const note = page.getByRole("note").filter({ visible: true }).filter({ hasText: "proposes new wording" });
      await expect(note.getByTestId("proposal-words")).toHaveText("“Invite suggestions from shared contacts”");
    });

    test("the old /simple/prds address opens the one-pager's own (qa-12)", async ({ page }) => {
      await login(page);
      await page.goto("/simple/prds/guided-setup");
      await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup$/);
      await expect(page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" })).toHaveAttribute("aria-current", "page");
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("Edit is a thumb-sized target, and the header bar does not repeat the title (qa-36, 45)", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("phone-header")).not.toContainText("Guided setup");
    const bet = line(page, "bets-1");
    await bet.getByTestId("one-pager-line-text").tap();
    const edit = bet.getByRole("button", { name: "Edit “A setup checklist that shows" });
    const box = (await edit.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  });
});

test.describe("One-pagers list and the planned PRD", () => {
  test.use({ viewport: DESKTOP });

  test("the list and the one-pager name the same state; the status sits by its title (qa-9, 11, 42)", async ({ page }) => {
    await scenario(page, "simple-plan");
    await login(page);
    await page.goto("/simple");
    await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
    await expect(page.getByText(/its plan and timeline/)).toBeVisible();
    const row = page.getByTestId("one-pager-row").filter({ hasText: "Guided setup" });
    await expect(row).toContainText("Approved");
    await expect(row).not.toContainText("Draft");
    await expect(row).toContainText("Updated");
    const title = (await row.getByRole("link", { name: "Guided setup" }).boundingBox())!;
    const chip = (await row.locator("[data-status]").boundingBox())!;
    expect(chip.x - (title.x + title.width)).toBeLessThan(40);
    await row.getByRole("link", { name: "Guided setup" }).click();
    await expect(page.getByTestId("one-pager-meta")).toContainText("Approved");
  });

  test("header separators read at the meta line's colour (qa-47)", async ({ page }) => {
    await scenario(page, "simple-plan");
    await open(page);
    const meta = page.getByTestId("one-pager-meta");
    const colour = await meta.evaluate((el) => getComputedStyle(el).color);
    await expect(meta.locator("span[aria-hidden]").first()).toHaveCSS("color", colour);
  });

  test("with no dated milestone the header says No dates yet (qa-3)", async ({ page }) => {
    await scenario(page, "simple-plan-undated");
    await open(page);
    const meta = page.getByTestId("one-pager-meta");
    await expect(meta).toContainText("No dates yet");
    await expect(meta).not.toContainText("→");
  });

  test("a new company's One-pagers says how to start a PRD (qa-41)", async ({ page }) => {
    await scenario(page, "empty");
    await login(page);
    await page.goto("/simple");
    await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
    const empty = page.getByTestId("simple-one-pagers-empty");
    await expect(empty).toContainText("A one-pager is made from a PRD");
    await empty.getByRole("link", { name: "Detailed › PRDs" }).click();
    await expect(page).toHaveURL(/\/documents$/);
  });
});
