import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-attr-add-remove, driven through the UI on the mock API as a person would. "goal-attr-shapes" (see
 * ground-truth-goal-attr-shapes.spec.ts) gives the goal kr-1-1 a list of words "open_values", a list of objects
 * "review_steps" ({step, hours}), a list "saved_replies" entry by entry, a list of one-field objects "handoffs"
 * ({team}), and objects "reply_split" and "reply_targets" (holding the objects "chat" and "email").
 * Test cards (protects / fails_when / no_claim):
 * - "add entry": protects=Add under a list gives a new entry shaped like the others (the same fields, empty; a text
 *   line for a list of words) and Save stores it in that shape; fails_when=there is no Add, or the new entry is not
 *   saved or saved in another shape; no_claim=the API, which this does not change.
 * - "add field": protects=Add under an object gives a name and a value; a number where the other fields are numbers
 *   and one is typed; a number error names its group; fails_when=there is no Add, the field is not saved under its name, or the
 *   error does not name the group; no_claim=which type a new field among mixed fields takes beyond text.
 * - "remove": protects=the x on an entry, a field, a nested object and a whole attribute removes it, and only it;
 *   fails_when=a neighbour changes or the removed one is still stored; no_claim=undo, which Cancel gives.
 * - "emptied": protects=emptying the only field of a list entry leaves the entry out, as the (i) beside Save says;
 *   emptying every field of a nested object keeps the object; fails_when=the entry is kept or the object dropped.
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

/** The Add under a list or an object (a fieldset), or under a list of words by its key. */
const addTo = (scope: Locator, key?: string) =>
  key ? scope.locator(`[data-attr-part="${key}"] > button`) : scope.locator(":scope > button");

/** The x beside a field, an entry or an attribute, by its key or entry number. */
const removeOf = (scope: Locator, part: string) =>
  scope.locator(`[data-attr-part="${part}"] > button, [data-attr-part="${part}"] > div > button`);

/** The goal's attributes as the mock saved them, as the API keeps them. */
async function stored(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    return db.baseline.entities.find((e: { key: string }) => e.key === "kr-1-1").attrs;
  });
}

test("add entry: a list gets a new entry shaped like the others, saved in that shape", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  const steps = form.getByRole("group", { name: "Review steps" });
  await expect(addTo(steps)).toHaveAccessibleName("Add entry to Review steps");
  await addTo(steps).click();
  const third = steps.getByRole("group", { name: "3", exact: true });
  await expect(third.getByLabel("Step", { exact: true })).toHaveValue("");
  await expect(third.getByLabel("Hours", { exact: true })).toHaveValue("");
  await third.getByLabel("Step", { exact: true }).fill("Close the thread");
  await third.getByLabel("Hours", { exact: true }).fill("0.5");

  const replies = form.getByRole("group", { name: "Saved replies" });
  await addTo(replies).click();
  await replies.getByLabel("3", { exact: true }).fill("Glad that helped.");

  // A list of words: Add puts the cursor on a new line.
  await addTo(form, "open_values").click();
  await expect(form.getByRole("textbox", { name: "Open values" })).toBeFocused();
  await page.keyboard.type("12 helpers on call");

  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");

  await expect(panel.locator('[data-attr="review_steps"]').getByRole("listitem")).toHaveText([
    "Step: Read the thread, Hours: 1",
    "Step: Write the reply, Hours: 2",
    "Step: Close the thread, Hours: 0.5",
  ]);
  await expect(panel.locator('[data-attr="open_values"]').getByRole("listitem")).toHaveText([
    "Missing",
    "50 replied threads a day",
    "Missing",
    "12 helpers on call",
  ]);
  const after = await stored(page);
  expect(after.review_steps).toEqual([
    { step: "Read the thread", hours: 1 },
    { step: "Write the reply", hours: 2 },
    { step: "Close the thread", hours: 0.5 },
  ]);
  expect(after.saved_replies).toEqual([...(before.saved_replies as string[]), "Glad that helped."]);
  expect(after.open_values).toEqual([...(before.open_values as string[]), "12 helpers on call"]);
  for (const k of ["reply_split", "reply_targets", "handoffs"]) expect(after[k], k).toEqual(before[k]);
});

test("add field: an object gets a named field; a number error names its group", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);
  const targets = form.getByRole("group", { name: "Reply targets" });
  const chat = targets.getByRole("group", { name: "Chat", exact: true });

  // Among numbers, a new field is a number when one is typed.
  await addTo(chat).click();
  await chat.getByLabel("Field name", { exact: true }).fill("Middle");
  await chat.getByLabel("Field value", { exact: true }).fill("1.5");

  await targets.getByLabel("Hours", { exact: true }).fill("four");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByText("Reply targets: Hours must be a number.", { exact: true })).toBeVisible();
  expect(await stored(page)).toEqual(before);
  await targets.getByLabel("Hours", { exact: true }).fill("4");

  await expect(addTo(targets)).toHaveAccessibleName("Add field to Reply targets");
  await addTo(targets).click();
  await targets.getByLabel("Field name", { exact: true }).last().fill("Night team");
  await targets.getByLabel("Field value", { exact: true }).last().fill("Night shift");

  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.locator('[data-attr="reply_targets"]')).toContainText("Night team: Night shift");
  await expect(panel.locator('[data-attr="reply_targets"]')).toContainText("Middle: 1.5");

  await expect
    .poll(async () => (await stored(page)).reply_targets)
    .toEqual({
      chat: { low: 1, high: 2, middle: 1.5 },
      email: { low: 2, high: 5 },
      hours: 4,
      weekends: false,
      owner_note: null,
      tags: [],
      night_team: "Night shift",
    });
});

test("remove: the x removes an entry, a field, a nested object or an attribute, and nothing beside it", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  const steps = form.getByRole("group", { name: "Review steps" });
  await expect(removeOf(steps, "1")).toHaveAccessibleName("Remove Review steps entry 1");
  await removeOf(steps, "1").click();
  await expect(steps.getByRole("group", { name: "1", exact: true }).getByLabel("Step", { exact: true })).toHaveValue("Write the reply");
  await expect(steps.getByRole("group", { name: "2", exact: true })).toHaveCount(0);

  const targets = form.getByRole("group", { name: "Reply targets" });
  await expect(removeOf(targets, "hours")).toHaveAccessibleName("Remove Reply targets field Hours");
  await removeOf(targets, "hours").click();
  await removeOf(targets, "chat").click();
  await expect(targets.getByLabel("Hours", { exact: true })).toHaveCount(0);

  await expect(removeOf(form, "reply_split")).toHaveAccessibleName("Remove Reply split");
  await removeOf(form, "reply_split").click();
  await expect(form.getByRole("group", { name: "Reply split" })).toHaveCount(0);

  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.locator('[data-attr="review_steps"]').getByRole("listitem")).toHaveText(["Step: Write the reply, Hours: 2"]);
  await expect(panel.locator('[data-attr="reply_split"]')).toHaveCount(0);

  const after = await stored(page);
  expect(after.review_steps).toEqual([{ step: "Write the reply", hours: 2 }]);
  expect(after.reply_targets).toEqual({
    email: { low: 2, high: 5 },
    weekends: false,
    owner_note: null,
    tags: [],
  });
  expect(after).not.toHaveProperty("reply_split");
  for (const k of ["open_values", "saved_replies", "handoffs", "parent_goal"]) expect(after[k], k).toEqual(before[k]);
});

test("emptied: an emptied entry is left out, as the (i) says; an object's every field emptied keeps it", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  await form.getByRole("button", { name: "About saving" }).click();
  await expect(page.getByText("Empty entries are left out.")).toBeVisible();
  await form.getByRole("button", { name: "About saving" }).click();

  const handoffs = form.getByRole("group", { name: "Handoffs" });
  await handoffs.getByRole("group", { name: "1", exact: true }).getByLabel("Team", { exact: true }).fill("");
  const chat = form.getByRole("group", { name: "Reply targets" }).getByRole("group", { name: "Chat", exact: true });
  for (const field of ["Low", "High"]) await chat.getByLabel(field, { exact: true }).fill("");

  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.locator('[data-attr="handoffs"]').getByRole("listitem")).toHaveCount(1);

  const after = await stored(page);
  expect(after.handoffs).toEqual([{ team: "Night shift" }]);
  expect(after.reply_targets).toEqual({
    ...(before.reply_targets as object),
    chat: {},
  });
  for (const k of ["review_steps", "reply_split", "open_values"]) expect(after[k], k).toEqual(before[k]);
});
