import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-edit-minors-4, driven through the UI on the mock API as a person would. "goal-attr-shapes" (see
 * ground-truth-goal-attr-shapes.spec.ts) gives the goal kr-1-1 the object "reply_targets" holding the object "chat"
 * of numbers.
 * Test cards (protects / fails_when / no_claim):
 * - "not exact": protects=a value in a new field among numbers that a number would not hold exactly (past
 *   Number.MAX_SAFE_INTEGER, or a tiny decimal read as 0) is kept as typed; fails_when=20 digits are saved rounded, or
 *   '0.' + 400 zeros + '1' is saved as 0; no_claim=values that hold exactly, saved as numbers.
 * - "goal numbers": protects=the goal's own Value, Start value and Weight take plain decimals only and say they need
 *   a number otherwise; fails_when="0x10" or "1e3" is saved as 16 or 1000; no_claim=fields of a stored number.
 */

const NAME = "KR 1.1 live helpers averaging 50 replied threads a day in March 2027";

async function editGoal(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, GOAL_ATTRS_SCENARIO] as const);
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  await page.getByTestId("goal-kr-1-1").getByRole("button", { name: NAME }).click();
  const panel = page.getByTestId("entity-drawer");
  await expect(panel.getByRole("heading", { name: NAME })).toBeVisible();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  return { panel, form: panel.getByRole("form", { name: "Edit" }) };
}

/** The + under an object (a fieldset), found by where it sits. */
const addTo = (scope: Locator) => scope.locator(":scope > button");

/** The goal's attributes as the mock saved them, as the API keeps them. */
async function stored(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    return db.baseline.entities.find((e: { key: string }) => e.key === "kr-1-1").attrs;
  });
}

async function save(panel: Locator, form: Locator) {
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(form).toHaveCount(0);
}

const BIG = "12345678901234567890";
const TINY = `0.${"0".repeat(400)}1`;

test("not exact: 20 digits and a 400-zero decimal in a new field among numbers are saved as typed", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const chat = form.getByRole("group", { name: "Reply targets" }).getByRole("group", { name: "Chat", exact: true });
  for (const [name, value] of [
    ["Big", BIG],
    ["Tiny", TINY],
    ["Safe", "9007199254740991"],
    ["Small", "0.0000001"],
    ["Plus", "+1.50"],
  ]) {
    await addTo(chat).click();
    await chat.getByLabel("Field name").last().fill(name);
    await chat.getByLabel("Field value").last().fill(value);
  }
  await save(panel, form);
  expect((await stored(page)).reply_targets).toMatchObject({
    chat: { low: 1, high: 2, big: BIG, tiny: TINY, safe: 9007199254740991, small: 1e-7, plus: 1.5 },
  });
});

test("goal numbers: 0x10 and 1e3 in Value, Start value and Weight say it needs a number; plain decimals save", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);
  const value = form.getByRole("textbox", { name: "Value", exact: true });
  const start = form.getByRole("textbox", { name: "Start value", exact: true });
  const weight = form.getByRole("spinbutton", { name: /^Weight/ });
  // A number box takes no letters but "e": Weight is only tried with "1e3".
  const cases: [Locator, string, string[]][] = [
    [value, "Value", ["0x10", "1e3"]],
    [start, "Start value", ["0x10", "1e3"]],
    [weight, "Weight", ["1e3"]],
  ];
  for (const [box, label, typed] of cases) {
    const was = await box.inputValue();
    for (const t of typed) {
      await box.fill(t);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect(form.getByText(`${label} must be a number.`, { exact: true })).toBeVisible();
      await expect(box).toHaveValue(t);
      expect(await stored(page)).toEqual(before);
    }
    await box.fill(was);
  }
  await value.fill("60");
  await start.fill("12.5");
  await weight.fill("2");
  await save(panel, form);
  expect(await stored(page)).toMatchObject({ target: 60, start: 12.5, weight: 2 });
});
