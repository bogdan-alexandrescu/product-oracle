import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 1, docs lane: a roadmap version's Items tab (Usage alerts roadmap v1: Behaviour in
// Now, Success metrics in Next; its date Dec 15, 2026 lost its basis, so Approve is blocked)
// and a PRD draft's Roadmap tab.

const ITEMS = "/documents/usage-alerts-roadmap/v/1/items";

const visible = (page: Page, testId: string) =>
  page.getByTestId(testId).filter({ visible: true });
const table = (page: Page) => visible(page, "roadmap-items-table");
const row = (page: Page, key: string) =>
  page
    .locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`)
    .filter({ visible: true });

/** WCAG contrast of an element's text on its own background. */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const rgb = (c: string) =>
      (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const style = getComputedStyle(node);
    const a = lum(rgb(style.color));
    const b = lum(rgb(style.backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-docs-7: the selected 'Previous version' segment is readable (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await login(page);
      await page.goto(ITEMS);
      const seg = visible(page, "compare-previous");
      await expect(seg).toHaveAttribute("aria-pressed", "true");
      await expect(seg).toBeDisabled();
      expect(await contrast(seg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("qa-docs-34: a readable date in plain words, full column names, no empty State column", async ({
    page,
  }) => {
    await login(page);
    await page.goto(ITEMS);
    const blocked = visible(page, "approve-blocked");
    await expect(blocked).toContainText(
      "1 date is not backed by a confirmed schedule: Dec 15, 2026",
    );
    await expect(blocked).not.toContainText("2026-12-15");
    await expect(blocked).not.toContainText("rests on");
    const headers = table(page).locator("thead th");
    await expect(headers.filter({ hasText: /^Confidence$/ })).toHaveCount(1);
    await expect(headers.filter({ hasText: /^Conf\.$/ })).toHaveCount(0);
    // No item is stale or under review here: no State column.
    await expect(headers.filter({ hasText: /^State$/ })).toHaveCount(0);
  });

  test("qa-docs-34: the State column shows when an item may be stale", async ({
    page,
  }) => {
    await page.addInitScript(
      (key) => localStorage.setItem(key, "roadmap-items"),
      MOCK_SCENARIO_KEY,
    );
    await login(page);
    await page.goto(ITEMS);
    await expect(
      table(page)
        .locator("thead th")
        .filter({ hasText: /^State$/ }),
    ).toHaveCount(1);
    await expect(row(page, "item-metrics")).toContainText("May be stale");
  });

  test("qa-docs-61: the PRD section name is whole; Discuss sits level with the blocked Approve", async ({
    page,
  }) => {
    await login(page);
    await page.goto(ITEMS);
    const link = row(page, "item-metrics").getByRole("link", {
      name: /Success metrics/,
    });
    await expect(link).toBeVisible();
    const cell = link.locator("xpath=ancestor::td[1]");
    expect(
      await cell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    const discuss = visible(page, "doc-discuss");
    const approve = visible(page, "approve-blocked").getByRole("button", {
      name: "Approve version",
    });
    const [d, a] = await Promise.all([
      discuss.boundingBox(),
      approve.boundingBox(),
    ]);
    expect(Math.abs(d!.y - a!.y)).toBeLessThanOrEqual(2);
  });

  test("qa-docs-33: the draft roadmap's actions are in plain words", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/documents/checkout-redesign/v/2/roadmap");
    const status = visible(page, "draft-roadmap-status");
    await expect(status).toHaveAttribute("data-status", "ready");
    await expect(
      status.getByRole("button", { name: "Build again" }),
    ).toBeVisible();
    await expect(status).toContainText(/· built /);
    await expect(
      visible(page, "draft-roadmap-auto").getByRole("checkbox", {
        name: "Refresh this roadmap whenever a new PRD version is drafted",
      }),
    ).toBeVisible();
    await expect(visible(page, "draft-roadmap")).not.toContainText(/Derive/);

    await page.goto("/documents/usage-alerts/v/1/roadmap");
    await expect(
      visible(page, "draft-roadmap-status").getByRole("button", {
        name: "Build draft roadmap now",
      }),
    ).toBeVisible();
    await expect(visible(page, "draft-roadmap")).not.toContainText(/Derive/);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-62: 'Now 1' with a space; Discuss and the PRD link are there on a phone", async ({
    page,
  }) => {
    await login(page);
    await page.goto(ITEMS);
    const now = visible(page, "roadmap-group")
      .filter({ hasText: "Now" })
      .first();
    await expect(now).toHaveText("Now 1");
    // The count sits apart from the name (a flex header dropped the space).
    const gap = await now.locator("th > span").evaluate((wrap) => {
      const range = document.createRange();
      const label = wrap.firstChild!;
      range.selectNodeContents(label);
      const name = range.getBoundingClientRect();
      const count = wrap.querySelector("span")!.getBoundingClientRect();
      return count.left - name.right;
    });
    expect(gap).toBeGreaterThanOrEqual(4);
    await expect(
      row(page, "item-metrics").getByRole("link", { name: /Success metrics/ }),
    ).toBeVisible();
    await expect(visible(page, "doc-discuss")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
