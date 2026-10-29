import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 2, docs lane: Evidence coverage (qa-docs-7), Quality History and inspector
 * (qa-docs-14, 28), Quality against Publish (29), Composition words (30), Present mode
 * (24) and the Simple one-pager's Timeline on a phone (10). Driven through the UI on the mock.
 */

type Role = "viewer" | "commenter" | "approver" | "owner";

async function asRole(page: Page, role: Role) {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, role] as const);
  await login(page);
}

async function openQuality(page: Page, role: Role = "owner") {
  await asRole(page, role);
  await page.goto("/documents/saved-carts/v/2/quality");
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
}

const history = (page: Page) => page.getByRole("region", { name: "History" });
const qualityRow = (page: Page, key: string) => page.locator(`[data-testid="criterion-row"][data-key="${key}"]`);

/** The number on a chip such as "5 n/a" in `scope`, 0 when there is none. */
async function naCount(scope: Locator): Promise<number> {
  const texts = await scope.getByText(/^\d+ n\/a$/).allInnerTexts();
  return texts.reduce((sum, t) => sum + Number(t.match(/\d+/)![0]), 0);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // qa-docs-7
  test("qa-docs-7: coverage column heads carry no repeated 'unsupported'; the note is plain and short", async ({ page }) => {
    await login(page);
    await page.goto("/documents/saved-carts/v/2");
    await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/evidence/);
    const matrix = page.getByTestId("evidence-matrix");
    await expect(matrix).toBeVisible();

    const gapHeads = matrix.locator("thead th[data-gap]");
    expect(await gapHeads.count()).toBeGreaterThan(0);
    // What a sighted reader sees in each red head: the section's name only.
    const shown = await gapHeads.evaluateAll((ths) =>
      ths.map((th) => {
        const copy = th.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
        return copy.textContent ?? "";
      }),
    );
    for (const text of shown) expect(text).not.toMatch(/unsupported/i);
    // A screen reader still hears what red means.
    await expect(gapHeads.first()).toContainText("no links or citations");

    const note = page.getByTestId("evidence-coverage").locator("p").last();
    await expect(note).toContainText("A red column is a section with no links or citations.");
    await expect(note).not.toContainText(/nor has any section|rejected and superseded|Rendered pages|Per section:/);
    // Two sentences, then when the sources were read.
    const sentences = (await note.innerText()).split(/(?<=\.)\s+/).filter(Boolean);
    expect(sentences.length).toBeLessThanOrEqual(3);
  });

  // qa-docs-14
  test("qa-docs-14: History says Oracle review, with no model id or cost, even to an owner", async ({ page }) => {
    await openQuality(page, "owner");
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    await expect(page.getByTestId("job-done")).toBeVisible();
    const first = history(page).getByTestId("history-row").first();
    await expect(first).toContainText("Oracle review");
    await expect(first).toContainText("Succeeded");
    await expect(first).not.toContainText(/claude-|\$\d/);
    await history(page).getByRole("button", { name: /^Oracle review/ }).click();
    await expect(history(page).getByTestId("history-row")).toHaveCount(1);
    await expect(history(page)).not.toContainText(/claude-|\$\d/);
  });

  // qa-docs-28
  test("qa-docs-28: with no model review, the inspector tile says so instead of a dash under 'Model agrees'", async ({ page }) => {
    await openQuality(page, "owner");
    await expect(page.getByTestId("no-model-review")).toContainText("No model review for v2 yet");
    await qualityRow(page, "alternatives_tradeoffs").click();
    const tile = page.getByTestId("quality-inspector").getByTestId("stat-model-agrees");
    await expect(tile).toContainText("No model review yet");
    await expect(tile).not.toContainText("Model agrees with rules");

    // Once Oracle has reviewed, the tile no longer says there is no review.
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    await expect(page.getByTestId("job-done")).toBeVisible();
    await expect(tile).not.toContainText("No model review yet");
    await expect(tile).toContainText(/Model agrees with rules|Model did not judge this/);
  });

  // qa-docs-29
  test("qa-docs-29: Quality's n/a count is labelled as all checks and Publish's hard and advisory n/a add up to it", async ({ page }) => {
    await openQuality(page, "owner");
    await expect(page.getByTestId("criteria-tally-label")).toHaveText("All checks");
    const quality = await naCount(page.getByTestId("criteria-tally"));
    expect(quality).toBeGreaterThan(0);

    await page.goto("/documents/saved-carts/publish");
    await expect(page.getByTestId("publish-readiness")).toBeVisible();
    const hard = await naCount(page.getByRole("region", { name: "Hard checks" }).locator("div").first());
    const advisory = await naCount(page.getByRole("region", { name: "Advisory" }).locator("div").first());
    expect(hard).toBeGreaterThan(0);
    expect(hard + advisory).toBe(quality);
  });

  // qa-docs-30
  test("qa-docs-30: the composition page speaks plainly and its main button says what it does", async ({ page }) => {
    await login(page, "approver@example.com");
    await page.goto("/documents/team-workspaces/composition");
    await expect(page.getByRole("heading", { level: 1, name: "Composition" })).toBeVisible();
    const modules = page.getByTestId("composition-modules");
    await expect(modules).toBeVisible();
    await expect(page.getByText("No composition yet", { exact: true })).toBeVisible();

    const body = page.locator("body");
    for (const raw of ["Pack policy", "Condition holds", "Decided by"]) await expect(body).not.toContainText(raw);
    await expect(modules).not.toContainText(/\d+ in (brief|full)\b/);
    await expect(modules.getByRole("columnheader", { name: "Why" })).toBeVisible();
    await expect(page.getByTestId("composition-pack")).toContainText(/^Company packs?: /);

    await expect(page.getByRole("button", { name: /^Confirm revision/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Use these modules" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm revision 1" })).toBeVisible();
  });

  // qa-docs-24
  test("qa-docs-24: Present mode has a heading per slide and key hints that say what they do", async ({ page }) => {
    await login(page);
    await page.goto("/documents/saved-carts/v/2");
    await page.getByRole("link", { name: "Present" }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/present$/);
    const present = page.getByTestId("present-mode");
    await expect(page.getByTestId("slide-counter")).toHaveText("1 / 10");
    // The slides' own headings sit in their shadow roots; the page heading is the deck's.
    // Level-one headings on the page, the slides' shadow roots included.
    const h1s = () =>
      page.evaluate(() => {
        const out: string[] = [];
        const walk = (root: Document | ShadowRoot) => {
          root.querySelectorAll("h1").forEach((h) => out.push(h.textContent ?? ""));
          root.querySelectorAll("*").forEach((el) => el.shadowRoot && walk(el.shadowRoot));
        };
        walk(document);
        return out;
      });
    const heading = present.getByTestId("present-heading");
    // The title slide has its own h1: no second one is added beside it.
    await expect(present.getByTestId("current-slide")).toBeVisible();
    await expect.poll(async () => (await h1s()).length).toBe(1);
    await expect(heading).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(heading).toHaveText("Slide 2 of 10");
    expect(await heading.evaluate((el) => el.tagName)).toBe("H1");
    await expect.poll(async () => (await h1s()).length).toBe(1);

    const keys = page.getByTestId("present-keys");
    await expect(keys).toBeVisible();
    await expect(keys).toContainText("Slides");
    await expect(keys).toContainText("S");
    await expect(keys).toContainText("Notes");
    await expect(keys).toContainText("Full screen");
    await expect(keys.locator("kbd")).toHaveText(["←", "→", "S", "F"]);
    const mono = await keys.locator("kbd").evaluateAll((els) => els.filter((el) => /mono/i.test(getComputedStyle(el).fontFamily)).length);
    expect(mono).toBe(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // qa-docs-30
  test("qa-docs-30: the composition button reads 'Use these modules' in full on a phone", async ({ page }) => {
    await login(page, "approver@example.com");
    await page.goto("/documents/team-workspaces/composition");
    await expect(page.getByTestId("composition-modules")).toBeVisible();
    const action = page.getByRole("button", { name: "Use these modules" });
    await expect(action).toHaveText("Use these modules");
    const box = (await action.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await action.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  // qa-docs-10; no colour changes, so light only
  test("qa-docs-10: the one-pager's Timeline labels wrap instead of cutting the item count", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    await expect(page.getByRole("heading", { level: 1, name: "One-pagers" })).toBeVisible();
    await page.getByRole("link", { name: "Saved carts PRD" }).first().click();
    await expect(page).toHaveURL(/\/simple\/one-pagers\/saved-carts$/);
    const strip = page.getByTestId("one-pager").getByTestId("plan-strip");
    const labels = strip.getByTestId("plan-strip-label");
    await expect(labels.first()).toBeVisible();
    // Every label ends with its item count, in view.
    for (const t of await labels.allTextContents()) expect(t).toMatch(/· \d+ items?$/);
    const cut = await labels.evaluateAll((els) =>
      els
        .filter((el) => {
          const s = getComputedStyle(el);
          return s.whiteSpace === "nowrap" || el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        })
        .map((el) => el.textContent),
    );
    expect(cut).toEqual([]);
    // Never clamped: a long milestone name wraps in full (a hover tooltip does nothing on a phone).
    const clamped = await labels.evaluateAll((els) =>
      els.filter((el) => {
        const s = getComputedStyle(el);
        return s.webkitLineClamp !== "none" || s.overflow === "hidden" || el.hasAttribute("title");
      }).length,
    );
    expect(clamped).toBe(0);
    // No sideways scroll on the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
