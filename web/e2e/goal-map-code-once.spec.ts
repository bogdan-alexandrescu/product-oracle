import { LADDER_CODED, LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA goal map codes: a feature whose stored title already leads with its own code (F-16 in the
 * "goal-ladder" mock, invented data) shows the code once, then its name, on its chip in the Goal
 * map's grid, in the chip's full name (its title), the feature panel it opens and the Add a feature
 * list, at 1440 and on a phone.
 *
 * Test card: protects=every feature shows code + name once; fails_when=a chip or the panel reads
 * "F-16 F-16 Setup checklist ..."; no_claim=features whose title has no code (the other chips).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const once = `${LADDER_CODED.code} ${LADDER_CODED.name}`;
/** The code chip, then the name: the code once (the chip's gap is a margin, not a space). */
const coded = new RegExp(`^${LADDER_CODED.code}\\s*${LADDER_CODED.name}$`);

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  if (page.viewportSize()!.width <= 600) {
    await page.getByTestId("simple-tab-more").click();
    await page.getByTestId("simple-more-sheet").getByRole("link", { name: "Goal map" }).click();
  } else await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
}

const chip = (page: Page) => page.getByTestId("gm-chip").filter({ hasText: LADDER_CODED.name });
/** The chip's name line: its code, then its name. */
const title = (page: Page) => chip(page).getByRole("button").locator("span").first();

test.describe("Goal map: a feature's code shows once, 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the chip and its panel read the code once, then the name", async ({ page }) => {
    await open(page);
    await expect(chip(page)).toHaveCount(1);
    await expect(title(page)).toHaveText(coded);
    await expect(title(page)).toHaveAttribute("title", once);
    await chip(page).getByRole("button", { name: new RegExp(LADDER_CODED.name) }).click();
    const panel = page.getByTestId("gm-feature-panel");
    await expect(panel.getByTestId("card-name")).toHaveText(coded);
  });

  test("Add a feature lists it with its code once, and its chip still reads it once", async ({ page }) => {
    await open(page);
    const gate = page.getByTestId("gm-strip-milestone").filter({ hasText: "Imports finish without help" });
    await gate.hover();
    await gate.getByRole("button", { name: /More for .*Imports finish without help/ }).click();
    await page.getByRole("menuitem", { name: "Add a feature" }).click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Feature").fill(LADDER_CODED.code);
    const pick = ed.getByTestId("gm-attach-list").getByRole("button").filter({ hasText: LADDER_CODED.name });
    await expect(pick).toHaveText(coded);
    // The code shows as its chip before the name, never inside it.
    await expect(pick.locator(".simple-code")).toHaveText(LADDER_CODED.code);
    await pick.click();
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-editor")).toHaveCount(0);
    await expect(chip(page)).toHaveCount(1);
    await expect(title(page)).toHaveText(coded);
  });
});

test.describe("Goal map: a feature's code shows once, phone", () => {
  test.use(PHONE);

  test("the phone chip reads the code once, then the name", async ({ page }) => {
    await open(page);
    await expect(title(page)).toHaveText(coded);
  });
});
