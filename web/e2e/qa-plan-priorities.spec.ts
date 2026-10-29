import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

/*
 * QA findings on /priorities (group "priorities"), driven through the UI on the mock layer:
 * - qa-plan-7: ▲ ▼ ⋯ sit in a column of their own, never over the Flags cell.
 * - qa-plan-13: the inspector names inputs and MoSCoW categories in words, in body font.
 * - qa-plan-14: on a phone a tapped feature opens in a bottom sheet.
 * - qa-plan-20: a row out of score order says why in the row itself.
 * - qa-plan-38 / qa-plan-39: the snapshot note sits labelled beside Save snapshot, for those
 *   who can save one (in the Snapshots panel); the "Order" view switch for every role (qa-plan-22).
 * - qa-plan-40 / qa-plan-41: one number style in body font; evidence by kind of source and
 *   date in words; no evidence ids; the confidence line in words.
 * - qa-plan-42 / prod-4: Goal and Depends on read in full.
 * - prod-5: a source titled by its ref reads "Pull request #920 in svc-backend".
 */

const APPROVER = "approver@example.com";
const rowOf = (page: Page, key: string) => page.getByTestId(`priority-row-${key}`);
const rows = (page: Page) => page.locator('tr[data-testid^="priority-row-"]');

async function open(page: Page, email = APPROVER) {
  await login(page, email);
  await page.goto("/priorities");
  await expect(rows(page).first()).toBeVisible();
}

const mono = (loc: Locator) => loc.evaluate((e) => /mono/i.test(getComputedStyle(e).fontFamily));

/** Nothing in the element is cut: no sideways overflow, no clamped lines. */
async function notCut(el: Locator) {
  const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }));
  expect(m.sw, "cut sideways").toBeLessThanOrEqual(m.cw + 1);
  expect(m.sh, "cut below").toBeLessThanOrEqual(m.ch + 1);
}

test("qa-plan-7: the row's ▲ ▼ ⋯ never cover its flags", async ({ page }) => {
  await open(page);
  for (const key of ["F-4", "F-7", "F-6"]) {
    const row = rowOf(page, key);
    const actions = row.getByTestId("row-actions");
    // Hover again if the rows were still settling when the mouse first arrived.
    await expect(async () => {
      await row.hover();
      await expect(actions.getByRole("button", { name: "More actions" })).toBeVisible({ timeout: 1000 });
    }).toPass();
    const flags = row.getByRole("gridcell").filter({ has: page.getByTestId("row-flags") });
    await expect(flags.getByTestId("row-flags").locator(":scope > *").first()).toBeVisible();
    const [a, c] = [(await actions.boundingBox())!, (await flags.boundingBox())!];
    // The actions start right of the Flags cell's end.
    expect(a.x, key).toBeGreaterThanOrEqual(c.x + c.width - 1);
  }
});

test("qa-plan-13: inputs, MoSCoW and formulas in words and body font; the cycle banner too", async ({ page }) => {
  await open(page);
  const banner = page.getByTestId("cycles-banner");
  await expect(banner).toContainText("Bulk export");
  expect(await mono(banner.locator("span.font-medium").first())).toBe(false);

  await rowOf(page, "F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const ex = page.getByTestId("explanation-F-1");
  await expect(ex.getByRole("cell", { name: "Effort (from the feature)" })).toBeVisible();
  await expect(ex).not.toContainText("attrs.");
  expect(await mono(ex.getByRole("list", { name: "Steps" }))).toBe(false);

  await page.getByRole("radiogroup", { name: "Ranking method" }).getByRole("radio", { name: "MoSCoW" }).click();
  await expect(page.getByTestId("formula")).toContainText("Must have (4)");
  expect(await mono(page.getByTestId("formula"))).toBe(false);
  await rowOf(page, "F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const steps = page.getByTestId("explanation-F-1").getByRole("list", { name: "Steps" });
  await expect(steps).toContainText("Must have = 4; ties broken by goal value 6");
  await expect(page.getByTestId("explanation-F-1").getByRole("cell", { name: "Must have", exact: true })).toBeVisible();
  await expect(page.getByTestId("explanation-F-1")).toContainText("MoSCoW (from the feature)");
  await expect(page.getByTestId("explanation-F-1")).not.toContainText("tie-break");
});

test("qa-plan-20: every row out of score order says why in the row", async ({ page }) => {
  await open(page);
  const methods = page.getByRole("radiogroup", { name: "Ranking method" });
  for (const method of ["Goal-weighted", "RICE", "MoSCoW", "WSJF"]) {
    await methods.getByRole("radio", { name: method }).click();
    await expect(methods.getByRole("radio", { name: method })).toHaveAttribute("aria-checked", "true");
    await expect(rows(page).first()).toBeVisible();
    const list = await rows(page).evaluateAll((els) =>
      els.map((e) => {
        const t = e.querySelector('[data-testid="score"]')!.textContent!.replace(/,/g, "");
        return {
          key: e.getAttribute("data-testid")!,
          score: Number.isFinite(Number(t)) ? Number(t) : -Infinity,
          why: e.querySelectorAll('[data-testid="rank-reason"]').length,
        };
      }),
    );
    list.forEach((r, i) => {
      const out = list.slice(0, i).some((x) => x.score < r.score) || list.slice(i + 1).some((x) => x.score > r.score);
      if (out) expect(r.why, `${method} ${r.key} is out of score order`).toBeGreaterThan(0);
    });
  }
  // RICE: Dark mode (600) sits last because it serves no goal; Usage alerts has no reach.
  await methods.getByRole("radio", { name: "RICE" }).click();
  await expect(rowOf(page, "F-6").getByTestId("rank-reason")).toHaveText("Ranked lower: no confirmed goal");
  await expect(rowOf(page, "F-4").getByTestId("rank-reason")).toHaveText("Not scored: no Reach");
  // MoSCoW: Could have (2) above Should have (3) for a dependency.
  await methods.getByRole("radio", { name: "MoSCoW" }).click();
  await expect(rowOf(page, "F-5").getByTestId("rank-reason")).toHaveText(
    "Ranked higher: Shipping cost shown in the cart depends on it",
  );
});

for (const role of ["viewer", "commenter"]) {
  // qa-plan-22 replaces qa-plan-38's Order rule: the view switch stays for read-only roles.
  test(`qa-plan-38: a ${role} has no snapshot note, keeps the Order view switch`, async ({ page }) => {
    await open(page, `${role}@example.com`);
    await expect(page.getByRole("radiogroup", { name: "Ranking method" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Order" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Oracle's order" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Snapshot note/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save snapshot" })).toHaveCount(0);
  });
}

test("qa-plan-39: the snapshot note is labelled and sits beside Save snapshot", async ({ page }) => {
  await open(page);
  const save = page.getByTestId("snapshot-save");
  const note = save.getByLabel("Snapshot note (optional)");
  await expect(note).toBeVisible();
  await expect(save.getByRole("button", { name: "Save snapshot" })).toBeVisible();
  await expect(page.getByTestId("snapshot-list").or(page.getByText("No snapshots yet."))).toBeVisible();
  // One note box only, in the Snapshots panel.
  await expect(page.getByRole("textbox", { name: /Snapshot note/ })).toHaveCount(1);
  await note.fill("Before planning");
  await save.getByRole("button", { name: "Save snapshot" }).click();
  await expect(page.getByTestId("snapshot-list")).toContainText("Before planning");
});

test("qa-plan-40: scores in one style and body font; the Move dialog names the source and date", async ({ page }) => {
  await open(page);
  await page.getByRole("radiogroup", { name: "Ranking method" }).getByRole("radio", { name: "RICE" }).click();
  await expect(rowOf(page, "F-2").getByTestId("score")).toHaveText("5,400.00");
  await expect(rowOf(page, "F-8").getByTestId("score")).toHaveText("83.33");
  expect(await mono(rowOf(page, "F-2").getByTestId("score"))).toBe(false);

  await page.getByRole("radiogroup", { name: "Ranking method" }).getByRole("radio", { name: "Goal-weighted" }).click();
  const row = rowOf(page, "F-5");
  await row.hover();
  await row.getByRole("button", { name: "Move down", exact: true }).click();
  const chip = page.getByRole("dialog").getByTestId("evidence-chip").first();
  await expect(chip).toContainText("Issue 412");
  await expect(chip).toContainText("GitHub");
  await expect(chip).toContainText("Aug 30");
  await expect(chip).not.toContainText("2026-08-30");
  expect(await mono(chip.locator("span").last())).toBe(false);
});

test("qa-plan-41: no evidence ids; the confidence line in words", async ({ page }) => {
  await open(page);
  await rowOf(page, "F-5").getByRole("button", { name: "Address lookup service" }).click();
  const ex = page.getByTestId("explanation-F-5");
  await ex.getByRole("button", { name: "About Confidence used" }).click();
  await expect(ex.getByTestId("confidence-explain")).toHaveText("Average of 1 evidence item: 60%");
  await ex.getByTestId("evidence-chip").first().click();
  const card = page.getByTestId("code-card");
  await expect(card).toContainText("Issue 412");
  await expect(card).not.toContainText("ev-4");
  await expect(page.locator("main")).not.toContainText("evidence item(s)");
});

test("qa-plan-42 / prod-4: Goal and Depends on read in full, every goal whole", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "named-codes"), MOCK_SCENARIO_KEY);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await open(page);
  for (const key of ["F-1", "F-2", "F-7"]) {
    const goals = rowOf(page, key).getByTestId("row-goals");
    await expect(goals.getByTestId("code-chip").first()).toBeVisible();
    for (const name of await goals.getByTestId("code-name").all()) await notCut(name);
    await notCut(goals);
  }
  const deps = rowOf(page, "F-2").getByTestId("row-deps");
  await expect(deps).toBeVisible();
  await expect(deps).toHaveText("Address lookup service");
  await notCut(deps);
});

test("prod-5: a source titled by its ref reads as words", async ({ page }) => {
  await open(page);
  await rowOf(page, "F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const ex = page.getByTestId("explanation-F-1");
  await expect(ex.getByTestId("evidence-chip").filter({ hasText: "Pull request #920 in svc-backend" })).toBeVisible();
  await expect(ex).not.toContainText("svc-backend#920");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-plan-14: tapping a feature opens it in a bottom sheet", async ({ page }) => {
    await open(page);
    await rowOf(page, "F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
    const sheet = page.getByTestId("priority-sheet");
    const dialog = sheet.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("explanation-F-1")).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(800);
    expect(box.y).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("qa-plan-7: on a phone the row's buttons sit in reach, no sideways scroll", async ({ page }) => {
    await open(page);
    const row = rowOf(page, "F-4");
    await expect(row.getByRole("button", { name: "More actions" })).toBeVisible();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
});
