import { expect, test, type Locator, type Page } from "./test";

import { GOAL_ATTRS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-attr-shapes, driven through the UI on the mock API as a person would. "goal-attr-shapes" adds the proposed
 * goal kr-1-1 from an OKR import (see ground-truth-goal-rename.spec.ts) also holding a list, "open_values", whose
 * entries read "[n] live helpers", "50 replied threads a day" and "[n]% of threads answered within an hour", and an
 * object, "reply_split", of email threads 60, chat threads "[n]" and a review day 2027-03-15.
 * Test cards (protects / fails_when / no_claim):
 * - "panel": protects=the panel reads the list one entry per line, a placeholder entry as Missing, and the object as
 *   its fields in words, dates month first; fails_when="[n]", an underscore key, "{" or "[" shows in its Attributes;
 *   no_claim=attributes other pages show.
 * - "edit": protects=the Edit form labels each attribute in words, offers the parent goal as a picker of goals by
 *   name, a list one line per entry and an object one field per field; editing one entry and one field and saving
 *   shows them in the panel, the untouched placeholder entries still Missing; fails_when=a raw key, "{", "[" or "[n]"
 *   shows in an attribute field, or the saved entry does not show; no_claim=the Title field, which starts from the
 *   stored name (ground-truth-goal-rename.spec.ts), and the API, which this does not change.
 * - "types": protects=each edited value is saved as its stored type, read back from the mock's saved data as the API
 *   keeps it: a nested object's field as a number, a number inside an object refusing "sixty" with the top-level
 *   error, a yes or no as true or false, a list of objects entry by entry, a list entry holding a line break as one
 *   entry; an untouched nested object, empty list and null exactly as stored; fails_when=an edited value is saved as
 *   typed text, "sixty" is saved, or an untouched value changes; no_claim=the API, which this does not change.
 * - "own parent": protects=a goal stored as its own parent, by id, is named in the picker and kept by id on Save;
 *   fails_when=the picker reads "Not in the Ground Truth" or the id changes; no_claim=whether such a parent is sensible.
 */

const CLEAN = "KR 1.1 live helpers averaging 50 replied threads a day in March 2027";

async function openGoal(page: Page, key = "kr-1-1", name = CLEAN) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, GOAL_ATTRS_SCENARIO] as const);
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  await page.getByTestId(`goal-${key}`).getByRole("button", { name }).click();
  const panel = page.getByTestId("entity-drawer");
  await expect(panel.getByRole("heading", { name })).toBeVisible();
  return panel;
}

/** The goal as the mock saved it, as the API keeps it: its id and stored attributes. */
async function stored(page: Page, key: string): Promise<{ id: string; attrs: Record<string, unknown> }> {
  return page.evaluate((k) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    return db.baseline.entities.find((e: { key: string }) => e.key === k);
  }, key);
}

/** No placeholder, underscore key, brace or bracket in `text`. */
function plain(text: string) {
  expect(text).not.toContain("[n]");
  expect(text).not.toMatch(/[a-z]_[a-z]/);
  expect(text).not.toMatch(/[{}[\]]/);
}

async function plainAttributes(panel: Locator) {
  const attrs = panel.locator('dl[aria-label="Attributes"]');
  await expect(attrs).toBeVisible();
  plain(await attrs.innerText());
  for (const title of await attrs.locator("[title]").evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""))) plain(title);
}

test("panel: a list reads one entry per line, a placeholder entry as Missing; an object as its fields in words", async ({ page }) => {
  const panel = await openGoal(page);
  const values = panel.locator('[data-attr="open_values"]').getByRole("listitem");
  await expect(values).toHaveText(["Missing", "50 replied threads a day", "Missing"]);
  await expect(panel.locator('[data-attr="reply_split"]').getByRole("listitem")).toHaveText([
    "Email threads: 60",
    "Chat threads: Missing",
    "Review by: Mar 15, 2027",
  ]);
  await expect(panel.getByText("Open values", { exact: true })).toBeVisible();
  await expect(panel.getByText("Reply split", { exact: true })).toBeVisible();
  await plainAttributes(panel);
});

test("edit: attributes read in words, the parent goal is picked by name, one list entry and one field are saved", async ({ page }) => {
  const panel = await openGoal(page);
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const form = panel.getByRole("form", { name: "Edit" });

  await expect(form.getByLabel("Parent goal")).toHaveValue("g.paid-conversion");
  await expect(form.getByLabel("Parent goal").locator("option:checked")).toHaveText("Grow paid conversion");
  const open = form.getByLabel("Open values");
  await expect(open).toHaveValue("live helpers\n50 replied threads a day\nof threads answered within an hour");
  const split = form.getByRole("group", { name: "Reply split" });
  await expect(split.getByLabel("Email threads")).toHaveValue("60");
  await expect(split.getByLabel("Chat threads")).toHaveValue("");
  await expect(split.getByLabel("Review by")).toHaveValue("2027-03-15");

  // Every attribute field, its label and its value, reads in words: no raw key, JSON or placeholder.
  const fields = form.locator("[data-attr-field]");
  await expect(fields).not.toHaveCount(0);
  for (const field of await fields.all()) {
    plain(await field.innerText());
    const values = await field
      .locator("input, textarea, select")
      .evaluateAll((els) =>
        els.map((e) => (e instanceof HTMLSelectElement ? (e.selectedOptions[0]?.textContent ?? "") : (e as HTMLInputElement).value)),
      );
    for (const v of values) plain(v);
  }

  await open.fill("live helpers\n60 replied threads a day\nof threads answered within an hour");
  await split.getByLabel("Chat threads").fill("40");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");

  await expect(panel.locator('[data-attr="open_values"]').getByRole("listitem")).toHaveText(["Missing", "60 replied threads a day", "Missing"]);
  await expect(panel.locator('[data-attr="reply_split"]').getByRole("listitem")).toHaveText([
    "Email threads: 60",
    "Chat threads: 40",
    "Review by: Mar 15, 2027",
  ]);
  await expect(panel.locator('[data-attr="parent_goal"]')).toHaveText("Grow paid conversion");
  await plainAttributes(panel);
});

test("types: each edited value is saved as its stored type; untouched values stay exactly as stored", async ({ page }) => {
  const panel = await openGoal(page);
  const before = (await stored(page, "kr-1-1")).attrs;
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const form = panel.getByRole("form", { name: "Edit" });

  // A number inside an object refuses words with the top-level error, and nothing is saved.
  const split = form.getByRole("group", { name: "Reply split" });
  await split.getByLabel("Email threads").fill("sixty");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Email threads must be a number.")).toBeVisible();
  expect((await stored(page, "kr-1-1")).attrs).toEqual(before);
  await split.getByLabel("Email threads").fill("60");

  const targets = form.getByRole("group", { name: "Reply targets" });
  await expect(targets.getByRole("group", { name: "Chat" }).getByLabel("Low")).toHaveValue("1");
  await targets.getByRole("group", { name: "Chat" }).getByLabel("Low").fill("3");
  await targets.getByLabel("Hours").fill("sixty");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Hours must be a number.")).toBeVisible();
  expect((await stored(page, "kr-1-1")).attrs.reply_targets).toEqual(before.reply_targets);
  await targets.getByLabel("Hours").fill("5");
  await targets.getByLabel("Weekends").selectOption({ label: "Yes" });

  const steps = form.getByRole("group", { name: "Review steps" });
  await expect(steps.getByRole("group", { name: "1" }).getByLabel("Step")).toHaveValue("Read the thread");
  await steps.getByRole("group", { name: "2" }).getByLabel("Hours").fill("3");

  const replies = form.getByRole("group", { name: "Saved replies" });
  await expect(replies.getByLabel("1")).toHaveValue("Thanks for writing in.\nWe will reply within a day.");
  await replies.getByLabel("2").fill("Closed after two weeks");

  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");

  await expect.poll(async () => (await stored(page, "kr-1-1")).attrs.reply_targets).toEqual({
    chat: { low: 3, high: 2 },
    email: { low: 2, high: 5 },
    hours: 5,
    weekends: true,
    owner_note: null,
    tags: [],
  });
  const after = (await stored(page, "kr-1-1")).attrs;
  expect(after.review_steps).toEqual([
    { step: "Read the thread", hours: 1 },
    { step: "Write the reply", hours: 3 },
  ]);
  expect(after.saved_replies).toEqual(["Thanks for writing in.\nWe will reply within a day.", "Closed after two weeks"]);
  // Untouched: kept exactly as stored.
  for (const k of ["reply_split", "open_values", "parent_goal", "spare_note", "old_tags"]) expect(after[k], k).toEqual(before[k]);
  expect(after).toHaveProperty("spare_note", null);
  expect(after).toHaveProperty("old_tags", []);
});

test("own parent: a goal stored as its own parent is named in the picker and kept by id", async ({ page }) => {
  const name = "Answer chat threads within an hour";
  const panel = await openGoal(page, "kr-1-2", name);
  const { id } = await stored(page, "kr-1-2");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const form = panel.getByRole("form", { name: "Edit" });
  await expect(form.getByLabel("Parent goal")).toHaveValue(id);
  await expect(form.getByLabel("Parent goal").locator("option:checked")).toHaveText(name);
  await form.getByLabel("Description").fill("Every chat thread answered within an hour.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect.poll(async () => (await stored(page, "kr-1-2")).attrs.parent_goal).toBe(id);
});
