import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on /priorities and /simple/priorities, round 4, driven through the UI on the
 * mock layer as a person would. /priorities' goal-weighted order: #1 Address lookup service
 * (F-5, ranked higher for Shipping cost shown in the cart), #2 F-2, #3 F-1 ... #8 Dark mode
 * (F-6). Under RICE, Shipping cost shown in the cart (F-2) scores 5,400.
 */

const APPROVER = "approver@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const rowOf = (page: Page, key: string) => page.getByTestId(`priority-row-${key}`);
const rows = (page: Page) => page.locator('tr[data-testid^="priority-row-"]');

async function open(page: Page, email = APPROVER) {
  await login(page, email);
  await page.goto("/priorities");
  await expect(rows(page)).toHaveCount(8);
}

async function method(page: Page, name: string) {
  const radio = page.getByRole("radiogroup", { name: "Ranking method" }).getByRole("radio", { name, exact: true });
  await radio.click();
  await expect(radio).toHaveAttribute("aria-checked", "true");
}

async function pick(page: Page, key: string) {
  await rowOf(page, key).getByTestId("feature-name").click();
  await expect(page.getByTestId(`explanation-${key}`)).toBeVisible();
}

/** The element's drawn text fits it: no digit or word runs past its box. */
async function fits(l: Locator) {
  return l.evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-plan-6: the inspector's RICE score fits its tile", async ({ page }) => {
    await open(page);
    await method(page, "RICE");
    for (const key of ["F-2", "F-6"]) {
      await pick(page, key);
      const tile = page.getByTestId("priority-inspector").getByTestId("inspector-score");
      await expect(tile).toBeVisible();
      const figure = tile.locator("dd > span");
      await expect(figure).toHaveText(await rowOf(page, key).getByTestId("score").innerText());
      const [t, f] = [(await tile.boundingBox())!, (await figure.boundingBox())!];
      expect(f.x + f.width, `${key}: the score runs past its tile`).toBeLessThanOrEqual(t.x + t.width + 0.5);
      expect(await fits(figure), `${key}: the score is cut`).toBe(true);
      expect(await fits(tile), `${key}: the tile overflows`).toBe(true);
    }
    await expect(page.getByTestId("priority-inspector").getByTestId("inspector-score")).not.toContainText("…");
  });

  test("qa-plan-33: the inspector's eyebrow says Feature, not 'Feature · selected'", async ({ page }) => {
    await open(page);
    const inspector = page.getByTestId("priority-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).not.toContainText("selected");
    await expect(inspector.getByText("Feature", { exact: true })).toBeVisible();
  });

  test("qa-plan-27: the panels' counts are neutral text, not a link's blue", async ({ page }) => {
    await open(page);
    const count = page.locator('[aria-label="By goal"]').getByTestId("panel-count").first();
    await expect(count).toBeVisible();
    const [shown, text2, accent] = await count.evaluate((e) => {
      const inner = (e.firstElementChild as HTMLElement | null) ?? e;
      const probe = (cls: string) => {
        const p = document.createElement("span");
        p.className = cls;
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      };
      return [getComputedStyle(inner).color, probe("text-text2"), probe("text-accent-ink")];
    });
    expect(shown).toBe(text2);
    expect(shown).not.toBe(accent);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-plan-48: the selected row's blue flag keeps a chip of its own (${scheme})`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("oracle-theme", t), scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const row = rowOf(page, "F-5");
      await expect(row).toHaveAttribute("aria-selected", "true");
      const chip = row.getByTestId("rank-reason").first();
      await expect(chip).toHaveAttribute("data-kind", "acc");
      const [chipBg, rowBg] = await Promise.all([
        chip.evaluate((e) => getComputedStyle(e).backgroundColor),
        row.evaluate((e) => getComputedStyle(e).backgroundColor),
      ]);
      expect(chipBg, "the chip is the row's own blue").not.toBe(rowBg);
    });
  }

  test("qa-plan-49: a flag is one short line; its full sentence is in the tooltip", async ({ page }) => {
    await open(page);
    for (const key of ["F-5", "F-6", "F-7"]) {
      const chips = rowOf(page, key).getByTestId("row-flags").locator("[data-kind]");
      const n = await chips.count();
      expect(n, key).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const box = (await chips.nth(i).boundingBox())!;
        expect(box.height, `${key}: a flag wraps onto more lines`).toBeLessThanOrEqual(28);
        expect(await fits(chips.nth(i)), `${key}: a flag is cut`).toBe(true);
      }
    }
    const why = rowOf(page, "F-5").getByTestId("rank-reason");
    await expect(why).toHaveAttribute("title", /^Ranked higher: Shipping cost shown in the cart depends on it\./);
    await expect(why).toHaveText("Ranked higher: Shipping cost shown in the cart depends on it");
  });

  test("qa-plan-50: MoSCoW and RICE scores are whole numbers; goal-weighted keeps two places", async ({ page }) => {
    await open(page);
    await method(page, "MoSCoW");
    const moscow = await rows(page).getByTestId("score").allInnerTexts();
    for (const s of moscow) expect(s.trim()).toMatch(/^(\d+|—)$/);
    await method(page, "RICE");
    await expect(rowOf(page, "F-2").getByTestId("score")).toHaveText("5,400");
    for (const s of await rows(page).getByTestId("score").allInnerTexts()) expect(s.trim()).toMatch(/^([\d,]+|—)$/);
    await pick(page, "F-2");
    await expect(page.getByTestId("inspector-score")).toContainText("5,400");
    await expect(page.getByTestId("inspector-score")).not.toContainText("5,400.00");
    await method(page, "Goal-weighted");
    await expect(rowOf(page, "F-2").getByTestId("score")).toHaveText("8.10");
  });

  test("qa-plan-51: an input read from the feature says 'The feature', not its name again", async ({ page }) => {
    await open(page);
    await pick(page, "F-1");
    const ex = page.getByTestId("explanation-F-1");
    const effort = ex.getByRole("row", { name: /^Effort\b/ });
    await expect(effort.getByRole("cell").nth(2)).toHaveText("The feature");
    await expect(ex).not.toContainText("(from the feature)");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-plan-52: each card shows the feature's confidence", async ({ page }) => {
    await open(page);
    for (const key of ["F-5", "F-2", "F-1"]) {
      const conf = rowOf(page, key).getByTestId("phone-confidence");
      await expect(conf).toBeVisible();
      await expect(conf).toHaveText(/^\d+(\.\d)?%$/);
    }
    await expect(rowOf(page, "F-5")).toContainText("Confidence");
  });
});

// ------------------------------------------------------------------- /simple/priorities

async function simple(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
}

test.describe("simple priorities", () => {
  test.use({ viewport: DESKTOP });

  // Train AD: Simple priorities' own lane wins: a draft is added with "Add to the ranking", or
  // "Propose adding" by whom only proposes (over qa-plan-14's Confirm / Propose).
  test("qa-plan-14: a commenter is offered Propose adding, not Add to the ranking; the handle says it proposes", async ({ page }) => {
    await simple(page, "commenter@example.com");
    const draft = page.getByTestId("prio-draft").first();
    await expect(draft).toBeVisible();
    await expect(draft.getByRole("button", { name: "Add to the ranking", exact: true })).toHaveCount(0);
    const propose = draft.getByRole("button", { name: "Propose adding", exact: true });
    await expect(propose).toBeVisible();
    const handle = page.getByRole("button", { name: /^Drag .* to reorder$/ }).first();
    if (await handle.count()) await expect(handle).toHaveAttribute("title", /propose/i);
    await propose.click();
    await expect(page.getByText(/^Proposed: .* decides?$/)).toBeVisible();
  });

  test("qa-plan-14: an owner still adds a draft to the ranking", async ({ page }) => {
    await simple(page);
    const draft = page.getByTestId("prio-draft").first();
    await expect(draft.getByRole("button", { name: "Add to the ranking", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Drag .* to reorder$/ }).first()).toHaveAttribute("title", /^Drag to reorder/);
  });

  // Train AD: Simple priorities' own lane wins on its rows: a score is written to at most two
  // places, its trailing zeros dropped ("1.6", "1.25"), over qa-plan-53's fixed two places.
  test("qa-plan-53: every score is a number to at most two places", async ({ page }) => {
    await simple(page);
    const scores = await page.getByTestId("prio-score").allInnerTexts();
    expect(scores.length).toBeGreaterThan(1);
    for (const s of scores) expect(s.trim()).toMatch(/^(\d+(\.\d{1,2})?|–)$/);
  });
});
