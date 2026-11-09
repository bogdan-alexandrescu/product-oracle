import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-edit-minors-5, driven through the UI on the mock API as a person would, on the goal kr-1-1 of
 * "goal-attr-shapes" (see ground-truth-goal-attr-shapes.spec.ts).
 * Test cards (protects / fails_when / no_claim):
 * - "stored numbers": protects=a Value, Start value or Weight saved as 0.0000001 or 1 followed by 21 zeros (shown
 *   back as "1e-7" and "1e+21") saves again untouched; fails_when=the form says "Value must be a number." for a number
 *   it showed itself; no_claim=how such a number is shown.
 * - "not exact": protects=Value and Start value refuse a number a number would not hold exactly; fails_when=
 *   '0.' + 400 zeros + '1' is saved as 0 or 20 digits are saved rounded; no_claim=the 2^53 bound.
 */

const NAME = "KR 1.1 live helpers averaging 50 replied threads a day in March 2027";

async function openEdit(page: Page) {
  const panel = page.getByTestId("entity-drawer");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  return panel.getByRole("form", { name: "Edit" });
}

async function openGoal(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, GOAL_ATTRS_SCENARIO] as const);
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  await page.getByTestId("goal-kr-1-1").getByRole("button", { name: NAME }).click();
  const panel = page.getByTestId("entity-drawer");
  await expect(panel.getByRole("heading", { name: NAME })).toBeVisible();
  return panel;
}

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

const boxes = (page: Page, form: Locator) => ({
  value: form.getByRole("textbox", { name: "Value", exact: true }),
  start: form.getByRole("textbox", { name: "Start value", exact: true }),
  // Weight's box has no name of its own: it sits in the label with the "About weight" tip.
  weight: form.locator("label").filter({ has: page.getByRole("button", { name: "About weight" }) }).getByRole("spinbutton"),
});

test("stored numbers: a tiny or huge Value, Start value and Weight save again untouched", async ({ page }) => {
  const panel = await openGoal(page);
  let form = await openEdit(page);
  let b = boxes(page, form);
  // A target saves with which way is success and its unit.
  await form.getByRole("combobox", { name: "Comparison" }).selectOption("At least");
  await form.getByRole("combobox", { name: "Unit" }).selectOption("%");
  await b.value.fill("0.0000001");
  await b.start.fill(`1${"0".repeat(21)}`);
  await b.weight.fill("0.0000001");
  await save(panel, form);
  expect(await stored(page)).toMatchObject({ target: 1e-7, start: 1e21, weight: 1e-7 });

  // Edit again, change only the title: the numbers it shows save as they are.
  form = await openEdit(page);
  b = boxes(page, form);
  await expect(b.value).toHaveValue("1e-7");
  await expect(b.start).toHaveValue("1e+21");
  await form.getByRole("textbox", { name: "Title", exact: true }).fill(`${NAME} (kept)`);
  await save(panel, form);
  expect(await stored(page)).toMatchObject({ target: 1e-7, start: 1e21, weight: 1e-7 });
});

test("not exact: Value and Start value refuse a 400-zero decimal and 20 digits", async ({ page }) => {
  const panel = await openGoal(page);
  const form = await openEdit(page);
  const before = await stored(page);
  const b = boxes(page, form);
  for (const [box, label] of [
    [b.value, "Value"],
    [b.start, "Start value"],
  ] as const) {
    const was = await box.inputValue();
    for (const t of [`0.${"0".repeat(400)}1`, "12345678901234567890"]) {
      await box.fill(t);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect(form.getByText(`${label} must be a number.`, { exact: true })).toBeVisible();
      await expect(box).toHaveValue(t);
      expect(await stored(page)).toEqual(before);
    }
    await box.fill(was);
  }
  // Numbers that hold exactly still save.
  await form.getByRole("combobox", { name: "Comparison" }).selectOption("At least");
  await form.getByRole("combobox", { name: "Unit" }).selectOption("%");
  await b.value.fill(`1${"0".repeat(21)}`);
  await b.start.fill("0.0000001");
  await save(panel, form);
  expect(await stored(page)).toMatchObject({ target: 1e21, start: 1e-7 });
});
