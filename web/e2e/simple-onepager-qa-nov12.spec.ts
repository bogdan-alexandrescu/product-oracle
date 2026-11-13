import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA findings, Nov 12, 2026 (docs/qa/2026-11-12/simple-goalmap.md), on Simple's one-pager, the
 * mock's invented PRDs (Guided setup, Saved carts PRD), driven through the UI as an owner.
 *
 * OP2: protects = after "Use 6" the banner's "1 change" is a button that leads to the change in
 * the margin, and the margin lists it (never "No changes yet"); fails_when = the count is plain
 * text, or the margin says "No changes yet" while the draft has a change.
 * OP3: protects = the "Needs a look" box is padded, its heading inside its dashed border, and
 * on a phone an item's actions stack as one group under its words; fails_when = the box has no
 * top border or padding, or the actions wrap apart.
 * OP4: protects = one control edits a line: the line's Edit, reached by the keyboard from its
 * sources; fails_when = the sources hold a second "Edit this line".
 * OP7: protects = a plan whose M1 is dated (M2, M3 not) heads the page with M1's dates;
 * fails_when = the header says "No dates yet".
 * OP10: protects = a "What we will build" line naming no feature code is flagged "Not in the
 * Ground Truth", a coded one is not; fails_when = an uncoded feature shows with no flag.
 * OP11: protects = Saved carts' "Stale prices" risk shows once in "Risks and open decisions";
 * fails_when = the top risk and its risk line both show.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const COUNT = "Numbers disagree in “Not this quarter”";

async function scenario(page: Page, name: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
}

async function openFromList(page: Page, title: string) {
  await page.goto("/simple/one-pagers");
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
const lookItem = (page: Page, text: string) => look(page).getByRole("listitem").filter({ has: page.getByTestId("needs-look-line").getByText(text, { exact: true }) });

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("OP2: the draft's change count leads to the change, which the margin lists", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    await lookItem(page, COUNT).getByRole("button", { name: "Use 6" }).click();
    const banner = page.getByRole("status", { name: "Working draft" });
    const margin = page.getByRole("complementary", { name: "Changes and proposals" });
    await expect(margin.getByTestId("margin-fixed")).toHaveText("Fixed: set to 6 in “Not this quarter”");
    await expect(margin).not.toContainText("No changes yet");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await banner.getByRole("button", { name: "1 change" }).click();
    const change = margin.locator("[data-change]").first();
    await expect(change).toBeFocused();
    await expect(change).toBeInViewport();
  });

  test("OP3: the Needs a look box is padded, its heading inside its border", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    const box = look(page);
    await expect(box.getByTestId("needs-look-line").first()).toBeVisible();
    expect(await box.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
    const b = (await box.boundingBox())!;
    const h = (await box.getByRole("heading", { name: "Needs a look" }).boundingBox())!;
    const line = (await box.getByTestId("needs-look-line").first().boundingBox())!;
    expect(h.y - b.y, "the heading sits inside the box, under its top border").toBeGreaterThanOrEqual(8);
    expect(line.x - b.x, "the words keep off the left border").toBeGreaterThanOrEqual(12);
  });

  test("OP4: a line has one Edit; the keyboard reaches it from the line's sources", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    const bet = page.locator('[data-line="bets-1"]');
    await bet.getByTestId("one-pager-line-text").focus();
    await page.keyboard.press("Enter");
    const sources = page.getByRole("region", { name: /^Sources of “A setup checklist/ });
    await expect(sources).toBeVisible();
    await expect(sources.getByRole("button", { name: /Edit this line|Propose wording/ })).toHaveCount(0);
    const edit = bet.locator("[data-edit-for]");
    for (let i = 0; i < 4 && !(await edit.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  });

  test("OP7: a plan with only M1 dated heads the page with M1's dates", async ({ page }) => {
    await scenario(page, "simple-plan-partly-dated");
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    const meta = page.getByTestId("one-pager-meta");
    await expect(meta).toContainText("Nov 2, 2026 → Nov 27, 2026");
    await expect(meta).not.toContainText("No dates yet");
  });

  test("OP10: a feature we will build with no code is flagged", async ({ page }) => {
    await login(page);
    await openFromList(page, "Saved carts PRD");
    const bets = page.getByRole("region", { name: "What we will build" });
    await expect(bets.locator('[data-line="bets-1"]')).toContainText("Save cart");
    await expect(bets.locator('[data-line="bets-1"]').getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
  });

  test("OP10: a coded feature carries no flag", async ({ page }) => {
    await scenario(page, "one-pager-run-prd-walk");
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    const bets = page.getByRole("region", { name: "What we will build" });
    await expect(bets.locator('[data-line="bets-1"]')).toContainText("F-01");
    await expect(bets.getByTestId("not-in-gt")).toHaveCount(0);
  });

  test("OP11: Saved carts' stale prices risk shows once", async ({ page }) => {
    await login(page);
    await openFromList(page, "Saved carts PRD");
    const risks = page.getByRole("region", { name: "Risks and open decisions" });
    await expect(risks).toContainText("Stale prices: likely, medium impact");
    await expect(risks.getByTestId("one-pager-line-text").filter({ hasText: /stale prices/i })).toHaveCount(1);
    await expect(risks).toContainText("Too many emails");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("OP3: a Needs a look item's actions stack as one group under its words", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    const item = lookItem(page, COUNT);
    const actions = item.getByTestId("needs-look-actions");
    await expect(actions).toBeVisible();
    const words = (await item.getByTestId("needs-look-line").boundingBox())!;
    const group = (await actions.boundingBox())!;
    expect(group.y, "the group starts under the item's words").toBeGreaterThanOrEqual(words.y + words.height - 1);
    await expect(actions.getByRole("button", { name: "Use 6" })).toBeVisible();
    await expect(actions.getByTestId("needs-look-open")).toBeVisible();
    const boxes = [];
    for (const p of await actions.locator(":scope > *").all()) boxes.push((await p.boundingBox())!);
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < boxes.length; i++) {
      expect(Math.abs(boxes[i].x - boxes[0].x), "one left edge").toBeLessThanOrEqual(1);
      expect(boxes[i].y, "one under the other").toBeGreaterThan(boxes[i - 1].y);
    }
  });
});
