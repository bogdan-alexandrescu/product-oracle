import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * QA pass 4, simple-plan (/simple/priorities): the Ranked list, Compare with Oracle, Value /
 * effort, Goal buckets, the line picker and the suggestions drawer, driven through the UI as a
 * person would on the mock's invented company. Desktop 1440x900 and phone 390x844.
 */

const PHONE = { width: 390, height: 844 };

async function setUp(page: Page, opts: { scheme?: "light" | "dark"; email?: string; phone?: boolean } = {}) {
  const { scheme = "light", email = ADMIN.email, phone = false } = opts;
  await page.setViewportSize(phone ? PHONE : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, themeKey, theme]) => {
      localStorage.removeItem(key);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

const rowByTitle = (page: Page, title: string): Locator => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title, { exact: true }) });
const lineSelect = (page: Page) => page.getByLabel("Line", { exact: true });

async function dragRow(page: Page, name: string, to: number): Promise<void> {
  const handle = page.getByRole("button", { name: `Drag ${name} to reorder` });
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const from = (await handle.boundingBox())!;
  const target = (await page.getByTestId("prio-row").nth(to).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2 + 2, { steps: 10 });
  await page.mouse.up();
}

/** Moves Setup checklist from #1 down to #3 with a reason, as the owner. */
async function moveSetupDown(page: Page): Promise<void> {
  await dragRow(page, "Setup checklist (SC)", 2);
  const dialog = page.getByRole("dialog", { name: /Why move Setup checklist/ });
  await dialog.getByLabel(/Reason/).fill("Rules first");
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowByTitle(page, "Setup checklist").getByTestId("prio-ghost")).toBeVisible();
}

test.describe("QA pass 4: simple-plan, phone", () => {
  /* qa4-simple-plan-1, -28: the own-milestone chip wraps (no sideways scroll); the line's label stays one line. */
  test("a milestone line keeps the page phone-wide and the line one line", async ({ page }) => {
    await setUp(page, { phone: true });
    await open(page);
    const label = (await page.locator("#prio-line option").allTextContents()).find((o) => o.startsWith("Milestone: Beta"))!;
    await lineSelect(page).selectOption({ label });
    await expect(page.locator('[data-testid="prio-misses"][data-own="true"]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const divider = page.getByTestId("line-divider");
    await expect(divider).toHaveCount(1);
    expect((await divider.boundingBox())!.height).toBeLessThan(44);
    await expect(divider).toContainText("everything below misses it");
  });

  /* qa4-simple-plan-9: no mark sits on a quadrant's name or a middle line's words. */
  test("value / effort's marks keep clear of the chart's labels", async ({ page }) => {
    await setUp(page, { phone: true });
    await open(page, "?tab=value-effort");
    await expect(page.getByTestId("vxe-point").first()).toBeVisible();
    await page.waitForTimeout(300);
    const hits = await page.evaluate(() => {
      const marks = [...document.querySelectorAll('[data-testid="vxe-point"]')].map((e) => ({ code: (e as HTMLElement).dataset.code, b: e.getBoundingClientRect() }));
      const labels = [...document.querySelectorAll('[data-testid="vxe-quadrant"], [data-testid="vxe-middle-effort"], [data-testid="vxe-middle-value"]')].map((e) => ({ t: e.textContent, b: e.getBoundingClientRect() }));
      return labels.flatMap((l) => marks.filter((m) => l.b.left < m.b.right && m.b.left < l.b.right && l.b.top < m.b.bottom && m.b.top < l.b.bottom).map((m) => `${l.t} × ${m.code}`));
    });
    expect(hits).toEqual([]);
  });
});

test.describe("QA pass 4: simple-plan, desktop", () => {
  /* qa4-simple-plan-6, -22, -24, -25: compare cards share one layout; the pushed rows say why; one "No goal" chip; ghost chips in their own slot. */
  test("compare with Oracle lays every card out alike and says who pushed a row", async ({ page }) => {
    await setUp(page);
    await open(page);
    await moveSetupDown(page);
    // Every row keeps its details on its title's line; Oracle's rank sits under the row.
    for (const r of await page.getByTestId("prio-row").all()) {
      const t = (await r.getByTestId("prio-title").boundingBox())!;
      const d = (await r.getByTestId("prio-details").boundingBox())!;
      expect(Math.abs(t.y + t.height / 2 - (d.y + d.height / 2))).toBeLessThan(14);
    }
    await expect(rowByTitle(page, "Setup checklist").getByTestId("prio-marks").getByTestId("prio-ghost")).toHaveText("Oracle #1");

    await page.getByRole("switch", { name: "Compare with Oracle" }).click();
    const yours = page.getByRole("region", { name: "Your order" });
    const lefts: number[] = [];
    for (const r of await yours.getByTestId("prio-row").all()) {
      const t = (await r.getByTestId("prio-title").boundingBox())!;
      const d = (await r.getByTestId("prio-details").boundingBox())!;
      expect(d.y).toBeGreaterThanOrEqual(t.y + t.height - 2);
      lefts.push(Math.round(d.x));
    }
    expect(new Set(lefts).size).toBe(1);
    // A row nobody moved says which move pushed it.
    const pushed = page.locator('[data-testid="oracle-row"][data-differs="true"]').filter({ hasNotText: "Rules first" }).first();
    await expect(pushed.getByTestId("oracle-why")).toContainText("pulled up when Setup checklist moved down");
    await expect(pushed.getByTestId("oracle-why")).not.toContainText("other people's moves");
    // "No goal" is the same chip in both columns.
    const chip = async (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
    const mine = yours.getByTestId("prio-goal").getByText("No goal", { exact: true }).first();
    const oracle = page.getByRole("region", { name: "Oracle's order" }).getByTestId("oracle-goal").getByText("No goal", { exact: true }).first();
    expect(await chip(oracle)).toBe(await chip(mine));
  });

  /* qa4-simple-plan-8: the side list marks a row a dependency holds back and a row a person moved. */
  test("value / effort's side list says why a score is out of order", async ({ page }) => {
    await setUp(page);
    await open(page);
    await moveSetupDown(page);
    await page.getByRole("tab", { name: "Value / effort" }).click();
    const rows = page.getByTestId("side-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: "Setup checklist" }).getByTestId("side-ghost")).toHaveText("Oracle #1");
    // Every score that is higher than the one above it says why: held by a need, or moved.
    const read = await rows.evaluateAll((els) =>
      els.map((e) => ({
        score: Number(e.querySelector('[title="Score"]')?.textContent),
        why: !!e.querySelector('[data-testid="side-held"], [data-testid="side-ghost"]'),
      })),
    );
    const unexplained = read.filter((r, i) => i > 0 && !Number.isNaN(r.score) && !Number.isNaN(read[i - 1].score) && r.score > read[i - 1].score && !r.why && !read[i - 1].why);
    expect(unexplained).toEqual([]);
    await expect(page.getByTestId("side-held").first()).toContainText("after");
  });

  /* qa4-simple-plan-30: in dark, both help paragraphs under the legend read in one colour. */
  test("value / effort's two help paragraphs share a colour in dark", async ({ page }) => {
    await setUp(page, { scheme: "dark" });
    await open(page, "?tab=value-effort");
    const legend = page.getByLabel("Legend");
    const help = legend.locator("xpath=following-sibling::p[1]");
    await expect(help).toContainText("Drag a mark sideways");
    const colour = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);
    expect(await colour(help)).toBe(await colour(legend.locator("li").last()));
  });

  /* qa4-simple-plan-33: a day already gone is refused, in words. */
  test("the line refuses a date that has passed", async ({ page }) => {
    await setUp(page);
    await open(page);
    await lineSelect(page).selectOption({ label: "Pick a date…" });
    await page.getByLabel("The line's date").fill("2025-01-01");
    await expect(page.getByTestId("line-day-past")).toHaveText("That date has passed: pick today or later.");
    await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    await page.getByLabel("The line's date").press("Enter");
    await expect(page.getByTestId("line-caption")).toContainText("this quarter");
    await expect(page.locator("#prio-line option")).not.toContainText(["Date: Jan 1, 2025"]);
  });

  /* qa4-simple-plan-29: each tab controls the panel, which is labelled by the tab shown. */
  test("the tabs control a labelled tab panel", async ({ page }) => {
    await setUp(page);
    await open(page);
    for (const name of ["Ranked list", "Value / effort", "Goal buckets"]) {
      const tab = page.getByRole("tab", { name });
      await tab.click();
      const panel = page.getByRole("tabpanel", { name });
      await expect(panel).toBeVisible();
      expect(await tab.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
    }
  });

  /* qa4-simple-plan-26: a commenter is told who can move a locked row and what to do. */
  test("a commenter reads who can move a locked row", async ({ page }) => {
    await setUp(page, { email: "commenter@example.com" });
    await open(page);
    await expect(rowByTitle(page, "New plan tiers").getByTestId("prio-locked")).toHaveText("Only people with access to this feature's roadmap can move it. Ask the owner for access.");
  });

  /* qa4-simple-plan-2, -12, -17, -18, -20: buckets never deny the dates there are; codes as chips; the drawer's controls and links. */
  test("goal buckets and the suggestions drawer read as the rest of the page", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=buckets");
    await expect(page.getByTestId("buckets-intro")).not.toContainText("No dated plan yet");
    await expect(page.getByTestId("buckets-intro")).toContainText("milestones and key dates");
    const setup = page.getByTestId("bucket-features").locator("li").filter({ hasText: "Setup checklist" });
    await expect(setup.getByTestId("prio-code")).toHaveText("SC");

    const opener = page.getByRole("button", { name: /^See or make suggestions for Grow retention, \d+ waiting$/ });
    await expect(opener).toHaveText(/^See or make suggestions · \d+$/);
    await opener.click();
    const drawer = page.getByTestId("goal-panel");
    const flow = drawer.getByTestId("flow-open").first();
    await expect(flow).toBeVisible();
    await expect(flow).toHaveAttribute("data-variant", "ghost");
    const link = drawer.getByTestId("looks-like-link").first();
    await expect(link).toBeVisible();
    const colour = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);
    expect(await colour(link)).toBe(await colour(page.getByRole("link", { name: "Open the detailed view" })));
  });
});
