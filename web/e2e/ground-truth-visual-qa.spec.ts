import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA pass A on Ground Truth (GT-1, GT-3, GT-4). A person opens the Graph of a large
 * company (the "large" scenario's made-up regional goals, about 30), a stale From this run link
 * and the Conflicts tab on a phone. Mock API; invented data only. QA_SHOTS=<dir> also saves a
 * screenshot of each fix there.
 */

const SHOTS = process.env.QA_SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function open(page: Page, query: string, scenario?: string) {
  if (scenario) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto(`/ground-truth${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
}

const DESKTOP = [
  { name: "1440 light", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  { name: "1440 dark", viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
] as const;
const PHONE = [
  { name: "390 light", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { name: "390 dark", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
] as const;

type Narrowed = { ask?: boolean; drawer?: boolean };

/**
 * GT-1: on the "large" scenario's 30 goals the Feature column keeps its room, its header sits
 * beside Delivery's, and the goals scroll sideways under the pinned Feature column, whose edge
 * line shows where they slide under it. `ask` docks Ask, `drawer` opens the first feature's
 * drawer first: the ledger's narrowest widths.
 */
async function gt1(page: Page, { phone, tag, ask, drawer }: { phone: boolean; tag: string } & Narrowed) {
  await open(page, "?tab=graph", "large");
  const ledger = page.getByRole("table", { name: "Feature × goal" });
  await expect(ledger).toBeVisible();
  const row = ledger.locator('tr[data-testid^="feature-"]').first();
  const cell = row.locator("td").first();
  const name = cell.getByRole("button").first();
  await expect(name).toBeVisible();
  if (ask) {
    await page.getByTestId("hop-strip").click();
    await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
    // Docked beside the page, not over it.
    await expect(page.getByTestId("hop-backdrop")).toBeHidden();
  }
  if (drawer) {
    await name.click();
    await expect(page.getByRole("dialog", { name: await name.innerText() })).toBeVisible();
  }
  expect((await cell.boundingBox())!.width).toBeGreaterThan(phone ? 300 : 200);
  if (phone) {
    // A phone stacks each feature's row: nothing runs past the screen's edge.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, `gt1-graph-${tag}`);
    return;
  }
  // The Feature and Delivery headers sit side by side, never on top of each other.
  const feature = (await ledger.getByRole("columnheader", { name: "Feature" }).boundingBox())!;
  const delivery = (await ledger.getByRole("columnheader", { name: "Delivery" }).boundingBox())!;
  expect(feature.width).toBeGreaterThan(200);
  expect(delivery.x).toBeGreaterThanOrEqual(feature.x + feature.width - 1);
  await shot(page, `gt1-graph-${tag}`);

  // The last goal is reached by scrolling sideways; the feature's name stays pinned on the left.
  const scroller = page.getByTestId("ledger-scroll");
  const before = (await name.boundingBox())!;
  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const last = ledger.locator("thead tr").first().locator("th").last().getByRole("button");
  await expect(last).toBeInViewport();
  await last.hover();
  const scrolled = (await scroller.evaluate((el) => el.scrollLeft)) as number;
  expect(scrolled).toBeGreaterThan(1000);
  const after = (await name.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  await expect(name).toBeInViewport();
  // The page itself never scrolls sideways: only the ledger does.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The pinned column's right edge is a line in the theme's line colour, on its header and cells.
  for (const pinned of [ledger.getByRole("columnheader", { name: "Feature" }), cell]) {
    // Parsed, not matched as a string: some inset shadow, offset left (so drawn on the right
    // edge), unblurred, in the line colour once both colours are resolved the same way.
    const edge = await pinned.evaluate((el) => {
      const resolve = (c: string) => {
        const probe = document.createElement("span");
        probe.style.color = c;
        document.body.append(probe);
        const out = getComputedStyle(probe).color;
        probe.remove();
        return out;
      };
      const line = resolve("var(--line)");
      const shadows = getComputedStyle(el).boxShadow.split(/,(?![^(]*\))/).map((sh) => {
        const colour = sh.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-f]{3,8}\b/i)?.[0] ?? "";
        const lengths = sh.replace(colour, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
        return { inset: /\binset\b/.test(sh), x: lengths[0] ?? 0, blur: lengths[2] ?? 0, colour: colour && resolve(colour) };
      });
      return shadows.some((sh) => sh.inset && sh.x < 0 && sh.blur === 0 && sh.colour === line);
    });
    expect(edge).toBe(true);
  }
  // The Targets label stays pinned with the Feature column, so no goal's target sits under it.
  const targets = ledger.getByRole("rowheader", { name: "Targets" });
  if (await targets.count()) {
    const label = (await targets.boundingBox())!;
    expect(Math.abs(label.x - feature.x)).toBeLessThan(2);
  }
  await shot(page, `gt1-graph-scrolled-${tag}`);
}

/** GT-1 at the ledger's narrowest: Ask docked at 1680, and a feature's drawer open. */
const NARROW = [
  { name: "1680 Ask docked", viewport: { width: 1680, height: 900 }, colorScheme: "light", ask: true },
  { name: "1680 dark Ask docked", viewport: { width: 1680, height: 900 }, colorScheme: "dark", ask: true },
  { name: "1440 drawer open", viewport: { width: 1440, height: 900 }, colorScheme: "light", drawer: true },
  { name: "1440 dark drawer open", viewport: { width: 1440, height: 900 }, colorScheme: "dark", drawer: true },
  { name: "1680 Ask docked and drawer open", viewport: { width: 1680, height: 900 }, colorScheme: "light", ask: true, drawer: true },
] as const;

for (const view of NARROW) {
  test.describe(view.name, () => {
    test.use({ viewport: view.viewport, colorScheme: view.colorScheme });
    test("GT-1: the 30-goal graph keeps feature names and scrolls to every goal", async ({ page }) => {
      const narrowed: Narrowed = view;
      await gt1(page, { phone: false, tag: view.name.replaceAll(" ", "-"), ...narrowed });
    });
  });
}

for (const view of [...DESKTOP, ...PHONE]) {
  test.describe(view.name, () => {
    test.use({ viewport: view.viewport, colorScheme: view.colorScheme });
    const phone = view.viewport.width < 600;
    const tag = view.name.replace(" ", "-");

    // GT-1: 30 goals squeezed the Feature column to nothing and cut off the goals past the 10th.
    test("GT-1: a 30-goal graph keeps feature names and scrolls sideways to every goal", async ({ page }) => {
      await gt1(page, { phone, tag });
    });

    // GT-3: a stale ?tab=from-run link without its run highlighted no tab and showed nothing.
    test("GT-3: From this run without a run opens Graph", async ({ page }) => {
      await open(page, "?tab=from-run");
      await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: /From this run/ })).toHaveCount(0);
      await expect(page.getByRole("tabpanel")).toHaveAttribute("id", "panel-graph");
      await expect(page.getByRole("table", { name: "Feature × goal" })).toBeVisible();
      await shot(page, `gt3-stale-from-run-${tag}`);
    });

    // GT-4: on a phone a claim beside its Leading or Chosen badge was cut to "In progre…".
    test("GT-4: a claim beside its badge is never cut", async ({ page }) => {
      await open(page, "?tab=conflicts");
      const claims = page.getByTestId("claim");
      await expect(claims.first()).toBeVisible();
      const n = await claims.count();
      expect(n).toBeGreaterThan(1);
      for (let i = 0; i < n; i++) {
        // Each claim's words: the first span inside its first cell's row of claim and badge.
        const words = claims.nth(i).locator("td").first().locator(":scope > span > span:first-child");
        await expect(words).toBeVisible();
        const cut = await words.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
        expect(cut, `claim ${i}: ${await words.innerText()}`).toBe(false);
      }
      await expect(claims.filter({ hasText: "In progress" }).first()).toBeVisible();
      await expect(claims.filter({ hasText: "Accounts that finish setup within 7 days" }).first()).toBeVisible();
      // Nothing in Conflicts runs past the screen's edge.
      const width = view.viewport.width;
      for (const card of await page.getByTestId("conflict").all()) {
        const box = (await card.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.getByTestId("conflict").first().scrollIntoViewIfNeeded();
      await shot(page, `gt4-conflicts-${tag}`);
    });
  });
}
