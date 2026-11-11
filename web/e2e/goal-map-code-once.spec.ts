import { LADDER_CODED, LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA goal map codes: a feature whose stored title already leads with its own code (F-16 in the
 * "goal-ladder" mock, invented data) shows the code once, then its name, on its ladder card, in
 * the card's label, the feature panel it opens, the Attach a feature list and its "Attached:"
 * line, at 1440 and on a phone.
 *
 * Test card: protects=every feature shows code + name once; fails_when=a card or the panel reads
 * "F-16 F-16 Setup checklist ..."; no_claim=features whose title has no code (the other cards).
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

const card = (page: Page) => page.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: new RegExp(`^${LADDER_CODED.code}$`) }) });
/** The card's title line: its code chip, then its name. */
const title = (page: Page) => card(page).locator("span.font-semibold").first();

test.describe("Goal map: a feature's code shows once, 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the card and its panel read the code once, then the name", async ({ page }) => {
    await open(page);
    await card(page).scrollIntoViewIfNeeded();
    await expect(title(page)).toHaveText(coded);
    await expect(card(page)).toHaveAccessibleName(once);
    await card(page).click();
    await card(page).getByTestId("ld-open").click();
    const panel = page.getByTestId("gm-feature-panel");
    await expect(panel.getByTestId("card-name")).toHaveText(coded);
  });

  test("Attach a feature lists it with its code once, and says so once attached", async ({ page }) => {
    await open(page);
    await page.getByTestId("ld-edit").click();
    const gate = page.getByTestId("ld-milestone").filter({ hasText: "Imports finish without help" });
    await gate.getByTestId("ld-more").click();
    await page.getByTestId("ld-ms-menu").getByRole("menuitem", { name: "Attach a feature…" }).click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Feature").fill(LADDER_CODED.code);
    const pick = ed.getByTestId("gm-attach-list").getByRole("button").filter({ hasText: LADDER_CODED.name });
    await expect(pick.locator("span.font-semibold")).toHaveText(coded);
    // The code shows as its chip before the name, never inside it.
    await expect(pick.locator(".simple-code")).toHaveText(LADDER_CODED.code);
    await pick.click();
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText(`Attached: ${once} now also serves Imports finish without help.`);
  });
});

test.describe("Goal map: a feature's code shows once, phone", () => {
  test.use(PHONE);

  test("the phone card reads the code once, then the name", async ({ page }) => {
    await open(page);
    await page.getByRole("tab", { name: "Goal 2" }).click();
    await expect(title(page)).toHaveText(coded);
  });
});
