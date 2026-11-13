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
      // protects: on desktop (light and dark) saving a changed bet keeps its flow with no detach warning, and its margin note quotes the line, has no "line N" text, and shows a before/after of only the added words
      // fails_when: a detach warning shows, the note says "line N", the diff is a block of whole lines, or the page or note runs wider than the screen
      // no_claim: the exact colours of the diff, the phone layout, or that the change is published
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
      // protects: on desktop, clicking a line shows its sources as plain text in the page (not a dialog), and Escape closes them
      // fails_when: the sources show diff marks like "- A setup", open in a dialog, or stay open after Escape
      // no_claim: the sources' layout or order, or how they look on a phone
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
      // protects: on desktop, after one saved edit the Working draft bar says "1 change", and Undo on its note puts the line back to published and removes the bar
      // fails_when: the line stays changed after Undo or the Working draft bar stays up with nothing left to show
      // no_claim: undoing several changes in a row, or undo from the phone
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
      // protects: on desktop the header reads "Version 3 · Oct 20, 2026" without "published", has two visible One-pagers links, Present and Export PDF are the same height with an icon on Present, Open in Detailed is 15px and sits over 24px from the right edge, and the page has no tint
      // fails_when: the date is ISO or says "published", the link count is not two, the buttons differ in height, the icon is missing, the link is the wrong size or at the edge, or the page has a background colour
      // no_claim: the phone header, other colour schemes' exact shades, or what the buttons do
      await open(page);
      await expect(page.getByTestId("one-pager-meta")).toContainText("Version 3 · Oct 20, 2026");
      await expect(page.getByTestId("one-pager-meta")).not.toContainText("published");
      await expect(page.getByRole("link", { name: "One-pagers" }).filter({ visible: true })).toHaveCount(2);
      const present = (await page.getByRole("button", { name: "Present" }).boundingBox())!;
      const pdf = (await page.getByRole("button", { name: "Export PDF" }).boundingBox())!;
      expect(Math.abs(present.height - pdf.height)).toBeLessThan(1);
      await expect(page.getByRole("button", { name: "Present" }).locator("svg")).toHaveCount(1);
      const detailed = page.getByRole("link", { name: "Open in Detailed" }).first();
      await expect(detailed).toHaveCSS("font-size", "15px");
      const link = (await detailed.boundingBox())!;
      expect(DESKTOP.width - (link.x + link.width)).toBeGreaterThan(24);
      await expect(page.getByTestId("one-pager")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    });

    test("Present hides the chrome, and leaving full screen ends it; Export shows a passing toast (qa-24, 25)", async ({ page }) => {
      // protects: on desktop Export PDF downloads "Guided setup v3 one-pager.pdf" and shows a "PDF downloaded" toast (no "Saved" text) that goes after 5 seconds; Present hides Export PDF, Start a review meeting and the header links, and leaving full screen ends it
      // fails_when: the file name is wrong, the toast is missing, says Saved or never goes, Present keeps its controls, or Present stays on after full screen ends
      // no_claim: the PDF's contents, or a real browser full screen (the test sends the event)
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
      for (const name of ["Export PDF", "Start a review meeting"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
      await expect(paper.getByRole("link", { name: "Open in Detailed" })).toHaveCount(0);
      await expect(paper.getByRole("link", { name: "One-pagers" })).toHaveCount(0);
      // Esc out of full screen: the browser says so with fullscreenchange.
      await page.evaluate(async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else document.dispatchEvent(new Event("fullscreenchange"));
      });
      await expect(paper).not.toHaveAttribute("data-presenting", "true");
    });

    test("a viewer sees no Start review and no empty margin (qa-10, 34, qa4-simple-prd-26)", async ({ page }) => {
      // protects: on desktop a viewer's one-pager has no Start a review meeting button, no "Ask an owner to start a review" text and no visible "No changes yet" margin
      // fails_when: a viewer is offered Start review or the hint, or sees an empty margin
      // no_claim: what a viewer can do elsewhere, or what owners and deciders see
      await open(page, "viewer@example.com");
      await expect(page.getByRole("button", { name: "Start a review meeting" })).toHaveCount(0);
      await expect(page.getByText("Ask an owner to start a review")).toHaveCount(0);
      await expect(page.getByText(/No changes yet/)).toBeHidden();
    });

    test("the owner's margin names itself (qa-34)", async ({ page }) => {
      // protects: on desktop the owner's margin is named "Changes and proposals" and shows that title
      // fails_when: the margin has another name or no title for the owner
      // no_claim: what the margin lists, or the titles other roles see
      await open(page);
      await expect(page.getByRole("complementary", { name: "Changes and proposals" })).toContainText("Changes and proposals");
    });

    test("a commenter's proposal shows its words; the hidden Propose takes no width (qa-35, 37)", async ({ page }) => {
      // protects: on desktop for a commenter a line's words fill its row (within 24px of the full width, so the hidden Propose button takes no room), and a proposed wording shows its quoted words in the "You proposed new wording" note
      // fails_when: the words are squeezed narrower than the row, or the proposal note does not show the proposed words in quotes
      // no_claim: that an owner approves the proposal, or the phone layout
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
      const note = page.getByRole("note").filter({ visible: true }).filter({ hasText: "You proposed new wording" });
      await expect(note.getByTestId("proposal-words")).toHaveText("“Invite suggestions from shared contacts”");
    });

    test("the old /simple/prds address opens the one-pager's own (qa-12)", async ({ page }) => {
      // protects: on desktop the old /simple/prds/guided-setup address goes to /simple/one-pagers/guided-setup and the One-pagers link in the Simple menu is marked as the current page
      // fails_when: the old address stays, ends on another page, or the menu does not mark One-pagers
      // no_claim: other old addresses, or that the one-pager's contents load
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
      // protects: on a 390 by 844 phone the header bar does not repeat "Guided setup", and after a tap on a bet its Edit button is at least 44 by 44 pixels
      // fails_when: the header bar repeats the title, or the Edit button is smaller than 44 pixels either way
      // no_claim: that Edit then works on a phone, or the desktop sizes
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
      // protects: with a plan, the One-pagers list row for Guided setup says Approved (not Draft) and Updated, its status chip sits within 40px of the title, About One-pagers has a tooltip, and the one-pager's header says Approved too
      // fails_when: the list says Draft, the chip is far from the title, the tooltip text is missing, or the page and list disagree on the state
      // no_claim: other PRDs' rows, the sort order, or the phone list
    await scenario(page, "simple-plan");
    await login(page);
    await page.goto("/simple");
    await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
    await page.getByRole("button", { name: "About One-pagers" }).focus();
    await expect(page.getByRole("tooltip").filter({ hasText: "Open a PRD to read it on one page, change its wording or start a review." })).toBeVisible();
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
      // protects: with a plan on desktop, the first separator in the one-pager's header meta line has the same colour as the meta line's text
      // fails_when: the separator is drawn in a different colour from the meta text
      // no_claim: the colour value itself, other separators, or dark mode on its own
    await scenario(page, "simple-plan");
    await open(page);
    const meta = page.getByTestId("one-pager-meta");
    const colour = await meta.evaluate((el) => getComputedStyle(el).color);
    await expect(meta.locator("span[aria-hidden]").first()).toHaveCSS("color", colour);
  });

  test("with no dated milestone the header says No dates yet (qa-3)", async ({ page }) => {
      // protects: when the plan has no dated milestone, the one-pager's header says "No dates yet" and shows no arrow range
      // fails_when: the header shows an arrow date range or no wording about missing dates
      // no_claim: how a dated plan reads, or that dates can be added here
    await scenario(page, "simple-plan-undated");
    await open(page);
    const meta = page.getByTestId("one-pager-meta");
    await expect(meta).toContainText("No dates yet");
    await expect(meta).not.toContainText("→");
  });

  test("a new company's One-pagers says how to start a PRD (qa-41)", async ({ page }) => {
      // protects: for a new company with no PRDs the One-pagers page says "A one-pager is made from a PRD" and its Detailed › PRDs link goes to the documents page
      // fails_when: the empty page is blank or has no way to start, or the link goes elsewhere
      // no_claim: that a PRD can then be made, or the page for a company that has PRDs
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
