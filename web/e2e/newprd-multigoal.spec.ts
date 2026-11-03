import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Simple › New PRD picks several goals (owner, Nov 3): each goal chip toggles on and off and
 * any number can be on; "Not sure yet" is a choice of its own (it clears the goals, a goal
 * clears it). Every picked goal reaches the brief: Home's "PRDs you started", One-pagers' new
 * row and Detailed's brief all name both. Desktop and phone, light and dark; invented data.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const NAME = "Shared grocery lists";
const PROBLEM = "People who shop for a household keep separate lists, so they buy the same things twice and forget others.";
const A = "Raise activation";
const B = "Grow paid conversion";

const simple = (page: Page) => page.getByTestId("simple-page");
const sheet = (page: Page) => page.getByTestId("np-sheet");

for (const scheme of ["light", "dark"] as const) {
  for (const [label, size] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ] as const) {
    test.describe(`${label}, ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme });

      test("the sheet picks two goals, and the new PRD carries both on Home, One-pagers and Detailed", async ({ page }) => {
        await login(page);
        await page.goto("/simple");
        await expect(simple(page)).toBeVisible();
        await simple(page).getByRole("button", { name: "New PRD" }).click();
        const s = sheet(page);
        await expect(s).toBeVisible();
        await s.getByLabel("Name").fill(NAME);
        await s.getByLabel("The problem").fill(PROBLEM);
        await s.getByLabel("Who has it").fill("Households of two or more people who shop each week");

        const group = s.getByRole("group", { name: "The goals it helps" });
        const chip = (name: string) => group.getByRole("button", { name });
        const on = group.locator('[aria-pressed="true"]');
        await expect(on).toHaveCount(0);

        // Tick two goals: both stay on.
        await chip(A).click();
        await chip(B).click();
        await expect(chip(A)).toHaveAttribute("aria-pressed", "true");
        await expect(chip(B)).toHaveAttribute("aria-pressed", "true");
        await expect(on).toHaveCount(2);

        // Untick one.
        await chip(A).click();
        await expect(chip(A)).toHaveAttribute("aria-pressed", "false");
        await expect(chip(B)).toHaveAttribute("aria-pressed", "true");

        // Not sure yet clears the goals.
        await chip("Not sure yet").click();
        await expect(chip("Not sure yet")).toHaveAttribute("aria-pressed", "true");
        await expect(on).toHaveCount(1);

        // Two again: picking a goal clears Not sure yet.
        await chip(A).click();
        await expect(chip("Not sure yet")).toHaveAttribute("aria-pressed", "false");
        await chip(B).click();
        await expect(on).toHaveCount(2);

        // The chips keep their order: the goals, then Not sure yet last.
        const names = await group.getByRole("button").allInnerTexts();
        expect(names.at(-1)?.trim()).toBe("Not sure yet");

        // Through the questions, then Draft with what I gave.
        await s.getByRole("button", { name: "Next" }).click();
        await expect(s.getByRole("heading", { name: NAME })).toBeVisible();
        const question = s.getByTestId("np-question");
        await expect(question.getByText("Question 1 of 6")).toBeVisible();
        await question.getByRole("textbox").fill("A list two people in one home can both edit.");
        await question.getByRole("button", { name: "Next question" }).click();
        await expect(question.getByText("Question 2 of 6")).toBeVisible();
        await question.getByRole("button", { name: "I don't know" }).click();
        await expect(question.getByText("Question 3 of 6")).toBeVisible();
        await s.getByRole("button", { name: "Draft with what I gave" }).click();
        await expect(s).toBeHidden();

        // Home's card names both goals.
        const card = simple(page).getByTestId("np-started");
        await expect(card.getByText(NAME)).toBeVisible();
        await expect(card.getByText(`1 of 6 questions answered. The draft is for ${A} and ${B}.`)).toBeVisible();

        // One-pagers' new row names both.
        await card.getByRole("link", { name: "All one-pagers" }).click();
        await expect(page).toHaveURL(/\/simple\/one-pagers$/);
        const row = simple(page).getByTestId("one-pager-started");
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId("one-pager-started-goals")).toHaveText(`For ${A} and ${B}`);

        // Detailed shows the same two goals as picked.
        await row.getByRole("link", { name: NAME }).click();
        await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
        // On a phone the brief's side panel opens from Show details.
        if (label === "phone") await page.getByRole("button", { name: "Show details" }).click();
        const picked = page.getByTestId("intake-inspector").filter({ visible: true }).getByTestId("intake-goals-picked");
        await expect(picked).toContainText(A);
        await expect(picked).toContainText(B);
      });
    });
  }
}
