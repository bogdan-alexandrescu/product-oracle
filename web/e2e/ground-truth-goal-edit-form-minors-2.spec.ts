import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-edit-minors-2, driven through the UI on the mock API as a person would. "goal-attr-shapes" (see
 * ground-truth-goal-attr-shapes.spec.ts) gives the goal kr-1-1 a list of words "open_values", the object
 * "reply_targets" (holding the object "chat" of numbers) and a list "on_call" of objects each holding the object
 * "lead" ({name}).
 * Test cards (protects / fails_when / no_claim):
 * - "decimal only": protects=a new field among numbers is a number only when typed as plain decimal digits;
 *   fails_when="0x10" or "1e3" is saved as 16 or 1000; no_claim=fields of a stored number, which still refuse words.
 * - "nested emptied": protects=a list entry whose inner object the person emptied is left out;
 *   fails_when=it is saved as an empty shell ({lead: {}}); no_claim=an emptied object field outside a list, which is kept.
 * - "one per line": protects=lines typed in a list of words become one entry each, blank lines dropped;
 *   fails_when=the lines are saved as one entry, or a blank line as an empty entry; no_claim=the look.
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

test("decimal only: a new field among numbers saves 0x10 and 1e3 as typed, 12.5 as a number", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const chat = form.getByRole("group", { name: "Reply targets" }).getByRole("group", { name: "Chat", exact: true });
  for (const [name, value] of [
    ["Code", "0x10"],
    ["Size", "1e3"],
    ["Peak", "12.5"],
  ]) {
    await addTo(chat).click();
    await chat.getByLabel("Field name").last().fill(name);
    await chat.getByLabel("Field value").last().fill(value);
  }
  await save(panel, form);
  expect((await stored(page)).reply_targets).toMatchObject({ chat: { low: 1, high: 2, code: "0x10", size: "1e3", peak: 12.5 } });
});

test("nested emptied: a list entry whose inner object is emptied is left out", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);
  const first = form.getByRole("group", { name: "On call" }).getByRole("group", { name: "1", exact: true });
  await first.getByRole("group", { name: "Lead" }).getByLabel("Name", { exact: true }).fill("");
  await save(panel, form);
  const after = await stored(page);
  expect(after.on_call).toEqual([{ lead: { name: "Kit Example" } }]);
  for (const k of ["handoffs", "review_steps", "reply_targets", "open_values"]) expect(after[k], k).toEqual(before[k]);
});

test("one per line: lines typed in a list of words become one entry each; blank lines are dropped", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);
  const open = form.getByRole("textbox", { name: "Open values" });
  await open.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\n12 helpers on call\n   \nReplies within a day\n\n");
  await save(panel, form);
  await expect(panel.locator('[data-attr="open_values"]').getByRole("listitem")).toHaveText([
    "Missing",
    "50 replied threads a day",
    "Missing",
    "12 helpers on call",
    "Replies within a day",
  ]);
  expect((await stored(page)).open_values).toEqual([...(before.open_values as string[]), "12 helpers on call", "Replies within a day"]);
});
