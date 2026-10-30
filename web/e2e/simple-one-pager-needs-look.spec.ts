import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Quality checks on generated one-pagers (oracle.simple.quality), driven through the UI on
 * the mock's invented PRD "guided-setup" (./lib/api/mock/simple-one-pager.ts), scenario
 * "one-pager-needs-look": Oracle's build failed its checks twice (two bets, a risk line
 * saying "TBD"), so it is stored with them.
 *
 * Card one-pager-needs-look: protects = the owner reads Oracle's stored build with a quiet
 * "Needs a look" note naming each failed check in plain words; fails_when = the owner gets
 * no note, or the note drops a failed check; no_claim = the checks themselves and the
 * second ask (api tests/test_simple_generation_quality.py).
 *
 * Card one-pager-needs-look-below-owner: protects = a commenter reads the last good version
 * (three bets, no "TBD") and no note; fails_when = the failed build or its note reaches
 * people below owner; no_claim = the API's per-role filter (its pytest).
 */

const URL = "/simple/prds/guided-setup";
const note = (page: Page) => page.getByRole("note", { name: "Needs a look" });
const lineText = (page: Page, text: string) => page.getByTestId("one-pager-line-text").filter({ hasText: text });

async function setUp(page: Page) {
  await page.context().addInitScript(([key]) => localStorage.setItem(key, "one-pager-needs-look"), [MOCK_SCENARIO_KEY] as const);
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("the owner reads a quiet note naming the failed checks", async ({ page }) => {
      await setUp(page);
      await login(page);
      await page.goto(URL);
      await expect(note(page)).toBeVisible();
      await expect(note(page)).toContainText("Needs a look");
      await expect(note(page)).toContainText("2 bets; a one-pager has 3 to 5");
      await expect(note(page)).toContainText("A line in “Risks and open decisions” says “TBD”");
      await expect(lineText(page, "Pricing for teams is TBD")).toBeVisible();
      await expect(lineText(page, "A sample project created on day one")).toHaveCount(0);
    });

    test("a commenter reads the last good version and no note", async ({ page }) => {
      await setUp(page);
      await login(page, "commenter@example.com");
      await page.goto(URL);
      await expect(lineText(page, "A sample project created on day one")).toBeVisible();
      await expect(lineText(page, "Pricing for teams is TBD")).toHaveCount(0);
      await expect(note(page)).toHaveCount(0);
    });
  });
}
