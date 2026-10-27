import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Simple S5 (#723): the one-pager, the owner's pick "A · Paper", driven through the UI on
 * the mock's invented PRD "guided-setup" (./lib/api/mock/simple-one-pager.ts), on desktop
 * and phone, light and dark.
 *
 * Card one-pager-read: protects = the page column shows the header (title, version,
 * published date, owner, span), the six fallback blocks with their capped lines and the
 * timeline strip, Present, Export PDF (a download) and "Open the detailed view"; a line's
 * click opens its sources with the detailed view's link to its section; fails_when = a
 * block, the header or an action is missing, or the PDF does not download; no_claim = the
 * PDF's layout (api/tests/test_simple_one_pager_api.py) and the one_pager job's wording.
 *
 * Card one-pager-owner-edit: protects = an owner's line edit applies into the working
 * draft: the line is tinted edited, the draft bar counts it, the margin note beside it
 * says "You changed line 2" with Undo and a before/after that shows the section patch, and
 * Undo puts the line back; fails_when = the edit is not sent as edit_line, the note or the
 * section patch is missing, or Undo leaves the edit; no_claim = submit and approval
 * (the API's tests).
 *
 * Card one-pager-proposal: protects = a commenter's edit is a proposal ("proposes new
 * wording for line 3") they cannot decide; the owner sees it beside the line, opens its
 * flow thumbnail (the card widens in place: "No flow yet"), and accepts it, after which the
 * line reads the new wording; a viewer gets no edit control; fails_when = a commenter's
 * edit applies, the owner cannot accept, or a viewer can edit; no_claim = Slack or email.
 */

const URL = "/simple/prds/guided-setup";

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, colorScheme: scheme });

      /** The margin notes: the right margin on a desktop, under their line on a phone. */
      const notes = (page: Page) => page.getByRole("note");

      test("reads the page, presents, exports and links to the detailed view", async ({ page }) => {
        await login(page, "viewer@example.com");
        await page.goto(URL);
        await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
        await expect(page.getByTestId("one-pager-meta")).toContainText("Version 3");
        await expect(page.getByTestId("one-pager-meta")).toContainText("published Oct 20, 2026");
        for (const title of ["Problem and who has it", "What we will build", "Outcomes and how we measure them", "Not doing", "Risks and open decisions", "Timeline"]) {
          await expect(page.getByRole("region", { name: title })).toBeVisible();
        }
        await expect(page.getByRole("region", { name: "Outcomes and how we measure them" })).toContainText("48% → 65%");
        await expect(page.getByLabel("Timeline strip")).toContainText("Calendar invites · estimated");
        await expect(page.getByRole("button", { name: /Edit line|Propose wording/ })).toHaveCount(0);
        await page.getByRole("button", { name: /A setup checklist that shows the next step/ }).click();
        const sources = page.getByRole("dialog", { name: "Sources of line 2" });
        await expect(sources.getByRole("link", { name: "Open the detailed view" })).toHaveAttribute("href", "/documents/guided-setup#build");
        await expect(page.getByRole("link", { name: "Open the detailed view" }).first()).toHaveAttribute("href", "/documents/guided-setup");
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export PDF" }).click();
        expect((await download).suggestedFilename()).toBe("guided-setup-v3-one-pager.pdf");
        await page.getByRole("button", { name: "Present" }).click();
        await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
        await page.getByRole("button", { name: "Stop presenting" }).click();
        await expect(page.getByTestId("one-pager")).not.toHaveAttribute("data-presenting", "true");
      });

      test("an owner edits a line into the working draft and undoes it", async ({ page }) => {
        await login(page);
        await page.goto(URL);
        await page.getByRole("button", { name: "Edit line 2" }).click();
        await page.getByLabel("Line 2").fill("A setup checklist with the next two steps");
        await page.getByRole("button", { name: "Save" }).click();
        const line = page.locator('[data-line="bets-1"]');
        await expect(line).toHaveAttribute("data-state", "edited");
        await expect(line).toContainText("A setup checklist with the next two steps");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("published v3 stays live until approved");
        const note = notes(page).filter({ hasText: "You changed line 2" }).filter({ visible: true });
        await expect(note).toBeVisible();
        await note.getByRole("button", { name: "See before/after" }).click();
        await expect(note.getByLabel("Before and after")).toContainText("Section “What we will build”");
        await expect(note.getByLabel("Before and after")).toContainText("- A setup checklist with the next two steps");
        await note.getByRole("button", { name: "Undo" }).click();
        await expect(line).toHaveAttribute("data-state", "published");
        await expect(line).toContainText("A setup checklist that shows the next step");
      });

      test("an edited metric line shows its new numbers", async ({ page }) => {
        await login(page);
        await page.goto(URL);
        await page.getByRole("button", { name: "Edit line 5" }).click();
        await page.getByLabel("Line 5").fill("Teammate invited in week one from 48% to 70%");
        await page.getByRole("button", { name: "Save" }).click();
        const line = page.locator('[data-line="outcomes-1"]');
        await expect(line).toHaveAttribute("data-state", "edited");
        await expect(line).toContainText("48% → 70%");
        await expect(line).not.toContainText("65%");
      });

      test("a line's sources show the section's text", async ({ page }) => {
        await login(page, "viewer@example.com");
        await page.goto(URL);
        await page.getByRole("button", { name: /A setup checklist that shows the next step/ }).click();
        const sources = page.getByRole("dialog", { name: "Sources of line 2" });
        await expect(sources).toContainText("What we will build");
        await expect(sources).toContainText("Invite suggestions from the admin's calendar");
      });

      if (!phone) {
        test("a margin note sits beside its line", async ({ page }) => {
          await login(page);
          await page.goto(URL);
          await page.getByRole("button", { name: "Edit line 9" }).click();
          await page.getByLabel("Line 9").fill("Calendar access may worry admins");
          await page.getByRole("button", { name: "Save" }).click();
          const line = page.locator('[data-line="risks-1"]');
          await expect(line).toHaveAttribute("data-state", "edited");
          const note = page.getByRole("complementary", { name: "Margin" }).getByRole("note", { name: "Change to line 9" });
          await expect(note).toBeVisible();
          await expect(async () => {
            const a = (await line.boundingBox())!;
            const b = (await note.boundingBox())!;
            expect(Math.abs(a.y - b.y)).toBeLessThan(24);
            expect(b.x).toBeGreaterThan(a.x + a.width);
          }).toPass();
        });
      }

      test("a commenter proposes, the owner accepts after opening the flow", async ({ page }) => {
        await login(page, "commenter@example.com");
        await page.goto(URL);
        await page.getByRole("button", { name: "Propose wording for line 3" }).click();
        await page.getByLabel("Line 3").fill("Invite suggestions from shared contacts");
        await page.getByRole("button", { name: "Propose", exact: true }).click();
        await expect(page.locator('[data-line="bets-2"]')).toHaveAttribute("data-state", "proposal");
        const mine = notes(page).filter({ hasText: "proposes new wording for line 3" }).filter({ visible: true });
        await expect(mine).toBeVisible();
        await expect(mine.getByRole("button", { name: "Accept" })).toHaveCount(0);
        // The account menu lives in the desktop rail: switch people there, then back to
        // the phone's width for the owner's part.
        const size = page.viewportSize()!;
        await page.setViewportSize({ width: 1366, height: 900 });
        await signOut(page);
        await login(page);
        await page.setViewportSize(size);
        await page.goto(URL);
        const note = notes(page).filter({ hasText: "proposes new wording for line 3" }).filter({ visible: true });
        await note.getByRole("button", { name: "Flow for line 3" }).click();
        await expect(note).toHaveAttribute("data-widened", "true");
        await expect(note.getByLabel("User flow")).toContainText("No flow yet");
        await note.getByRole("button", { name: "Close" }).click();
        await note.getByRole("button", { name: "Accept" }).click();
        const line = page.locator('[data-line="bets-2"]');
        await expect(line).toContainText("Invite suggestions from shared contacts");
        await expect(line).toHaveAttribute("data-state", "edited");
      });
    });
  }
}
