import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * fix4-simple-decide review minors, driven through the UI on the mock's data.
 *
 * protects = a comment made in a meeting is still shown once it ended; the Board's one column
 * (601-900 px) reads Needs input, Recommended, Decided; a roadmap date's year follows the
 * company's day, not the browser's; a question decided in a meeting keeps its own code, title
 * and answer on Decisions (a title with ": " in it too); the meeting chat says which part of a
 * line it did not understand, and reads each line of a message.
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });
const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });
const chat = (page: Page) => page.getByTestId("meeting-chat");

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = sheet(page);
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function endIt(page: Page) {
  await tap(page.getByRole("button", { name: "End meeting" }));
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

async function say(page: Page, text: string) {
  await chat(page).getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(chat(page).getByRole("button", { name: "Send" }));
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 } });

    test("a comment made in the meeting is still there once it ended", async ({ page }) => {
      // fails_when: after End the comment is shown nowhere
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      const box = page.getByRole("region", { name: "Comment in the meeting" });
      await box.getByRole("textbox", { name: "Comment" }).fill("We should wait for legal first");
      await tap(box.getByRole("button", { name: "Add comment" }));
      await expect(box.getByTestId("meeting-comment")).toContainText("We should wait for legal first");
      await endIt(page);
      const comments = page.getByTestId("minutes-comments");
      await expect(comments).toContainText("We should wait for legal first · Avery Stone");
      // Still a comment, not a decision.
      await expect(page.getByRole("list", { name: "Decisions taken" })).toHaveCount(0);
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1512, height: 900 } });

  test("a question decided in a meeting keeps its code, title and answer on Decisions", async ({ page }) => {
    // fails_when: the row is read back out of "Decided Q8 <title>: <answer>" and a title with ": " splits in the wrong place
    await startReview(page);
    await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
    const q8 = page.getByRole("region", { name: "On the agenda", exact: true }).locator('[data-code="Q8"]');
    await expect(q8).toContainText("Q8 Sign-in choice: Google at launch");
    await tap(q8.getByRole("button", { name: "Decide as recommended" }));
    await expect(q8.getByTestId("question-decided")).toContainText("Decided in this meeting: Yes, at launch");
    await page.goto("/simple/decisions?view=meetings");
    const row = page.getByTestId("meeting-group").first().getByTestId("decision-row").filter({ hasText: "Sign-in choice" });
    await expect(row.locator(".simple-code")).toHaveText("Q8");
    await expect(row.locator("b")).toHaveText("Sign-in choice: Google at launch");
    await expect(row.locator(".simple-meta")).toHaveText(/^Yes, at launch · Avery Stone · /);
  });

  test("the meeting chat says what it did not understand and reads each line", async ({ page }) => {
    // fails_when: "make it better" is dropped without a word, or a second line is run into the first
    await startReview(page);
    const box = chat(page);
    await say(page, "push Team invite nudges to next quarter and make it better");
    const reply = box.locator('[data-testid="chat-message"][data-kind="cards"]').last();
    await expect(reply).toContainText("I understood one change.");
    await expect(reply).toContainText("I did not understand: “make it better”.");
    await say(page, "push Team invite nudges to next quarter\nnote that legal signs off");
    await expect(box.locator('[data-testid="chat-message"][data-kind="cards"]').last()).toContainText("I understood two changes.");
  });
});

test.describe("keyboard", () => {
  test.use({ viewport: { width: 1512, height: 900 } });

  test("By meeting: Tab goes down the meetings in the order they are drawn", async ({ page }) => {
    // qa-simple-decide-34 (not reproduced): fails_when: focus jumps back up the page while tabbing through the meetings
    await login(page);
    await page.goto("/simple/decisions?view=meetings");
    await expect(page.getByTestId("meeting-group").first()).toBeVisible();
    await page.getByTestId("decisions-view-meetings").focus();
    // Every stop inside a meeting or under Outside meetings, page position in order.
    const seen: { where: string; y: number }[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const g = el?.closest('[data-testid="meeting-group"], section[aria-label="Outside meetings"]');
        if (!el || !g) return null;
        return { where: g.getAttribute("aria-label") ?? "", y: el.getBoundingClientRect().top + window.scrollY };
      });
      if (at) seen.push(at);
    }
    expect(seen.map((s) => s.where)).toContain("Review: Usage alerts");
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i].y).toBeGreaterThanOrEqual(seen[i - 1].y - 2);
  });
});

test.describe("one column", () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test("the Board reads Needs input, Recommended, Decided", async ({ page }) => {
    // fails_when: Decided questions comes before Recommended in the one-column layout
    await login(page);
    await page.goto("/simple/decisions?view=board");
    const needs = (await page.getByTestId("board-needs_input").boundingBox())!;
    const rec = (await page.getByTestId("board-recommended").boundingBox())!;
    const decided = (await page.getByTestId("board-decided").boundingBox())!;
    expect(needs.y).toBeLessThan(rec.y);
    expect(rec.y).toBeLessThan(decided.y);
    // Read in the same order: the headings follow the columns.
    const headings = await page.getByTestId("questions-board").locator("h2").allTextContents();
    expect(headings.map((h) => h.trim())).toEqual(["Missing a decider or a recommendation", "Recommended", "Decided questions"]);
  });
});

test.describe("a browser a day ahead of the company", () => {
  // The company is on Pacific time; this browser is in Tokyo, already in the next year.
  test.use({ viewport: { width: 1512, height: 900 }, timezoneId: "Asia/Tokyo" });

  test("roadmap dates of the company's own year carry no year", async ({ page }) => {
    // fails_when: "this year" is the browser's (2027), so this year's dates read ", 2026"
    await page.clock.setSystemTime(new Date("2026-12-31T20:00:00Z"));
    await startReview(page);
    await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
    const spans = page.getByTestId("roadmap-span");
    await expect(spans.first()).toBeVisible();
    const all = await spans.allTextContents();
    expect(all.some((s) => /Dec \d+/.test(s))).toBe(true);
    expect(all.filter((s) => s.includes(", 2026"))).toEqual([]);
  });
});
