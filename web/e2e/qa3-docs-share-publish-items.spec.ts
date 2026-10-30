import { expect, test, type Locator, type Page } from "./test";

import { login, sectionStrip } from "./helpers";

// QA pass 3, docs lane: the Publish page (Saved carts v2: a PRD with a brief, no section
// reviewed; Visit reminders v1: ready to publish), the version page's review counts (Saved
// carts v2, the early shipping cost technical brief v1) and the Usage alerts roadmap v1 Items
// tab (default scenario: Behaviour's text writes GA Dec 15, 2026, whose schedule basis ENG-413
// was withdrawn, so Approve version is blocked; v1 has no earlier version).

const CARTS = "saved-carts";
const CARTS_V2 = "/documents/saved-carts/v/2";
const TECH_BRIEF_V1 = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";
const ITEMS = "/documents/usage-alerts-roadmap/v/1/items";

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const rows = (page: Page) => visible(page, "roadmap-item-row");
const attention = (page: Page) =>
  visible(page, "items-filter").getByRole("button", { name: /^Needs attention/ });

async function openPublish(page: Page, slug: string) {
  await login(page);
  await page.goto(`/documents/${slug}/publish`);
  await expect(page.getByTestId("publish-readiness")).toBeVisible();
  await expect(page.getByTestId("hard-check").first()).toBeVisible();
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b, "element has a box").not.toBeNull();
  return b!;
}

/** WCAG contrast of an element's text on the first opaque background behind it. */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = rgb(getComputedStyle(node).color);
    let bg = [255, 255, 255];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

/** "N of M" from the outline's progress line, "N/M" from the Review panel's Reviewed stat. */
async function counts(page: Page) {
  const outline = await sectionStrip(page).getByTestId("review-progress").innerText();
  const stat = await page.getByTestId("review-panel").filter({ visible: true }).getByTestId("stat-reviewed").innerText();
  const o = outline.match(/(\d+) of (\d+)/);
  const s = stat.match(/(\d+)\s*\/\s*(\d+)/);
  expect(o, outline).not.toBeNull();
  expect(s, stat).not.toBeNull();
  return { outline: [o![1], o![2]], stat: [s![1], s![2]], outlineText: outline, statText: stat };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("qa-docs-4: the headline, the Section review row and the dialog give one review count, apart from the checks", async ({
      page,
    }) => {
      await openPublish(page, CARTS);
      const headline = page.getByTestId("publish-ready");
      await expect(headline).toHaveText(/^Publishable, but (\d+) of (\d+) sections are not reviewed/);
      const [, unreviewed, total] = (await headline.innerText()).match(/(\d+) of (\d+) sections/)!;
      // The checklist shows the section review as its own row, by the same numbers.
      const review = page.getByRole("region", { name: "Section review" });
      await expect(review).toBeVisible();
      await expect(review.getByTestId("review-count")).toHaveText(`${Number(total) - Number(unreviewed)} of ${total}`);
      await expect(review).toContainText("not checks");
      await page.getByTestId("publish-button").click();
      const dialog = page.getByRole("dialog", { name: "Publish v2?" });
      await expect(dialog.getByTestId("unreviewed-sections")).toHaveText(`${unreviewed} of ${total} sections are not reviewed`);
    });

    test("qa-docs-61: every status pill sits at the row's right end, hard checks as advisory ones", async ({ page }) => {
      await openPublish(page, CARTS);
      const advisoryChip = page.getByTestId("advisory").last().locator("[data-kind]").last();
      const right = (await box(advisoryChip)).x + (await box(advisoryChip)).width;
      const hard = page.getByTestId("hard-status");
      const n = await hard.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const chip = hard.nth(i).locator("[data-kind]");
        const b = await box(chip);
        expect(Math.abs(b.x + b.width - right), `hard check ${i + 1}`).toBeLessThanOrEqual(2);
      }
    });

    test("qa-docs-62: after publishing, 'Published v1' is said once and the side panel speaks in the past", async ({ page }) => {
      await openPublish(page, "visit-reminders");
      await page.getByTestId("publish-button").click();
      await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
      await expect(page.getByTestId("publish-ready")).toHaveText(/^Published on [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
      await expect(page.getByText(/Published v1/)).toHaveCount(1);
      if (viewport.name === "desktop") {
        const side = page.getByTestId("publish-inspector");
        await expect(side).toContainText("When it was published");
        await expect(side).not.toContainText("On publish");
      }
    });

    test("qa-docs-66: the blocked Approve says it in plain words with a fix; v1 says it has no earlier version", async ({
      page,
    }) => {
      await login(page);
      await page.goto(ITEMS);
      const blocked = visible(page, "approve-blocked");
      await expect(blocked).toContainText("Dec 15, 2026 (its schedule was withdrawn)");
      await expect(blocked).toContainText("Confirm a schedule for it, or take it out in a new draft.");
      await expect(blocked).not.toContainText(/record a basis|import a draft|\(date withdrawn\)/i);
      await expect(blocked.getByRole("link", { name: "Open Plan › Dates" })).toHaveAttribute("href", "/plan/dates");
      // Nothing to compare v1 with: no selected, disabled "Previous version".
      await expect(visible(page, "compare-none")).toHaveText("No earlier version");
      await expect(page.getByTestId("compare-previous")).toHaveCount(0);
      await expect(rows(page).first()).toBeVisible();
      if (viewport.name === "phone") {
        // Aligned: the header's actions and the reason start where the page's content does.
        const left = (await box(visible(page, "items-summary"))).x;
        const discuss = visible(page, "doc-discuss");
        expect(Math.abs((await box(discuss)).x - left)).toBeLessThanOrEqual(2);
        const reason = page.locator("#approve-blocked-reason").filter({ visible: true });
        expect(Math.abs((await box(reason)).x - left)).toBeLessThanOrEqual(2);
        // Labelled fields: each row's milestone says it is the milestone, "—" included.
        const n = await rows(page).count();
        for (let i = 0; i < n; i++) {
          const milestone = rows(page).nth(i).locator('td[data-phone="meta"]').first();
          expect(await milestone.innerText()).toMatch(/^Milestone/);
        }
      }
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const url of [CARTS_V2, TECH_BRIEF_V1]) {
    test(`qa-docs-5: the outline and the Review panel count the same sections (${url})`, async ({ page }) => {
      await login(page);
      await page.goto(url);
      await expect(sectionStrip(page).getByTestId("review-progress")).toBeVisible();
      await expect(page.getByTestId("review-panel").filter({ visible: true }).getByTestId("stat-reviewed")).toBeVisible();
      const c = await counts(page);
      expect(c.stat, `${c.statText} vs ${c.outlineText}`).toEqual(c.outline);
      // Each says what it counts.
      if (c.outlineText.includes("brief sections")) expect(c.statText).toContain("brief sections");
    });
  }

  test("qa-docs-6: the item with the unconfirmed date is flagged in the table and counted under Needs attention", async ({
    page,
  }) => {
    await login(page);
    await page.goto(ITEMS);
    await expect(visible(page, "approve-blocked")).toContainText("Dec 15, 2026");
    const flagged = visible(page, "unbacked-date");
    await expect(flagged).toHaveCount(1);
    await expect(flagged).toContainText("Dec 15, 2026");
    await expect(flagged).toContainText("Unconfirmed");
    await expect(flagged).not.toContainText("2026-12-15");
    await expect(attention(page)).toHaveText("Needs attention1");
    await attention(page).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().getByTestId("unbacked-date")).toBeVisible();
    // The fix sits next to the warning.
    await expect(visible(page, "approve-blocked").getByTestId("approve-blocked-fix")).toHaveAttribute("href", "/plan/dates");
  });

  test("qa-docs-6: the Unconfirmed flag reads in dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page);
    await page.goto(ITEMS);
    const chip = visible(page, "unbacked-date").locator("[data-kind]");
    await expect(chip).toHaveText("Unconfirmed");
    expect(await contrast(chip)).toBeGreaterThanOrEqual(4.5);
  });

  test("qa-docs-7: Discuss sits beside Approve version, with the header's other actions", async ({ page }) => {
    await login(page);
    await page.goto(ITEMS);
    const discuss = await box(visible(page, "doc-discuss"));
    const approve = await box(visible(page, "approve-blocked").getByRole("button", { name: "Approve version" }));
    expect(Math.abs(discuss.y - approve.y)).toBeLessThanOrEqual(2);
    // Next to it (the header's 8 px gap), not floating mid-header.
    const gap = approve.x - (discuss.x + discuss.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);
    // The group is on the right of the header.
    const header = await box(page.getByTestId("doc-header"));
    expect(header.x + header.width - (approve.x + approve.width)).toBeLessThanOrEqual(4);
  });
});
