import { expect, test, type Locator, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * At phone width (390) a DataTable row is a stacked block: its title on line 1, never
 * truncated, the key meta under it, the action beside it. Cost stays visible on cost
 * approvals and overruns (P3d) on every size.
 */
test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ timeout: 60_000 });

/** Texts of elements under `root` that cut their own content off sideways (ellipsis or clip). */
async function clippedTexts(root: Locator): Promise<string[]> {
  return root.evaluate((el) =>
    [el, ...el.querySelectorAll<HTMLElement>("*")]
      .filter((e) => {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || e.closest("[role=tooltip]")) return false;
        // Screen-reader-only text is clipped on purpose.
        if (e.closest(".sr-only") || e.clientWidth <= 1) return false;
        return cs.overflowX !== "visible" && e.scrollWidth > e.clientWidth + 1;
      })
      .map((e) => (e.textContent ?? "").trim()),
  );
}

async function expectInViewport(page: Page, loc: Locator) {
  const box = await loc.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
}

async function expectNoSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("phone inbox: each row shows its item, kind and context, its action, and cost on approvals and overruns", async ({
  page,
}) => {
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-approvals")).toBeVisible();

  for (const id of ["inbox-checkpoints", "inbox-approvals", "inbox-overruns", "inbox-feedback"]) {
    const rows = page.getByTestId(id).locator("tr[data-row]");
    for (const row of await rows.all()) {
      const title = row.locator('td[data-phone="title"]');
      await expect(title).toBeVisible();
      expect((await title.innerText()).trim().length).toBeGreaterThan(3);
      expect(await clippedTexts(row)).toEqual([]);
      await expectInViewport(page, title);
      // The kind and context are meta under the title, not hidden.
      await expect(row.locator('td[data-phone="meta"]').first()).toBeVisible();
      await expect(row.locator('td[data-phone="action"]').getByRole("button").or(row.getByRole("link")).first()).toBeVisible();
    }
  }

  const approval = page.getByTestId("inbox-approvals").locator("tr[data-row]").first();
  await expect(approval.locator('[data-cost="prominent"]')).toBeVisible();
  await expect(approval).toContainText("Cost approval");
  await expect(approval).toContainText("usage-alerts-v2");
  await expect(approval.getByRole("button", { name: /^Approve \$/ })).toBeVisible();

  const overrun = page.getByTestId("inbox-overruns").locator("tr[data-row]").first();
  await expect(overrun.locator('[data-cost="prominent"]')).toBeVisible();
  await expect(overrun.getByRole("button", { name: "Resume" })).toBeVisible();
  await expectNoSideScroll(page);
});

test("phone runs: run names are whole, costs show on approvals and overruns, the action stays", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  const rows = page.getByTestId("run-row");
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) {
    expect(await clippedTexts(row)).toEqual([]);
    await expectInViewport(page, row.locator('td[data-phone="title"]'));
  }
  const approval = rows.filter({ hasText: "Awaiting cost approval" });
  await expect(approval.locator('td[data-phone="title"]')).toHaveText("usage-alerts-v2");
  await expect(approval.locator('[data-cost="prominent"]')).toBeVisible();
  await expect(approval.getByRole("button", { name: "Approve" })).toBeVisible();
  const overrun = rows.filter({ hasText: "Paused" });
  await expect(overrun.locator('[data-cost="prominent"]')).toBeVisible();
  await expectNoSideScroll(page);

  // Keyboard selection works the same on the stacked rows.
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(1)).toBeFocused();
});

test("phone run detail: the status chips sit under the phone header, clear of the primary action", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "Awaiting cost approval" }).getByRole("link").click();
  const action = page.getByRole("button", { name: /^Approve \$[\d.]+ and start$/ });
  await expect(action).toBeVisible();
  const chip = page.locator("header[data-page-header]").getByText("Awaiting cost approval", { exact: true });
  await expect(chip).toBeVisible();
  // The phone header draws the title (I3), so the chips come right under it.
  const [a, c, h] = await Promise.all([action.boundingBox(), chip.boundingBox(), page.getByTestId("phone-header").boundingBox()]);
  expect(overlaps(a!, c!)).toBe(false);
  expect(c!.y).toBeGreaterThanOrEqual(h!.y + h!.height - 1);
  await expectInViewport(page, action);
  await expectNoSideScroll(page);
});

test("phone baseline: the feature × goal ledger is a list of whole feature names with their goal tags", async ({ page }) => {
  await login(page);
  await page.goto("/baseline");
  const feature = page.getByTestId("feature-f.guided-setup");
  await expect(feature).toBeVisible();
  await expect(feature.getByRole("button", { name: "Guided setup" })).toBeVisible();
  // Its two goal links as G-tags with their strength.
  await expect(feature.getByText("G1", { exact: true })).toBeVisible();
  await expect(feature.getByText("G2", { exact: true })).toBeVisible();
  await expect(feature.getByRole("img", { name: /^Contribution \d of 3/ })).toHaveCount(2);
  // A flagged feature shows its flag as on desktop, not an unexplained dot.
  await expect(page.getByTestId("feature-f.dark-mode").getByText("Serves no goal")).toBeVisible();
  await expect(page.getByTestId("feature-f.saved-carts").getByText("Low confidence")).toBeVisible();
  for (const row of await page.locator('[data-testid^="feature-f."]').all()) {
    expect(await clippedTexts(row)).toEqual([]);
    await expectInViewport(page, row);
  }
  await expectNoSideScroll(page);
});

test("phone design kit: every DataTable sample keeps its titles whole", async ({ page }) => {
  await login(page);
  await page.goto("/design");
  await expect(page.getByTestId("design-gallery")).toBeVisible({ timeout: 20_000 });
  const rows = page.getByTestId("design-table").locator("tr[data-row]");
  for (const row of await rows.all()) {
    const title = row.locator('td[data-phone="title"]');
    expect(await clippedTexts(title)).toEqual([]);
  }
  // Clicking a stacked row still selects it.
  await rows.nth(2).click();
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
});

test("phone row actions: every row action a table has on desktop stays on the phone", async ({ page }) => {
  await login(page);
  for (const path of [
    "/roadmap",
    "/runs",
    "/inbox",
    "/documents",
    "/documents/checkout-redesign",
    "/baseline",
    "/priorities",
    "/settings/members",
    "/settings/claude-accounts",
    "/settings/templates",
    "/settings/themes",
  ]) {
    await page.goto(path);
    const rows = page.locator("tr[data-row]").filter({ visible: true });
    await expect(rows.first()).toBeVisible();
    // No column a phone hides holds a button (a row's action).
    expect(await page.locator('td[data-phone="hide"] button').count(), path).toBe(0);
    for (const row of await rows.all()) {
      for (const button of await row.getByRole("button").all()) {
        await expect(button, path).toBeVisible();
        await expectInViewport(page, button);
      }
    }
    await expectNoSideScroll(page);
  }

  // Roadmap: the approved PRD keeps Build roadmap beside its title.
  await page.goto("/roadmap");
  const prd = page.getByTestId("approved-prd");
  const build = prd.getByRole("button", { name: "Build roadmap" });
  await expect(build).toBeVisible();
  const [t, b] = await Promise.all([prd.locator('td[data-phone="title"]').boundingBox(), build.boundingBox()]);
  expect(b!.y).toBeLessThan(t!.y + t!.height);
});

test("phone sources: each source's actions stay on one line", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const cards = page.getByTestId("source-card");
  // Slack, GitHub, the Slack source needing attention, the Fireflies title rule and the
  // two Google Docs sources.
  await expect(cards).toHaveCount(6);
  for (const card of await cards.all()) {
    const tops = new Set<number>();
    for (const button of await card.locator("div").first().getByRole("button").all()) {
      tops.add(Math.round((await button.boundingBox())!.y));
    }
    expect(tops.size).toBe(1);
  }
  await expectNoSideScroll(page);
});

test("phone settings: the current tab is in full view, clear of the fades and chevrons", async ({ page }) => {
  await login(page);
  for (const [path, tab] of [
    ["/settings/members", "nav-members"],
    ["/settings/connections", "nav-connections"],
    ["/settings/claude-accounts", "nav-claude-accounts"],
    ["/settings/sources", "nav-sources"],
    ["/settings/templates", "nav-templates"],
    ["/settings/themes", "nav-themes"],
    ["/settings/templates/oracle-default", "nav-templates"],
    ["/settings/themes/clean-document", "nav-themes"],
  ]) {
    await page.goto(path);
    const nav = page.getByRole("navigation", { name: "Settings" }).filter({ visible: true });
    const current = nav.getByTestId(tab);
    await expect(current).toHaveAttribute("aria-current", "page");
    // Let the strip settle (it measures, shows its chevrons, then brings the tab into view).
    await page.waitForTimeout(300);
    const strip = current.locator("xpath=..");
    const [box, item, more] = await Promise.all([
      strip.boundingBox(),
      current.boundingBox(),
      strip.evaluate((el) => ({ left: el.hasAttribute("data-more-left"), right: el.hasAttribute("data-more-right") })),
    ]);
    const fade = 32;
    expect(item!.x, path).toBeGreaterThanOrEqual(box!.x + (more.left ? fade : 0) - 0.5);
    expect(item!.x + item!.width, path).toBeLessThanOrEqual(box!.x + box!.width - (more.right ? fade : 0) + 0.5);
    // Nor under a chevron button.
    for (const chevron of await nav.locator('[data-testid^="strip-more-"]').all()) {
      const c = (await chevron.boundingBox())!;
      expect(overlaps(c, item!), path).toBe(false);
    }
  }
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1366, height: 820 } });

  test("DataTable rows stay one line on desktop", async ({ page }) => {
    await login(page);
    await page.goto("/runs");
    const row = page.getByTestId("run-row").first();
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(48);
  });

  test("settings: the tabs sit under the title; /sources lives under Settings › Sources", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const heading = page.getByRole("heading", { level: 1, name: "Members" });
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(heading).toBeVisible();
    await expect(nav).toBeVisible();
    const h1 = await heading.boundingBox();
    const tabs = await nav.boundingBox();
    expect(tabs!.y).toBeGreaterThanOrEqual(h1!.y + h1!.height - 1);

    await page.goto("/sources");
    await expect(nav.getByTestId("nav-sources")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
