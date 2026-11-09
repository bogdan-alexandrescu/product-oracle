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
 */

const CLEAN = "KR 1.1 live helpers averaging 50 replied threads a day in March 2027";

async function openGoal(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, GOAL_ATTRS_SCENARIO] as const);
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  await page.getByTestId("goal-kr-1-1").getByRole("button", { name: CLEAN }).click();
  const panel = page.getByTestId("entity-drawer");
  await expect(panel.getByRole("heading", { name: CLEAN })).toBeVisible();
  return panel;
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
