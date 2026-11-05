import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA pass A on Ground Truth (GT-1 to GT-5). A person opens the Graph of a large company
 * (the "large" scenario's made-up regional goals, about 30), a blocker, a stale From this run
 * link and the Conflicts tab on a phone. Mock API; invented data only. QA_SHOTS=<dir> also
 * saves a screenshot of each fix there.
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
  // The pinned column's right edge is a line in the theme's line colour, on its header and cells.
  for (const pinned of [ledger.getByRole("columnheader", { name: "Feature" }), cell]) {
    const edge = await pinned.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--line)";
      document.body.append(probe);
      const line = getComputedStyle(probe).color;
      probe.remove();
      return { shadow: getComputedStyle(el).boxShadow, line };
    });
    expect(edge.shadow).toContain(`${edge.line} -1px 0px 0px 0px inset`);
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

    // GT-2: the inspector's eyebrow showed the blocker's internal key in a code font.
    test("GT-2: the blocker inspector's eyebrow says Blocker, no key", async ({ page }) => {
      await open(page, "?tab=blockers");
      await page.getByTestId("blocker-row").filter({ hasText: "The address lookup service" }).click();
      const insp = page.getByTestId("blocker-inspector");
      await expect(insp.getByRole("heading", { name: "The address lookup service allows 100 requests a minute per company" })).toBeVisible();
      const head = insp.locator("[data-inspector-head]");
      await expect(head.getByText("Blocker", { exact: true })).toBeVisible();
      expect(await head.innerText()).not.toContain("address-lookup-rate-limit");
      await insp.scrollIntoViewIfNeeded();
      await shot(page, `gt2-blocker-${tag}`);
    });

    // GT-3: a stale ?tab=from-run link without its run highlighted no tab and showed nothing.
    test("GT-3: From this run without a run opens Graph", async ({ page }) => {
      await open(page, "?tab=from-run");
      await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: /From this run/ })).toHaveCount(0);
      await expect(page.getByRole("table", { name: "Feature × goal" })).toBeVisible();
      await shot(page, `gt3-stale-from-run-${tag}`);
    });

    // GT-5: a standing legend line sat above the table; it now lives in the panel's (i).
    test("GT-5: the graph's legend is behind the Feature × goal (i)", async ({ page }) => {
      await open(page, "?tab=graph");
      await expect(page.getByRole("table", { name: "Feature × goal" })).toBeVisible();
      await expect(page.getByText("Rings: confidence, 0 to 100%")).toBeHidden();
      const about = page.getByRole("button", { name: "About Feature × goal" });
      await about.click();
      await expect(page.getByTestId("ledger-legend")).toBeVisible();
      await expect(page.getByTestId("ledger-legend")).toContainText("Rings: confidence, 0 to 100%");
      await expect(page.getByTestId("ledger-legend")).toContainText("A dot: no link.");
      await shot(page, `gt5-legend-${tag}`);
    });

    // GT-4: on a phone a claim beside its Leading or Chosen badge was cut to "In progre…".
    test("GT-4: a claim beside its badge is never cut", async ({ page }) => {
      await open(page, "?tab=conflicts");
      const claims = page.getByTestId("claim");
      await expect(claims.first()).toBeVisible();
      const words = claims.locator("td").first().locator(":scope > span > span:first-child");
      const n = await words.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const cut = await words.nth(i).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(cut, `claim ${i}: ${await words.nth(i).innerText()}`).toBe(false);
      }
      await expect(claims.filter({ hasText: "In progress" }).first()).toBeVisible();
      await page.getByTestId("conflict").first().scrollIntoViewIfNeeded();
      await shot(page, `gt4-conflicts-${tag}`);
    });
  });
}
