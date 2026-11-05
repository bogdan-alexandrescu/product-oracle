import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA pass B on the run's Ground Truth review stop (/ground-truth?run=…): a row shows its
 * name, never its internal key (B-01); the bottom decision bar keeps clear of the Ask dock and
 * of the page's last row, its button and gate line read in full (B-02); a review that cannot
 * load says so in plain words with Try again, never the API's words or an id (B-03); the
 * blocker's gate reason names it by its statement, never its key. Mock API ("baseline-review"
 * scenario: an Oct 20 Build the Ground Truth run waiting at its review); invented data only.
 * QA_SHOTS=<dir> also saves a screenshot of each view there.
 */

const RUN = "7a11c0de-0000-4000-8000-0000000000b2";
const MISSING = "7a11c0de-0000-4000-8000-00000000dead";
const SHOTS = process.env.QA_SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function open(page: Page, run: string, scenario = "baseline-review") {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto(`/ground-truth?run=${run}`);
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** True when the element's text fits its box: nothing cut off with an ellipsis or hidden. */
const fits = (l: Locator) => l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);

const bar = (page: Page) => page.getByTestId("from-run-bar");

const VIEWS = [
  { name: "1440 light", viewport: { width: 1440, height: 900 }, colorScheme: "light", ask: false },
  { name: "1440 dark", viewport: { width: 1440, height: 900 }, colorScheme: "dark", ask: false },
  { name: "1680 Ask open", viewport: { width: 1680, height: 900 }, colorScheme: "light", ask: true },
  { name: "390 light", viewport: { width: 390, height: 844 }, colorScheme: "light", ask: false },
  { name: "390 dark", viewport: { width: 390, height: 844 }, colorScheme: "dark", ask: false },
] as const;

for (const view of VIEWS) {
  test.describe(view.name, () => {
    test.use({ viewport: view.viewport, colorScheme: view.colorScheme });
    const phone = view.viewport.width < 600;
    const tag = view.name.replaceAll(" ", "-");

    test("B-01, B-02: rows show names only, and the decision bar clears the Ask dock and the last row", async ({ page }) => {
      await open(page, RUN);
      const rows = page.getByTestId("from-run-row");
      await expect(rows).toHaveCount(4);
      // B-01: the name identifies the row; no internal key ("goal:g.…", "feature:f.…") under it.
      for (const r of await rows.all()) await expect(r).not.toContainText(/\b(goal|feature|metric|blocker|persona):[a-z]/);

      if (view.ask) {
        await page.getByTestId("hop-strip").click();
        await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
      }
      const b = bar(page);
      await expect(b).toBeVisible();
      const approve = b.getByRole("button", { name: "Approve the Ground Truth" });
      await expect(approve).toBeVisible();
      expect(await fits(approve)).toBe(true);
      const gate = b.getByTestId("bar-gate");
      await expect(gate).toBeVisible();
      expect(await fits(gate)).toBe(true);
      const barBox = await box(b);
      // Inside the window, its button and gate line within it.
      expect(barBox.x).toBeGreaterThanOrEqual(0);
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(view.viewport.width + 0.5);
      for (const part of [approve, gate]) {
        const p = await box(part);
        expect(p.x + p.width).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
      }
      if (!phone) {
        // B-02: the bar stops where the Ask dock (its strip, or the open panel) starts.
        const dock = await box(page.getByTestId("hop-dock"));
        expect(barBox.x + barBox.width).toBeLessThanOrEqual(dock.x + 0.5);
      } else {
        // On a phone it sits above the tab bar, not under it.
        const tabs = await box(page.getByTestId("tab-bar"));
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabs.y + 0.5);
      }
      await shot(page, `b02-review-stop-${tag}`);
      // Scrolled to the end, nothing sits under the bar: the last thing on the page shows above it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const others = page.getByText(/Other proposed goals \(\d+\)/);
      const last = (await others.count()) ? others : rows.last();
      const lastBox = await box(last);
      const barAt = await box(b);
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barAt.y + 0.5);
      await shot(page, `b02-review-stop-end-${tag}`);
    });

    test("B-03: a review that cannot load says so in plain words with Try again", async ({ page }) => {
      await open(page, MISSING);
      const err = page.getByTestId("load-error");
      await expect(err).toContainText("Couldn't load this run's review.");
      await expect(err.getByRole("button", { name: "Try again" })).toBeVisible();
      // Never the API's words, nor any id.
      await expect(page.locator("#main")).not.toContainText(/not found/i);
      await expect(page.locator("#main")).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      // The From this run tab keeps its place and its body says what went wrong, not blank.
      await expect(page.getByRole("tab", { name: /From this run/ })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toContainText("Couldn't load this run's review.");
      await err.getByRole("button", { name: "Try again" }).click();
      await expect(err).toContainText("Couldn't load this run's review.");
      await shot(page, `b03-load-error-${tag}`);
    });
  });
}

test("the blocker's gate reason names it by its statement, never its key", async ({ page }) => {
  await login(page);
  await page.goto("/ground-truth?tab=blockers");
  const statement = "The address lookup service allows 100 requests a minute per company";
  await page.getByTestId("blocker-row").filter({ hasText: statement }).click();
  const insp = page.getByTestId("blocker-inspector");
  await expect(insp.getByRole("heading", { name: statement })).toBeVisible();
  await expect(insp).toContainText(`Critical hard blocker '${statement}' is unresolved`);
  await expect(insp).not.toContainText("address-lookup-rate-limit");
});
