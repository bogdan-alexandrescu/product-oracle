import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-edit-minors, driven through the UI on the mock API as a person would. "goal-attr-shapes" (see
 * ground-truth-goal-attr-shapes.spec.ts) gives the goal kr-1-1 a list of words "open_values", a list of objects
 * "review_steps" ({step, hours}), a list "saved_replies" entry by entry (one holding a line break), a list of one-field
 * objects "handoffs" ({team}), and the object "reply_targets" (holding the objects "chat" and "email" of numbers).
 * Test cards (protects / fails_when / no_claim):
 * - "emptied entry": protects=an existing list entry the person empties is left out, as the (i) beside Save says;
 *   fails_when=it is saved as an empty entry; no_claim=an emptied object field, which is kept.
 * - "built-in name": protects=a new field named like a built-in word ("Constructor") is saved under its name;
 *   fails_when=it is refused as already a field; no_claim=fields named alike, which are still refused.
 * - "focus": protects=Add field and Add entry put the cursor in the new input, and a new entry among multi-line
 *   entries is multi-line; fails_when=the cursor stays on the +, or the new entry is one line; no_claim=the look.
 * - "named buttons": protects=each + and x is named by its group and entry; fails_when=they all read the same.
 * - "no-op": protects=a + under a list of words with nothing typed saves no change to that list; a new field among
 *   numbers is text unless a number is typed; fails_when=the list is sent again, or words are refused.
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

/** The + under a list or an object (a fieldset), or under a list of words by its key, found by where it sits. */
const addTo = (scope: Locator, key?: string) =>
  key ? scope.locator(`[data-attr-part="${key}"] > button`) : scope.locator(":scope > button");

/** The goal's attributes as the mock saved them, as the API keeps them. */
async function stored(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    return db.baseline.entities.find((e: { key: string }) => e.key === "kr-1-1").attrs;
  });
}

test("emptied entry: an existing list entry the person empties is left out, as the (i) says", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  await form.getByRole("button", { name: "About saving" }).click();
  await expect(page.getByText("Empty entries are left out.")).toBeVisible();
  await form.getByRole("button", { name: "About saving" }).click();

  const handoffs = form.getByRole("group", { name: "Handoffs" });
  await handoffs.getByRole("group", { name: "1", exact: true }).getByLabel("Team", { exact: true }).fill("");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");

  await expect(panel.locator('[data-attr="handoffs"]').getByRole("listitem")).toHaveText(["Team: Night shift"]);
  const after = await stored(page);
  expect(after.handoffs).toEqual([{ team: "Night shift" }]);
  for (const k of ["review_steps", "reply_targets", "saved_replies", "open_values"]) expect(after[k], k).toEqual(before[k]);
});

test("built-in name: a new field named Constructor is saved under its name", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const targets = form.getByRole("group", { name: "Reply targets" });
  await addTo(targets).click();
  await targets.getByLabel("Field name").fill("Constructor");
  await targets.getByLabel("Field value").fill("Front desk lead");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(form).toHaveCount(0);
  await expect(panel.locator('[data-attr="reply_targets"]')).toContainText("Constructor: Front desk lead");
  expect((await stored(page)).reply_targets).toMatchObject({ constructor: "Front desk lead", hours: 4 });
});

test("focus: Add field and Add entry put the cursor in the new input; a new multi-line entry is multi-line", async ({ page }) => {
  const { form } = await editGoal(page);

  const targets = form.getByRole("group", { name: "Reply targets" });
  await addTo(targets).click();
  await expect(targets.getByLabel("Field name")).toBeFocused();
  await page.keyboard.type("Night team");
  await expect(targets.getByLabel("Field name")).toHaveValue("Night team");

  const steps = form.getByRole("group", { name: "Review steps" });
  await addTo(steps).click();
  await expect(steps.getByRole("group", { name: "3", exact: true }).getByLabel("Step", { exact: true })).toBeFocused();

  const replies = form.getByRole("group", { name: "Saved replies" });
  await addTo(replies).click();
  const third = replies.getByLabel("3", { exact: true });
  await expect(third).toBeFocused();
  await expect(third).toHaveJSProperty("tagName", "TEXTAREA");
  await page.keyboard.type("Thanks.\nWe are on it.");
  await expect(third).toHaveValue("Thanks.\nWe are on it.");
});

test("named buttons: each + and x names its group and entry", async ({ page }) => {
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  for (const name of [
    "Remove Review steps entry 1",
    "Remove Review steps entry 2",
    "Add entry to Review steps",
    "Remove Reply targets field Hours",
    "Remove Reply targets field Chat",
    "Add field to Reply targets field Chat",
    "Remove Reply split",
    "Add entry to Open values",
  ])
    await expect(form.getByRole("button", { name, exact: true }), name).toHaveCount(1);

  await form.getByRole("button", { name: "Remove Review steps entry 2", exact: true }).click();
  await expect(form.getByRole("button", { name: "Remove Review steps entry 2", exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  const after = await stored(page);
  expect(after.review_steps).toEqual([{ step: "Read the thread", hours: 1 }]);
  expect(after.reply_targets).toEqual(before.reply_targets);
});

test("no-op: a + under a list of words with nothing typed saves no change to it; a new field among numbers may be words", async ({
  page,
}) => {
  // What Save sends: each PATCH body the mock API reads.
  await page.addInitScript(() => {
    const sent: unknown[] = ((window as unknown as { __patches: unknown[] }).__patches = []);
    const text = Request.prototype.text;
    Request.prototype.text = async function (this: Request) {
      const raw = await text.call(this);
      if (this.method === "PATCH" && this.url.includes("/baseline/entities/")) sent.push(JSON.parse(raw));
      return raw;
    };
  });
  const { panel, form } = await editGoal(page);
  const before = await stored(page);

  await addTo(form, "open_values").click();
  await expect(form.getByRole("textbox", { name: "Open values" })).toBeFocused();

  const chat = form.getByRole("group", { name: "Reply targets" }).getByRole("group", { name: "Chat", exact: true });
  await addTo(chat).click();
  await chat.getByLabel("Field name").fill("Note");
  await chat.getByLabel("Field value").fill("busy on Mondays");
  await addTo(chat).click();
  await chat.getByLabel("Field name").last().fill("Middle");
  await chat.getByLabel("Field value").last().fill("1.5");

  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");

  const patches = await page.evaluate(() => (window as unknown as { __patches: { attrs?: Record<string, unknown> }[] }).__patches);
  expect(patches.length).toBeGreaterThan(0);
  const attrs = patches[patches.length - 1].attrs ?? {};
  expect(attrs).not.toHaveProperty("open_values");
  expect(attrs.reply_targets).toMatchObject({ chat: { low: 1, high: 2, note: "busy on Mondays", middle: 1.5 } });
  const after = await stored(page);
  expect(after.open_values).toEqual(before.open_values);
});
