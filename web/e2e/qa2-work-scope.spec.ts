import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass on the Feature set review page, /runs/<id>/review/<checkpoint> (rirs-1, 2, 3, 4, 5,
 * 11, 12, 13, 14, 24, 25, 41), driven through the UI on the mock: the "feature-set" scenario
 * (Saved addresses PRD, its left-out rows titled only by their keys) and the "scope-review"
 * scenario (an approver, a commenter and a viewer on the same stop).
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function seeded(page: Page, scenario: "feature-set" | "scope-review", email?: string) {
  // A fresh context per test: the mock's database starts from the scenario.
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

/** Runs › Saved addresses PRD › Review feature set, as a person goes there. */
async function openReview(page: Page) {
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').filter({ visible: true }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+/);
  await expect(page.getByTestId("scope-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: title }) });
const inspector = (page: Page) => page.getByTestId("scope-inspector").filter({ visible: true });

/** The contrast of an element's text (its colour, or an SVG text's fill) on the first painted background under it. */
async function contrastOf(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    // Any CSS colour (oklab, color-mix, alpha) painted over the page's white, read back as sRGB.
    const ctx = document.createElement("canvas").getContext("2d")!;
    const paint = (...layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const c of layers) {
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
      }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const style = getComputedStyle(node);
    const fg = node instanceof SVGTextElement ? style.fill : style.color;
    const layers: string[] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const c = getComputedStyle(at).backgroundColor;
      if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") layers.unshift(c);
    }
    const bgLayers = ["#fff", ...layers];
    const bg = paint(...bgLayers);
    const text = paint(...bgLayers, fg);
    const [a, b] = [lum(text), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("rirs-1: the Include fix for Bulk address edit stays inside the table card", async ({ page }) => {
    await seeded(page, "feature-set");
    await openReview(page);
    const fix = row(page, "Bulk address edit").getByRole("button", { name: "Include Shared address book export" });
    await expect(fix).toBeVisible();
    const table = (await page.getByTestId("scope-table").boundingBox())!;
    const box = (await fix.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(table.x + table.width);
    expect(await fix.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  test("rirs-2: goals, the PRD and the left-out feature read as names, never as keys", async ({ page }) => {
    await seeded(page, "feature-set");
    await openReview(page);
    await expect(page.getByTestId("scope-for")).toHaveText("For Saved addresses PRD · attempt 1");
    await page.getByRole("button", { name: /^All/ }).click();
    await row(page, "Bulk address edit").getByTestId("feature-title").click();
    await expect(inspector(page).getByTestId("reason-depends_on_excluded")).toContainText("Bulk address edit depends on Shared address book export, which is left out");
    await row(page, "Saved addresses").getByTestId("feature-title").click();
    await expect(inspector(page)).toContainText("A goal not in the baseline");
    const text = await page.locator("main").innerText();
    for (const key of ["repeat-checkout", "fewer-failed-deliveries", "shared-address-book-export", "bulk-address-edit", "saved-addresses"]) expect(text).not.toContain(key);
  });

  test("rirs-3: an inspector requirement shows its text in full, the buttons below it", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    await row(page, "Pick address in one step").getByTestId("feature-title").click();
    const req = inspector(page).getByTestId("requirement-pick-address-one-screen");
    const text = req.getByTestId("requirement-text");
    await expect(text).toBeVisible();
    expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const t = (await text.boundingBox())!;
    const cut = (await req.getByRole("button", { name: "Cut", exact: true }).boundingBox())!;
    expect(cut.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`rirs-11: the inspector's confidence figure, the row chevron and number read at 4.5:1 (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await seeded(page, "scope-review", APPROVER);
      await openReview(page);
      await row(page, "Pick address in one step").getByTestId("feature-title").click();
      const figure = inspector(page).getByRole("img", { name: /^Confidence/ }).locator("text");
      expect(await contrastOf(figure)).toBeGreaterThanOrEqual(4.5);
      const pick = row(page, "Pick address in one step");
      expect(await contrastOf(pick.getByTestId("row-chevron"))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(pick.getByTestId("row-number"))).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("rirs-12: the columns and acceptance counts say what they are", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    await expect(page.getByRole("columnheader", { name: "Confidence" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Requirements kept" })).toBeVisible();
    await expect(page.locator('abbr[title="Confidence"]')).toHaveCount(1);
    const pick = row(page, "Pick address in one step");
    await pick.getByRole("button", { name: "Requirements of Pick address in one step" }).click();
    const checks = pick.getByTestId("requirement-pick-address-one-screen").getByTestId("requirement-checks");
    await expect(checks).toHaveText(/^\d+ acceptance checks?$/);
    await expect(pick).not.toContainText(/\d AC\b/);
  });

  for (const [email, who, note] of [
    [COMMENTER, "a commenter", "An approver decides; you can suggest a change."],
    [VIEWER, "a viewer", "An approver decides."],
  ] as const) {
    test(`rirs-13: ${who} sees Needs a decision and a read-only decision with who decides`, async ({ page }) => {
      await seeded(page, "scope-review", email);
      await openReview(page);
      await expect(page.getByRole("button", { name: /^Needs a decision/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Needs you/ })).toHaveCount(0);
      await expect(page.getByRole("columnheader", { name: "Needs a decision because" })).toBeVisible();
      await row(page, "Address labels").getByTestId("feature-title").click();
      const decision = inspector(page).getByRole("group", { name: "Decision" });
      for (const name of ["Include", "Leave out", "Defer to a later PRD"]) await expect(decision.getByRole("button", { name, exact: true })).toBeDisabled();
      await expect(inspector(page).getByTestId("who-decides")).toHaveText(note);
      await expect(inspector(page)).not.toContainText("Needs you because");
    });
  }

  test("rirs-14: a feature still to confirm shows Proposed: include, not a decision", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    await row(page, "Address labels").getByTestId("feature-title").click();
    await expect(inspector(page)).toContainText("Proposed: include");
    await expect(inspector(page).getByTestId("proposed-decision")).toBeVisible();
    await expect(inspector(page).getByRole("group", { name: "Decision" }).getByRole("button", { name: "Include", exact: true })).toHaveAttribute("aria-pressed", "false");
    // Once the person decides, the decision shows.
    await inspector(page).getByRole("group", { name: "Decision" }).getByRole("button", { name: "Defer to a later PRD" }).click();
    await expect(inspector(page).getByTestId("proposed-decision")).toHaveCount(0);
    await expect(inspector(page).getByRole("group", { name: "Decision" }).getByRole("button", { name: "Defer to a later PRD" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("rirs-4: the Decide sheet sits above the tab bar and Approve is reachable", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    await page.getByTestId("decision-bar").getByRole("button").click();
    const sheet = page.getByTestId("sheet-decide");
    await expect(sheet).toBeVisible();
    for (const name of [/^Approve/, /^Send back to agents/]) {
      const button = sheet.getByRole("button", { name });
      await button.scrollIntoViewIfNeeded();
      const onTop = await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && (hit === el || el.contains(hit));
      });
      expect(onTop).toBe(true);
    }
  });

  test("rirs-5: the collapsed bar says a blocking problem is left and does not look like Approve", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    const button = page.getByTestId("decision-bar").getByRole("button");
    await expect(button).toHaveText("1 blocking problem left · Review and decide");
    await expect(button).not.toHaveAttribute("data-variant", "solid");
  });

  test("rirs-24: the run's full name shows on the page, wrapped", async ({ page }) => {
    await seeded(page, "feature-set");
    await openReview(page);
    const name = page.getByRole("link", { name: "Saved addresses PRD · Baseline to PRD", exact: true });
    await expect(name).toHaveAttribute("data-testid", "run-name");
    await expect(name).toBeVisible();
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  test("rirs-25: the feature titles and the row buttons are at least 24 px tall", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    const heights = await page.getByTestId("scope-table").locator("button").evaluateAll((els) =>
      els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => [e.textContent?.trim() ?? "", e.getBoundingClientRect().height] as const),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const [label, h] of heights) expect(h, label).toBeGreaterThanOrEqual(24);
  });

  test("rirs-41: each card has a labelled Details control on its title line, no lone chevron", async ({ page }) => {
    await seeded(page, "scope-review", APPROVER);
    await openReview(page);
    const bulk = row(page, "Bulk edit");
    await expect(bulk.getByTestId("row-chevron")).toBeHidden();
    const details = bulk.getByRole("button", { name: "Details of Bulk edit" });
    await expect(details).toBeVisible();
    await expect(details).toHaveText(/^Details/);
    const title = (await bulk.getByTestId("feature-title").boundingBox())!;
    const box = (await details.boundingBox())!;
    expect(box.y).toBeLessThan(title.y + title.height);
    expect(box.y + box.height).toBeGreaterThan(title.y);
    await details.click();
    await expect(page.getByTestId("sheet-feature").getByTestId("scope-inspector")).toContainText("Bulk edit");
  });
});
