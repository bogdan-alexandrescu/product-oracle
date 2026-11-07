import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Visual QA of Simple's One-pagers, driven through the UI as an owner, an approver and a
 * commenter at 1024, 1440 and 390, light and dark.
 *
 * Card one-pager-tabs-qa: protects = R-1, the "On one page" section tabs on a PRD's one-pager
 * never run past their column (no tab is wider than its box or cut mid-word, no row scrolls
 * sideways); R-8, the One-pagers list carries no explanation sentence on the page: it sits
 * behind an (i) worded for the role (only an owner is told they can start a review), and a
 * commenter's disabled start-review button says why in its title;
 * fails_when = a tab is cut at the row's edge, the row has a hidden overflow, the list prints
 * its sentence, or a commenter's (i) offers a review; no_claim = the tabs' links (the other
 * one-pager specs).
 */

const WHO = [
  ["owner", undefined],
  ["approver", "approver@example.com"],
  ["commenter", "commenter@example.com"],
] as const;
const SIZES = [
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];

/** Every shown tab of the contents row, whole inside its box, and the row itself not scrolling sideways. */
async function expectTabsWhole(page: Page) {
  const nav = page.locator('nav[aria-label="Contents"]');
  await expect(nav).toHaveCount(1);
  if (!(await nav.isVisible())) return; // a phone shows no contents row
  const tabs = nav.locator("a");
  expect(await tabs.count()).toBeGreaterThan(5);
  const bad = await nav.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const out: string[] = [];
    if (el.scrollWidth > el.clientWidth + 1) out.push(`row scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    for (const a of Array.from(el.querySelectorAll("a"))) {
      const r = a.getBoundingClientRect();
      const name = (a.textContent ?? "").trim();
      if (a.scrollWidth > a.clientWidth + 1) out.push(`${name}: wider than its box`);
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${name}: past the row's edge (${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(box.left)}-${Math.round(box.right)})`);
      if (getComputedStyle(a).textOverflow === "ellipsis") out.push(`${name}: cut with an ellipsis`);
    }
    return out;
  });
  expect(bad).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  for (const size of SIZES) {
    test.describe(`${size.name} · ${scheme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme });

      for (const [who, email] of WHO) {
        test(`${who}: the one-pager's section tabs are never cut`, async ({ page }) => {
          await login(page, email);
          await page.goto("/simple/one-pagers/usage-alerts");
          await expect(page.getByTestId("one-pager")).toBeVisible();
          await expectTabsWhole(page);
        });

        test(`${who}: the One-pagers list keeps its sentence behind an (i), worded for the role`, async ({ page }) => {
          await login(page, email);
          await page.goto("/simple/one-pagers");
          await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
          await expect(page.getByText(/Open a PRD to read it on one page/).filter({ visible: true })).toHaveCount(0);
          const tip = page.getByRole("button", { name: "About One-pagers" });
          await tip.focus();
          const words = page.getByRole("tooltip").filter({ hasText: "Open a PRD to read it on one page" });
          await expect(words).toBeVisible();
          if (who === "owner") await expect(words).toHaveText("Open a PRD to read it on one page, change its wording or start a review.");
          else {
            await expect(words).toHaveText("Open a PRD to read it on one page or change its wording.");
            await expect(words).not.toContainText("start a review");
          }
        });
      }
    });
  }
}

test("a commenter's disabled start-review button says why in its title", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/simple/one-pagers/usage-alerts");
  const start = page.getByRole("button", { name: "Start a review meeting" });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute("title", /^Ask .*owner to start a review$/);
});
