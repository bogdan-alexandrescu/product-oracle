import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The qa4-simple-decide findings the first QA pass 4 lane left open, driven through the UI on
 * the mock's invented data, desktop and phone, as the company's owner.
 *
 * -14: "Presenter plus one or two people" offers only attendees whose role may change things,
 * never a viewer. -16: a roadmap move in a meeting is undone from its toast, and the undo is the
 * meeting's decision. -19: a decided question's line and a one-pager note read the meeting's
 * "Thu Oct 22, 5:00 AM", no zone letters. -25: once the edits are published the header's
 * version and day move on, and the margin says where the edits went. -26: in a meeting the
 * one-pager's actions, title and card share one left edge. -27: on a phone the one-pager card
 * pads once, so its text has room. -35: with Ask Oracle open at 1440 "Waiting for you" stays on
 * one line and the List/Board/By meeting switch stays beside the filters. -32: By meeting, a
 * meeting's card lists the comments its minutes list.
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function openSheet(page: Page, signIn = true) {
  if (signIn) await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: "Start review" }).first());
  await sheet(page).getByLabel("PRD").selectOption({ label: "Guided setup" });
}

const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });
const decisions = (page: Page) => page.getByRole("region", { name: "Decisions in this meeting" });
const MOMENT = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2} [AP]M/;

async function startReview(page: Page, signIn = true) {
  await openSheet(page, signIn);
  const s = sheet(page);
  await s.getByRole("checkbox", { name: "Commenter" }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function editLine(page: Page) {
  await tap(page.getByRole("button", { name: "Edit “A setup checklist that shows" }));
  await page.getByLabel("New wording for").fill("A checklist that names the next step");
  await tap(page.getByRole("button", { name: "Save" }));
  await expect(decisions(page)).toContainText("New wording for a line of Guided setup");
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 } });

    test("qa4-simple-decide-14: the named picker never offers a viewer", async ({ page }) => {
      await openSheet(page);
      const s = sheet(page);
      const attends = s.getByRole("group", { name: "Who attends" });
      for (const box of await attends.getByRole("checkbox").all()) await box.uncheck();
      await attends.getByRole("checkbox", { name: /^viewer/i }).check();
      await tap(s.getByRole("radio", { name: "Presenter plus one or two people" }));
      const picker = s.getByLabel("Who else changes things");
      await expect(picker.getByRole("checkbox")).toHaveCount(0);
      await expect(picker).toContainText("Viewers can't change things; tick someone else above.");
      await attends.getByRole("checkbox", { name: "Commenter", exact: true }).check();
      await expect(picker.getByRole("checkbox")).toHaveCount(1);
      await expect(picker.getByRole("checkbox", { name: "Commenter", exact: true })).toBeVisible();
      await expect(picker.getByRole("checkbox", { name: /^viewer/i })).toHaveCount(0);
    });

    test("qa4-simple-decide-16: a roadmap move in a meeting is undone from its toast", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
      const row = page.getByRole("region", { name: "Roadmap slice" }).locator("li").filter({ hasText: "Sample data import" });
      const was = (await row.locator("span").first().innerText()).split(" · ")[1]!;
      await tap(page.getByRole("button", { name: "Move Sample data import to Later" }));
      const shown = page.getByRole("status").filter({ hasText: "Moved Sample data import to Later" }).filter({ has: page.getByRole("button", { name: "Undo" }) });
      await expect(shown).toBeVisible();
      await shown.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("roadmap-said")).toHaveText("Undone: moved Sample data import to Later.");
      await expect(row.locator("span").first()).toContainText(` · ${was} · `);
      await expect(decisions(page)).toContainText(`Undone: Moved Sample data import to ${was}`);
    });

    test("qa4-simple-decide-19: a decided question and a one-pager note read the meeting's time format", async ({ page }) => {
      await startReview(page);
      await editLine(page);
      const note = page.getByRole("note", { name: /^Change to/ }).filter({ visible: true });
      await expect(note.locator("p").first()).toContainText(MOMENT);
      await expect(note.locator("p").first()).not.toContainText(/\b(PT|PDT|PST)\b/);
      // The line's flow thumbnail, too: "drawn Mon Oct 26, 8:00 AM".
      const drawn = page.getByRole("group", { name: /^User flow of/ }).filter({ visible: true }).first();
      await expect(drawn).toContainText(new RegExp(`drawn ${MOMENT.source}`));
      await expect(drawn).not.toContainText(/\b(PT|PDT|PST)\b/);
      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      const q5 = page.getByRole("region", { name: "On the agenda", exact: true }).locator('[data-code="Q5"]');
      await tap(q5.getByRole("button", { name: "Decide as recommended" }));
      await expect(q5).toContainText(/Decided in this meeting.* · (Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
      await expect(q5).not.toContainText(/\b(PT|PDT|PST)\b/);
    });

    test("qa4-simple-decide-25: once published, the version line moves on and the margin says where the edits went", async ({ page }) => {
      await startReview(page);
      const meta = page.getByTestId("one-pager-meta");
      await expect(meta).toContainText(/[Vv](ersion )?3 · Oct 20, 2026/);
      await editLine(page);
      await tap(page.getByRole("button", { name: "Approve and publish one-pager edits (1)" }));
      await page.getByRole("alertdialog").getByRole("button", { name: "Approve and publish" }).click();
      await expect(decisions(page)).toContainText("Approved Guided setup (published)");
      await expect(meta).toContainText(/[Vv](ersion )?4 · Oct 22, 2026/);
      if (!phone) {
        const margin = page.getByRole("complementary", { name: "Changes and proposals" });
        await expect(margin).toContainText("No changes waiting. Version 4 is published; “Decided in” under a line links to the decision that changed it.");
        await expect(margin).not.toContainText("No changes yet");
      }
    });

    test("review: a later meeting that published nothing does not say its edits were published", async ({ page }) => {
      test.skip(phone, "the margin is a desktop column");
      test.setTimeout(60_000);
      await startReview(page);
      await editLine(page);
      await tap(page.getByRole("button", { name: "Approve and publish one-pager edits (1)" }));
      await page.getByRole("alertdialog").getByRole("button", { name: "Approve and publish" }).click();
      await expect(decisions(page)).toContainText("Approved Guided setup (published)");
      await tap(page.getByRole("button", { name: "End meeting" }));
      await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
      await expect(page.getByTestId("end-screen")).toBeVisible();
      // A second review of the same PRD: its line still reads "Decided in" the first one's decision.
      await startReview(page, false);
      await expect(page.getByTestId("line-decisions").first()).toContainText("Decided in");
      const margin = page.getByRole("complementary", { name: "Changes and proposals" });
      await expect(margin).toContainText("No changes yet. An edit or a proposed wording shows here beside its line.");
      await expect(margin).not.toContainText("No changes waiting");
    });

    test("qa4-simple-decide-26/27: the one-pager's actions, title and card share one left edge; the card pads once", async ({ page }) => {
      await startReview(page);
      const card = page.getByRole("article", { name: "One-pager" });
      const title = page.getByRole(phone ? "heading" : "heading", { name: "Guided setup", exact: true });
      const left = async (l: Locator) => Math.round((await l.boundingBox())!.x);
      expect(await left(title)).toBe(await left(card));
      if (!phone) expect(await left(page.getByRole("button", { name: "Present" }))).toBe(await left(card));
      // The card's own text column, inside its border and padding.
      const inner = await card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      });
      expect(inner).toBeGreaterThanOrEqual(phone ? 300 : 600);
    });

    if (!phone)
      test("qa4-simple-decide-35: with Ask Oracle open at 1440 the heading keeps one line and the switch its row", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await login(page);
        await page.goto("/simple/decisions");
        await page.getByTestId("question-row").filter({ visible: true }).first().getByRole("button", { name: "Ask Oracle" }).click();
        await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
        const heading = page.getByRole("heading", { name: "Waiting for you" });
        const h = await heading.evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
        });
        expect(h).toBe(1);
        const filters = (await page.getByRole("group", { name: "Filters" }).boundingBox())!;
        const sw = (await page.getByTestId("decisions-view-list").boundingBox())!;
        // Beside the filters, not dropped under them.
        expect(sw.y).toBeLessThan(filters.y + filters.height);
        expect(sw.x).toBeGreaterThan(filters.x);
      });

    test("qa4-simple-decide-32: By meeting, a meeting's card lists the comments its minutes list", async ({ page }) => {
      await login(page);
      await page.goto("/simple/meetings");
      await tap(page.getByTestId("meetings-past").getByRole("link", { name: "Review: Usage alerts" }).first());
      await expect(page.getByTestId("end-screen")).toBeVisible();
      const inMinutes = await page.getByTestId("minutes-comments").locator("li").allInnerTexts();
      expect(inMinutes.length).toBeGreaterThan(0);
      await page.goto("/simple/decisions");
      await page.getByTestId("decisions-view-meetings").click();
      const group = page.getByTestId("meeting-group").filter({ has: page.getByRole("link", { name: "Review: Usage alerts" }) });
      await expect(group.getByRole("heading", { name: "Comments" })).toBeVisible();
      await expect(group.getByTestId("meeting-group-comments").locator("li")).toHaveText(inMinutes);
    });
  });
}
