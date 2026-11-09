import { expect, test, type Page } from "./test";

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
 * - "add field": protects=Add under an object gives a name and a value; a number where the other fields are numbers;
 *   a nested number error names its group; fails_when=there is no Add, the field is not saved under its name, or the
 *   error does not name the group; no_claim=which type a new field among mixed fields takes beyond text.
 * - "remove": protects=the x on an entry, a field, a nested object and a whole attribute removes it, and only it;
 *   fails_when=a neighbour changes or the removed one is still stored; no_claim=undo, which Cancel gives.
 * - "emptied": protects=emptying the only field of a list entry, or every field of a nested object, keeps the entry
 *   and the object; the (i) beside Save says empty entries are left out; fails_when=the entry or the attribute is dropped.
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
  await steps.getByRole("button", { name: "Add entry to Review steps", exact: true }).click();
  const third = steps.getByRole("group", { name: "3", exact: true });
  await expect(third.getByLabel("Step")).toHaveValue("");
  await expect(third.getByLabel("Hours")).toHaveValue("");
  await third.getByLabel("Step").fill("Close the thread");
  await third.getByLabel("Hours").fill("0.5");

  const replies = form.getByRole("group", { name: "Saved replies" });
  await replies.getByRole("button", { name: "Add entry to Saved replies", exact: true }).click();
  await replies.getByLabel("3", { exact: true }).fill("Glad that helped.");

  // A list of words: Add puts the cursor on a new line.
  await form.getByRole("button", { name: "Add entry to Open values", exact: true }).click();
  await expect(form.getByLabel("Open values")).toBeFocused();
  await page.keyboard.type("12 helpers on call");

  await form.getByRole("button", { name: "Save" }).click();
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

test("add field: an object gets a named field; a nested number error names its group", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);
  const targets = form.getByRole("group", { name: "Reply targets" });
  const chat = targets.getByRole("group", { name: "Chat", exact: true });

  // Among numbers, a new field is a number: words are refused, naming the groups it is in.
  await chat.getByRole("button", { name: "Add field to Chat", exact: true }).click();
  await chat.getByLabel("Field name").fill("Middle");
  await chat.getByLabel("Field value").fill("lots");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Reply targets: Chat: Middle must be a number.", { exact: true })).toBeVisible();
  await chat.getByLabel("Field value").fill("1.5");

  await targets.getByLabel("Hours", { exact: true }).fill("four");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Reply targets: Hours must be a number.", { exact: true })).toBeVisible();
  expect(await stored(page)).toEqual(before);
  await targets.getByLabel("Hours", { exact: true }).fill("4");

  await targets.getByRole("button", { name: "Add field to Reply targets", exact: true }).click();
  await targets.getByLabel("Field name").last().fill("Night team");
  await targets.getByLabel("Field value").last().fill("Night shift");

  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.locator('[data-attr="reply_targets"]')).toContainText("Night team: Night shift");
  await expect(panel.locator('[data-attr="reply_targets"]')).toContainText("Middle: 1.5");

  await expect.poll(async () => (await stored(page)).reply_targets).toEqual({
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
  await steps.getByRole("button", { name: "Remove entry 1", exact: true }).click();
  await expect(steps.getByRole("group", { name: "1", exact: true }).getByLabel("Step")).toHaveValue("Write the reply");
  await expect(steps.getByRole("group", { name: "2", exact: true })).toHaveCount(0);

  const targets = form.getByRole("group", { name: "Reply targets" });
  await targets.getByRole("button", { name: "Remove Hours", exact: true }).click();
  await targets.getByRole("button", { name: "Remove Chat", exact: true }).click();
  await expect(targets.getByLabel("Hours", { exact: true })).toHaveCount(0);

  await form.getByRole("button", { name: "Remove Reply split", exact: true }).click();
  await expect(form.getByRole("group", { name: "Reply split" })).toHaveCount(0);

  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.locator('[data-attr="review_steps"]').getByRole("listitem")).toHaveText(["Step: Write the reply, Hours: 2"]);
  await expect(panel.locator('[data-attr="reply_split"]')).toHaveCount(0);

  const after = await stored(page);
  expect(after.review_steps).toEqual([{ step: "Write the reply", hours: 2 }]);
  expect(after.reply_targets).toEqual({ email: { low: 2, high: 5 }, weekends: false, owner_note: null, tags: [] });
  expect(after).not.toHaveProperty("reply_split");
  for (const k of ["open_values", "saved_replies", "handoffs", "parent_goal"]) expect(after[k], k).toEqual(before[k]);
});

test("emptied: emptying an entry's only field or an object's every field keeps them; the (i) says what is left out", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  await form.getByRole("button", { name: "About saving" }).click();
  await expect(page.getByText("Empty entries are left out.")).toBeVisible();
  await page.keyboard.press("Escape");

  const handoffs = form.getByRole("group", { name: "Handoffs" });
  await handoffs.getByRole("group", { name: "1", exact: true }).getByLabel("Team").fill("");
  const chat = form.getByRole("group", { name: "Reply targets" }).getByRole("group", { name: "Chat", exact: true });
  for (const field of ["Low", "High"]) await chat.getByLabel(field, { exact: true }).fill("");

  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.locator('[data-attr="handoffs"]').getByRole("listitem")).toHaveCount(2);

  const after = await stored(page);
  expect(after.handoffs).toEqual([{}, { team: "Night shift" }]);
  expect(after.reply_targets).toEqual({ ...(before.reply_targets as object), chat: {} });
  for (const k of ["review_steps", "reply_split", "open_values"]) expect(after[k], k).toEqual(before[k]);
});
