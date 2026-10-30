import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * fix4-simple-roadmap review: the review's minors on the Simple roadmap, driven through the UI
 * on the mock's invented data. With an item's card open the rail still navigates (it does not
 * only close the card); a draft with no flow says why and where to confirm it; the phone
 * Timeline's bars name the items they carry; a phone's broken-link callouts keep their words
 * whole (Waterfall and Gantt).
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

  test("SimpleShell: a click on the backdrop away from the rail only closes the card", async ({ page }) => {
    await open(page);
    await openRoadmapItem(page, "alert-rules");
    await expect(page.getByTestId("floating-card")).toBeVisible();
    await page.mouse.click(1400, 880);
    await expect(page.getByTestId("floating-card")).toHaveCount(0);
    await expect(page).toHaveURL(/\/simple\/roadmap/);
  });

  test("qa-simple-roadmap-39: a draft with no flow says why and offers to confirm it in Priorities", async ({ page }) => {
    await open(page, { url: "/simple/roadmap?roadmap=onboarding-roadmap" });
    await openRoadmapItem(page, "setup-ideas");
    const card = page.getByTestId("floating-card");
    await expect(card.getByTestId("draft-tag")).toHaveText("Draft");
    await expect(card.getByTestId("item-flow-none")).toHaveText("No flow yet. Once the draft is confirmed, Oracle can draw one.");
    await card.getByRole("link", { name: "Confirm it in Priorities" }).click();
    await expect(page).toHaveURL(/\/simple\/priorities/);
    await expect(page.getByTestId("prio-draft").filter({ hasText: "Team invite nudges" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("qa-simple-roadmap-2: each bar of the phone Timeline names the items it carries", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "lanes-phone");
    const lane = page.locator('[data-testid="phone-lane"][data-open="true"]');
    const names = (await lane.getByTestId("lane-run").evaluateAll((els) => els.map((e) => e.querySelector("title")?.textContent ?? ""))).join(" | ");
    const runs = await lane.getByTestId("lane-run").count();
    expect(runs).toBeGreaterThan(0);
    for (const t of await lane.getByTestId("lane-run").evaluateAll((els) => els.map((e) => e.querySelector("title")?.textContent ?? ""))) expect(t.trim(), "every bar has a name").not.toBe("");
    // Every item the lane's list shows is named on one of its bars.
    for (const row of await page.getByTestId("lane-row").all()) {
      const title = (await row.locator("span").nth(1).evaluate((el) => el.firstChild?.textContent ?? "")).trim();
      expect(names, `${title} is named on a bar`).toContain(title);
    }
  });

  for (const format of ["waterfall", "gantt"] as const) {
    test(`qa-simple-roadmap-6: a phone ${format}'s broken-link callouts keep their words whole`, async ({ page }) => {
      await open(page);
      await page.getByTestId(`format-${format}`).click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", format);
      const callouts = page.getByTestId("broken-callout");
      await expect(callouts.first()).toBeVisible();
      for (const c of await callouts.all()) {
        const words = c.locator("span[title]").first();
        const cut = await words.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
        expect(cut, `${await c.getAttribute("data-item")}'s callout words are whole`).toBe(false);
        await expect(words).toHaveText(`⚠ ${await words.getAttribute("title")}`);
      }
    });
  }
});
