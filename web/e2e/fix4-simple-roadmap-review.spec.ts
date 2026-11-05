import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * fix4-simple-roadmap review: the review's minors on the Simple roadmap, driven through the UI
 * on the mock's invented data. With an item's card open the rail still navigates (it does not
 * only close the card); a draft with no flow says why and where to confirm it; the phone
 * Timeline's bars name the items they carry; a phone's broken links keep their words whole in
 * the panel above the chart (Waterfall and Gantt).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, opts: { url?: string; theme?: "light" | "dark" } = {}) {
  const { url = "/simple/roadmap", theme = "light" } = opts;
  await page.context().addInitScript(
    ([key, themeKey, t]) => {
      localStorage.setItem(key, "default");
      localStorage.setItem(themeKey, t);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("SimpleShell: with an item's card open, a click on the rail goes to that page", async ({ page }) => {
    await open(page);
    await openRoadmapItem(page, "alert-rules");
    await expect(page.getByTestId("floating-card")).toBeVisible();
    // The rail is dimmed under the card's backdrop, and a click on one of its links still goes there.
    const link = (await page.getByTestId("simple-nav-priorities").boundingBox())!;
    await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2);
    await expect(page).toHaveURL(/\/simple\/priorities/);
  });

  // Re-pointed: the Gantt's card is Simple's one feature panel; its backdrop is feature-panel-backdrop.
  test("SimpleShell: a click on the backdrop away from the rail only closes the card", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    await page.locator('g[data-testid="bar"][data-item="alert-rules"]').click();
    await expect(page.getByTestId("floating-card")).toBeVisible();
    await expect(page.getByTestId("feature-panel-backdrop")).toBeVisible();
    await page.mouse.click(400, 880);
    await expect(page.getByTestId("floating-card")).toHaveCount(0);
    await expect(page).toHaveURL(/\/simple\/roadmap/);
  });

  test("qa-simple-roadmap-39: a draft with no flow says why and offers to confirm it in Priorities", async ({ page }) => {
    await open(page, { url: "/simple/roadmap?roadmap=onboarding-roadmap" });
    await openRoadmapItem(page, "setup-ideas");
    const card = page.getByTestId("floating-card");
    // build-feature-panel: the panel's status chip says it is a draft (was the old card's draft tag).
    await expect(card.getByTestId("fp-status")).toHaveText("Draft");
    await expect(card.getByTestId("item-flow-none")).toHaveText("No flow yet. Once the draft is confirmed, Oracle can draw one.");
    await card.getByRole("link", { name: "Confirm it in Priorities" }).click();
    await expect(page).toHaveURL(/\/simple\/priorities/);
    await expect(page.getByTestId("prio-draft").filter({ hasText: "Team invite nudges" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  // Moved: a phone's Timeline is a list by quarter; each bar is a row that names its item.
  test("qa-simple-roadmap-2: each bar of the phone Timeline names the item it carries", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "zoom");
    const bars = page.getByTestId("timeline-list").getByTestId("timeline-bar");
    await expect(bars.first()).toBeVisible();
    const names = await bars.evaluateAll((els) => els.map((e) => (e.querySelector("span.block")?.textContent ?? "").trim()));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n, "every bar has a name").not.toBe("");
    expect(names.join(" | ")).toContain("Weekly alert digest");
  });

  for (const format of ["waterfall", "gantt"] as const) {
    // Moved: the broken links sit in the panel above the chart (mk-qa4-roadmap QR3 A), not over the bars.
    test(`qa-simple-roadmap-6: a phone ${format}'s broken links keep their words whole`, async ({ page }) => {
      await open(page);
      await page.getByTestId(`format-${format}`).click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", format);
      await expect(page.getByTestId("broken-callout")).toHaveCount(0);
      const conflicts = page.getByTestId("conflicts").getByTestId("conflict");
      await expect(conflicts.first()).toBeVisible();
      await expect(page.locator('[data-testid="conflict"][data-item="alert-digest"]')).toContainText("which it depends on, ends");
      for (const c of await conflicts.all()) {
        const words = c.getByRole("button").first();
        const cut = await words.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
        expect(cut, `${await c.getAttribute("data-item")}'s words are whole`).toBe(false);
        const box = (await words.boundingBox())!;
        expect(box.x + box.width, "its words stay on the screen").toBeLessThanOrEqual(390);
      }
    });
  }
});
