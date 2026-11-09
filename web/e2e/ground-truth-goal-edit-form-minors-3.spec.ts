import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-edit-minors-3, driven through the UI on the mock API as a person would. "goal-attr-shapes" (see
 * ground-truth-goal-attr-shapes.spec.ts) gives the goal kr-1-1 the object "reply_targets" (holding the object "chat"
 * of numbers, and the number "hours") and a list "on_call" whose first entry is {lead: {name}, note: null}.
 * Test cards (protects / fails_when / no_claim):
 * - "too long": protects=a run of 309 or more digits in a new field among numbers is kept as typed;
 *   fails_when=it is saved as null (Infinity); no_claim=shorter numbers, saved as numbers.
 * - "leading zeros": protects=a value typed with leading zeros in a new field among numbers is kept as typed, "0" and
 *   "0.5" as numbers; fails_when="007" is saved as 7; no_claim=fields of a stored number.
 * - "stored number": protects=a stored number field takes plain decimals only and says it needs a number otherwise;
 *   fails_when="0x10" or "1e3" is saved as 16 or 1000; no_claim=the goal's own Value, Start value and Weight.
 * - "null is empty": protects=a list entry whose inner object is emptied is left out though it holds a stored null;
 *   fails_when=it is saved as {lead: {}, note: null}; no_claim=an untouched entry holding a null, kept as it was.
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

const LONG = "9".repeat(320);

async function addNumbers(form: Locator, values: [string, string][]) {
  const chat = form.getByRole("group", { name: "Reply targets" }).getByRole("group", { name: "Chat", exact: true });
  for (const [name, value] of values) {
    await addTo(chat).click();
    await chat.getByLabel("Field name").last().fill(name);
    await chat.getByLabel("Field value").last().fill(value);
  }
}

test("too long: 320 digits in a new field among numbers are saved as typed", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  await addNumbers(form, [
    ["Cap", LONG],
    ["Peak", "12"],
  ]);
  await save(panel, form);
  expect((await stored(page)).reply_targets).toMatchObject({ chat: { low: 1, high: 2, cap: LONG, peak: 12 } });
});

test("leading zeros: 007 in a new field among numbers is saved as typed; 0 and 0.5 as numbers", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  await addNumbers(form, [
    ["Code", "007"],
    ["Floor", "0"],
    ["Half", "0.5"],
  ]);
  await save(panel, form);
  expect((await stored(page)).reply_targets).toMatchObject({ chat: { low: 1, high: 2, code: "007", floor: 0, half: 0.5 } });
});

test("stored number: 0x10 and 1e3 in a number field say it needs a number; 16 saves", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);
  const targets = form.getByRole("group", { name: "Reply targets" });
  const hours = targets.getByLabel("Hours", { exact: true });
  for (const typed of ["0x10", "1e3"]) {
    await hours.fill(typed);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form.getByText("Reply targets: Hours must be a number.", { exact: true })).toBeVisible();
    await expect(hours).toHaveValue(typed);
    expect(await stored(page)).toEqual(before);
  }
  await hours.fill("16");
  await save(panel, form);
  expect((await stored(page)).reply_targets).toMatchObject({ hours: 16 });
});

test("null is empty: an entry holding a stored null is left out when its inner object is emptied", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  expect((await stored(page)).on_call).toEqual([{ lead: { name: "Sam Example" }, note: null }, { lead: { name: "Kit Example" } }]);
  const first = form.getByRole("group", { name: "On call" }).getByRole("group", { name: "1", exact: true });
  await first.getByRole("group", { name: "Lead" }).getByLabel("Name", { exact: true }).fill("");
  await save(panel, form);
  expect((await stored(page)).on_call).toEqual([{ lead: { name: "Kit Example" } }]);
});
