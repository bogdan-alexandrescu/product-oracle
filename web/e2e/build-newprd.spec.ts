import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Simple's New PRD (NP1, the picked "Guided sheet"), mock-backed and through the UI only:
 * New PRD on Home and One-pagers opens a sheet with four short fields, then Oracle's brief
 * questions one at a time (why it asks, an answer box, I don't know, Ask someone later), and
 * "Draft with what I gave" starts the draft at any point. Home then shows "PRDs you started"
 * and One-pagers the new row; the brief opens in Detailed too. Desktop 1440 x 900 and phone
 * 390 x 844. Invented data only.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const NAME = "Shared shopping lists";
const PROBLEM = "People who shop for a household keep separate lists, so they buy the same things twice and forget others.";

const simple = (page: Page) => page.getByTestId("simple-page");
const sheet = (page: Page) => page.getByTestId("np-sheet");

async function openSimple(page: Page, path: "/simple" | "/simple/one-pagers") {
  await login(page);
  await page.goto(path);
  await expect(simple(page)).toBeVisible();
}

/** The first step: the four fields, then Next. */
async function fillAndGo(page: Page) {
  const s = sheet(page);
  await expect(s.getByRole("heading", { name: "New PRD" })).toBeVisible();
  await expect(s.getByText("Then up to 6 short questions")).toBeVisible();
  // Next waits for a name and the problem.
  await expect(s.getByRole("button", { name: "Next" })).toHaveAttribute("aria-disabled", "true");
  await s.getByLabel("Name").fill(NAME);
  await s.getByLabel("The problem").fill(PROBLEM);
  await s.getByLabel("Who has it").fill("Households of two or more people who shop each week");
  await s.getByRole("button", { name: "Raise activation" }).click();
  await expect(s.getByRole("button", { name: "Raise activation" })).toHaveAttribute("aria-pressed", "true");
  await s.getByRole("button", { name: "Next" }).click();
  await expect(s.getByRole("heading", { name: NAME })).toBeVisible();
}

function question(page: Page): Locator {
  return sheet(page).getByTestId("np-question");
}

/** Answers the question on screen and waits for it to join the answered list above. */
async function answer(page: Page, text: string) {
  const done = sheet(page).getByTestId("np-answered");
  const n = await done.count();
  await question(page).getByRole("textbox").fill(text);
  await question(page).getByRole("button", { name: "Next question" }).click();
  await expect(done).toHaveCount(n + 1);
}

for (const [label, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(label, () => {
    test.use({ viewport: size });

    test("Home's New PRD asks one question at a time, and Draft with what I gave starts it", async ({ page }) => {
      await openSimple(page, "/simple");
      await simple(page).getByRole("button", { name: "New PRD" }).click();
      await expect(sheet(page)).toBeVisible();
      if (label === "phone") {
        // On a phone the sheet fills the screen.
        const box = (await sheet(page).boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(PHONE.width - 1);
        expect(box.height).toBeGreaterThanOrEqual(PHONE.height - 1);
      }
      await fillAndGo(page);

      // Question 1 of 6, with why it asks, in plain words (not the API's "gap" label).
      await expect(question(page).getByText("Question 1 of 6")).toBeVisible();
      await expect(question(page).getByTestId("np-why")).not.toHaveText(/gap,/);
      await expect(question(page).getByTestId("np-why")).not.toBeEmpty();
      await expect(sheet(page).getByTestId("np-tally")).toHaveText("0 answered · 6 left");

      await answer(page, "Nothing from a person's own private list, and no prices they paid.");
      await expect(question(page).getByText("Question 2 of 6")).toBeVisible();
      await answer(page, "More new households add a second person in their first week: from 18% to 30%.");
      await answer(page, "Households where a second person already joined.");
      await expect(question(page).getByText("Question 4 of 6")).toBeVisible();

      // The hard case: one not known, one sent to someone to answer later.
      await question(page).getByRole("button", { name: "I don't know" }).click();
      await expect(sheet(page).getByText("The draft marks it as open.")).toBeVisible();
      await expect(question(page).getByText("Question 5 of 6")).toBeVisible();
      await question(page).getByRole("button", { name: "Ask someone later" }).click();
      const later = question(page).getByTestId("np-later");
      await expect(later.getByText("Ask someone to answer later")).toBeVisible();
      // Not the person asking.
      await expect(later.getByRole("button", { name: /Avery Stone/ })).toHaveCount(0);
      await later.getByRole("button", { name: /Priya Raman/ }).click();
      await expect(sheet(page).getByTestId("np-tally")).toHaveText("3 answered · 1 not known · 2 left");
      await question(page).getByRole("button", { name: "Ask Priya Raman" }).click();
      await expect(sheet(page).getByText("Asked of Priya Raman. The draft starts without it.")).toBeVisible();
      await expect(question(page).getByText("Question 6 of 6")).toBeVisible();
      // The question's buttons stay in view as the answered ones stack up.
      await expect(question(page).getByRole("button", { name: "I don't know" })).toBeInViewport();
      // Home lists a PRD once it drafts, not while its questions are asked.
      await expect(simple(page).getByTestId("np-started")).toHaveCount(0);

      // Draft at question 6, with what was given.
      await sheet(page).getByRole("button", { name: "Draft with what I gave" }).click();
      await expect(sheet(page)).toBeHidden();

      const card = simple(page).getByTestId("np-started");
      await expect(card.getByRole("heading", { name: "PRDs you started" })).toBeVisible();
      await expect(card.getByText(NAME)).toBeVisible();
      await expect(card.getByText("Drafting")).toBeVisible();
      await expect(card.getByText("3 of 6 questions answered. The draft is for Raise activation.")).toBeVisible();
      await expect(card.getByText(/you did not know: the draft marks it as open\./)).toBeVisible();
      await expect(card.getByText(/waits on Priya Raman; the draft updates when they answer\./)).toBeVisible();
      await expect(card.getByText(/was not answered yet: the draft marks it as open\./)).toBeVisible();

      // One-pagers heads its list with the new PRD, drafting.
      await card.getByRole("link", { name: "All one-pagers" }).click();
      await expect(page).toHaveURL(/\/simple\/one-pagers$/);
      const row = simple(page).getByTestId("one-pager-started");
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(NAME);
      await expect(row).toContainText("Drafting");
      await expect(row).toContainText("1 question waits on Priya Raman");
      await expect(row).toContainText("Updated just now");
    });

    test("One-pagers' New PRD makes the same brief Detailed opens, and Draft with what I gave works at the first question", async ({ page }) => {
      await openSimple(page, "/simple/one-pagers");
      await simple(page).getByTestId("simple-one-pagers").getByRole("button", { name: "New PRD" }).click();
      await fillAndGo(page);
      await expect(question(page).getByText("Question 1 of 6")).toBeVisible();
      await sheet(page).getByRole("button", { name: "Draft with what I gave" }).click();
      await expect(sheet(page)).toBeHidden();

      const row = simple(page).getByTestId("one-pager-started");
      await expect(row).toContainText(NAME);
      await expect(row).toContainText("Drafting");
      // The same brief, in Detailed.
      await row.getByRole("link", { name: NAME }).click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
      await expect(page.getByRole("heading", { name: NAME }).first()).toBeVisible();
    });
  });
}

test("Escape and the close button leave the sheet without making anything", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openSimple(page, "/simple/one-pagers");
  const list = simple(page).getByTestId("simple-one-pagers");
  await list.getByRole("button", { name: "New PRD" }).click();
  await sheet(page).getByLabel("Name").fill(NAME);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await list.getByRole("button", { name: "New PRD" }).click();
  // Afresh each time.
  await expect(sheet(page).getByLabel("Name")).toHaveValue("");
  await sheet(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(simple(page).getByTestId("one-pager-started")).toHaveCount(0);
});

test("A viewer has no New PRD in Simple", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, "viewer@example.com");
  await page.goto("/simple/one-pagers");
  await expect(simple(page).getByTestId("one-pager-row").first()).toBeVisible();
  await expect(simple(page).getByRole("button", { name: "New PRD" })).toHaveCount(0);
});
