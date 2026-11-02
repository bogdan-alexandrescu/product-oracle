import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

// priorities-keydates (the owner, Nov 2: Priorities shows a PRD's milestones too, the same
// way): the onboarding roadmap is built from the Guided setup PRD, whose approved version
// states two milestones (M1 Prove it ends Nov 27, M2 Scale volume Dec 25). Simple > Priorities'
// Line picker offers both as key dates marked "From the PRD" ("From the PRD: M1 · Prove it ·
// Nov 27, 2026"), as Simple > Roadmap's Key dates marks them, beside the roadmap's own Board
// meeting, which reads "Key date: Board meeting · <day>". Picking one draws
// the line on its day; publishing the PRD's next version, which moves M2 to Jan 8, moves its
// key date here too. Invented data ("roadmap-keydates" scenario).

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("a PRD's milestones are key dates on the Line picker, marked From the PRD, and follow the PRD", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-keydates"] as const);
      await login(page);
      await page.goto("/simple/priorities");
      await expect(page.getByTestId("simple-priorities")).toBeVisible();
      const select = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
      await expect(select).toBeVisible();
      const keyDates = async () => (await select.locator("option").allTextContents()).filter((t) => /^(Key date|From the PRD): /.test(t));
      await expect.poll(keyDates).toEqual(
        expect.arrayContaining([
          "From the PRD: M1 · Prove it · Nov 27, 2026",
          "From the PRD: M2 · Scale volume · Dec 25, 2026",
          expect.stringMatching(/^Key date: Board meeting · [A-Z][a-z]{2} \d{1,2}, \d{4}$/),
        ]),
      );
      const m1 = select.locator("option", { hasText: "From the PRD: M1 · Prove it" });
      await expect(m1).toHaveAttribute("title", "A key date from the PRD; change it in the PRD, Guided setup");

      // Picking it draws the line on its day.
      await select.selectOption((await m1.getAttribute("value"))!);
      await expect(page.getByTestId("line-caption").first()).toContainText("miss M1 · Prove it · Nov 27, 2026");

      // The PRD changes: its next version, moving M2 to Jan 8, is published.
      await page.goto("/documents/guided-setup/publish");
      const publish = page.getByTestId("publish-button");
      await expect(publish).toHaveText("Publish v4");
      await publish.click();
      await page.getByRole("dialog", { name: "Publish v4?" }).getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByTestId("published-chip")).toHaveText("Published v4");

      await page.goto("/simple/priorities");
      await expect(page.getByTestId("simple-priorities")).toBeVisible();
      await expect.poll(keyDates).toContain("From the PRD: M2 · Scale volume · Jan 8, 2027");
      expect(await keyDates()).not.toContain("From the PRD: M2 · Scale volume · Dec 25, 2026");
    });
  });
}
