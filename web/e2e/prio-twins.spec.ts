import type { Locator, Page } from "@playwright/test";
import { COMPANY_TITLE, OLD_ROADMAP } from "../lib/api/mock/one-roadmap";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { OLD_TWIN, PRIORITIES_TWINS_OLD_SCENARIO, PRIORITIES_TWINS_SCENARIO, PRIORITIES_TWINS_TRACE_SCENARIO, TWINS } from "../lib/api/mock/simple-priorities";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * qa-prio-twins (a visual QA of Simple › Priorities): each feature appears once, in one place. On the
 * "priorities-twins" scenario (invented data, on "one-roadmap"), as the owner:
 * - Trusted seller badge, whose draft is on the company roadmap, never reads "Not on Product roadmap yet": its
 *   draft shows on its row (Confirm, Merge into…), not again under "Not ranked yet";
 * - a second Block list draft, linked to nothing, shows on Block list's one row, merged there with Merge into…;
 * - a second Queue backpressure item is one row with it, merged with Merge into…;
 * - a folded twin keeps its own rank and goal in the row, and its waiting merge shows there (no second Merge
 *   until it is decided); a merge of one name into the same name says by code which record was kept;
 * - a second, confirmed Trusted seller badge item (its own feature) merged into the row, whose only item is a
 *   draft, keeps its item: the draft goes into it and the row keeps its rank with that item, never "Not ranked yet";
 * - moving Trusted seller badge confirms its draft there (never a second item), also when the draft is linked only
 *   by its trace ("priorities-twins-trace");
 * - a twin whose only item is on an older roadmap ("priorities-twins-old") is merged with that item, which now serves
 *   the kept feature; an approver who does not decide that roadmap is told why it cannot be merged, with no Merge;
 * - the score's formula sits behind an (i) by the list's heading, never as a line of text;
 * - the Show filter's All counts every feature listed, Block list and Queue backpressure too (only proposed by
 *   Oracle, so with no mark yet).
 * Desktop 1440x900 and phone 390x844.
 */

async function setUp(page: Page, phone: boolean, role = "", scenario: string = PRIORITIES_TWINS_SCENARIO): Promise<void> {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey, roleKey, as]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
      if (as) localStorage.setItem(roleKey, as);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, MOCK_ROLE_KEY, role] as const,
  );
  await login(page);
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
}

const rowsNamed = (page: Page, title: string): Locator => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title, { exact: true }) });
const notRanked = (page: Page): Locator => page.getByRole("region", { name: "Not ranked yet" });

for (const phone of [false, true]) {
  test.describe(phone ? "390px" : "desktop", () => {
    test("a roadmap draft is on the roadmap, shown once on its feature's row", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.draft);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId("prio-adds")).toHaveCount(0);
      await expect(page.getByText(`Not on ${COMPANY_TITLE} yet`)).toHaveCount(0);
      const draft = row.getByTestId("prio-row-draft");
      await expect(draft).toHaveCount(1);
      await expect(draft.getByRole("button", { name: "Confirm" })).toBeVisible();
      await expect(draft.getByRole("button", { name: "Merge into…" })).toBeVisible();
      await expect(notRanked(page).getByText(TWINS.draft)).toHaveCount(0);
      // Every title once: never two rows, never a row and a draft of its own.
      const titles = await page.getByTestId("prio-title").allTextContents();
      expect(new Set(titles).size, titles.join(" | ")).toBe(titles.length);
      const drafts = await page.getByTestId("prio-draft").allTextContents();
      for (const t of titles) expect(drafts.some((d) => d.includes(t)), `${t} also under Not ranked yet`).toBe(false);
    });

    test("a draft with a row's name shows on that row and merges into it", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.unlinked);
      await expect(row).toHaveCount(1);
      await expect(notRanked(page).getByText(TWINS.unlinked, { exact: true })).toHaveCount(0);
      const draft = row.getByTestId("prio-row-draft");
      await expect(draft).toHaveCount(1);
      // Only named as the feature: no Confirm, only Merge into…, the row's own item picked.
      await expect(draft.getByRole("button", { name: "Confirm" })).toHaveCount(0);
      await draft.getByRole("button", { name: "Merge into…" }).click();
      await expect(draft.getByLabel("Merge into")).toHaveValue(/.+/);
      await expect(draft.getByLabel("Merge into").locator("option:checked")).toHaveText(TWINS.unlinked);
      await draft.getByRole("button", { name: "Merge", exact: true }).click();
      const code = await draft.getAttribute("data-code");
      const kept = await row.getAttribute("data-code");
      await expect(page.getByText(`Merged ${TWINS.unlinked} (${code}) into ${TWINS.unlinked} (${kept}), which is kept`)).toBeVisible();
      await expect(row.getByTestId("prio-row-draft")).toHaveCount(0);
      await expect(rowsNamed(page, TWINS.unlinked)).toHaveCount(1);
    });

    test("two records with one name are one row, merged with Merge into…", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.item);
      await expect(row).toHaveCount(1);
      const twin = row.getByTestId("prio-twin");
      await expect(twin).toHaveCount(1);
      // The folding by name shows: the twin's own rank and goal.
      await expect(twin.getByTestId("prio-twin-rank")).toHaveText(/^#\d+$/);
      await expect(twin.getByTestId("prio-twin-goal")).toBeVisible();
      const code = await twin.getAttribute("data-code");
      const kept = await row.getAttribute("data-code");
      await twin.getByRole("button", { name: "Merge into…" }).click();
      await twin.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(page.getByText(`Merged ${TWINS.item} (${code}) into ${TWINS.item} (${kept}), which is kept`)).toBeVisible();
      await expect(rowsNamed(page, TWINS.item).getByTestId("prio-twin")).toHaveCount(0);
      await expect(rowsNamed(page, TWINS.item)).toHaveCount(1);
    });

    test("a twin's waiting merge shows on the row, and no second merge is offered", async ({ page }) => {
      await setUp(page, phone, "commenter");
      const twin = rowsNamed(page, TWINS.item).getByTestId("prio-twin");
      await twin.getByRole("button", { name: "Propose a merge…" }).click();
      await twin.getByRole("button", { name: "Propose", exact: true }).click();
      await expect(twin.getByTestId("prio-proposal")).toHaveCount(1);
      await expect(twin.getByTestId("prio-proposal")).toContainText(/waiting for/);
      await expect(twin.getByRole("button", { name: "Propose a merge…" })).toBeDisabled();
      // Taken back, the merge is offered again.
      await twin.getByTestId("prio-proposal").getByRole("button", { name: "Withdraw" }).click();
      await expect(twin.getByTestId("prio-proposal")).toHaveCount(0);
      await expect(twin.getByRole("button", { name: "Propose a merge…" })).toBeEnabled();
    });

    test("a twin with its own item, merged into a row with only a draft, keeps that item on the row", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.draft);
      await expect(row.getByTestId("prio-row-draft")).toHaveCount(1);
      const twin = row.getByTestId("prio-twin");
      await expect(twin).toHaveAttribute("data-code", "trusted-badge-2");
      const rank = await row.getByTestId("prio-rank").textContent();
      const kept = await row.getAttribute("data-code");
      await twin.getByRole("button", { name: "Merge into…" }).click();
      await twin.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(page.getByText(`Merged ${TWINS.draft} (trusted-badge-2) into ${TWINS.draft} (${kept}), which is kept, and its roadmap item now serves it`)).toBeVisible();
      // One row, its rank kept, now with the confirmed item: no twin, no draft, nothing under Not ranked yet.
      const after = rowsNamed(page, TWINS.draft);
      await expect(after).toHaveCount(1);
      await expect(after.getByTestId("prio-twin")).toHaveCount(0);
      await expect(after.getByTestId("prio-row-draft")).toHaveCount(0);
      await expect(after).toHaveAttribute("data-code", "trusted-badge-2");
      await expect(after.getByTestId("prio-rank")).toHaveText(rank!);
      await expect(notRanked(page).getByText(TWINS.draft)).toHaveCount(0);
    });

    test("a twin whose only item is on an older roadmap is merged with that item", async ({ page }) => {
      await setUp(page, phone, "", PRIORITIES_TWINS_OLD_SCENARIO);
      const row = rowsNamed(page, TWINS.unlinked);
      const twin = row.getByTestId("prio-twin");
      await expect(twin).toHaveCount(1);
      await expect(twin.getByTestId("prio-twin-blocked")).toHaveCount(0);
      await twin.getByRole("button", { name: "Merge into…" }).click();
      await twin.getByRole("button", { name: "Merge", exact: true }).click();
      // Its item on the older roadmap is linked to the kept feature first, never left with none.
      await expect(page.getByText(/, and its roadmap item now serves it$/)).toBeVisible();
      await expect(rowsNamed(page, TWINS.unlinked)).toHaveCount(1);
      await expect(rowsNamed(page, TWINS.unlinked).getByTestId("prio-twin")).toHaveCount(0);
    });

    test("an approver who does not decide a twin's older roadmap is told why it cannot be merged", async ({ page }) => {
      await setUp(page, phone, "approver", PRIORITIES_TWINS_OLD_SCENARIO);
      const twin = rowsNamed(page, TWINS.unlinked).getByTestId("prio-twin");
      await expect(twin).toHaveCount(1);
      await expect(twin.getByTestId("prio-twin-blocked")).toHaveText(
        `Only the decider of ${OLD_ROADMAP[1]} links ${TWINS.unlinked} (${OLD_TWIN.key}) to another feature: ask them to merge it`,
      );
      await expect(twin.getByRole("button", { name: /Merge into…|Propose a merge…/ })).toHaveCount(0);
    });

    for (const [scenario, how] of [[PRIORITIES_TWINS_SCENARIO, ""], [PRIORITIES_TWINS_TRACE_SCENARIO, ", one linked by its trace too"]] as const) {
      test(`moving a feature whose only item is a draft confirms that draft${how}`, async ({ page }) => {
        await setUp(page, phone, "", scenario);
        const row = rowsNamed(page, TWINS.draft);
        await expect(row.getByTestId("prio-row-draft")).toHaveCount(1);
        const rows = await page.getByTestId("prio-row").count();
        await row.getByRole("button", { name: /^Drag .* to reorder$/ }).focus();
        await page.keyboard.press("ArrowUp");
        const dialog = page.getByRole("dialog", { name: /^Why move / });
        await dialog.getByLabel("Reason").fill("Sellers asked for it at the example.com meetup");
        await dialog.getByRole("button", { name: "Move", exact: true }).click();
        await expect(dialog).toBeHidden();
        // Confirmed: no draft on the row, none under Not ranked yet, one row.
        await expect(rowsNamed(page, TWINS.draft)).toHaveCount(1);
        await expect(rowsNamed(page, TWINS.draft).getByTestId("prio-row-draft")).toHaveCount(0);
        await expect(rowsNamed(page, TWINS.draft).getByTestId("prio-override")).toBeVisible();
        await expect(notRanked(page).getByText(TWINS.draft)).toHaveCount(0);
        // Never a second item: the same rows, the same one twin (the second, confirmed item).
        await expect(page.getByTestId("prio-row")).toHaveCount(rows);
        await expect(rowsNamed(page, TWINS.draft).getByTestId("prio-twin")).toHaveCount(1);
      });
    }

    test("the score's formula is behind an (i) by the list's heading", async ({ page }) => {
      await setUp(page, phone);
      await expect(page.getByText(/^Score = goal value/)).toBeHidden();
      await page.getByTestId("line-caption").getByTestId("prio-score-help").click();
      await expect(page.locator("#prio-score-text")).toHaveText("Score = goal value × Oracle's confidence in it (0 to 1) ÷ effort in engineer-weeks.");
    });

    test("the Show filter's All counts every feature listed, one with no mark yet too", async ({ page }) => {
      await setUp(page, phone);
      await expect(page.getByTestId("cs-legend")).toBeVisible();
      const n = await page.getByTestId("prio-row").count();
      await expect(page.getByTestId("cs-legend").getByRole("button", { name: /^All / })).toHaveText(`All ${n}`);
    });
  });
}
