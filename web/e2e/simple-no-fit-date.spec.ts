import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * simple-no-fit-date (BGD, Nov 5): fit a date is gone from Simple. The Roadmap page starts with its
 * toolbar, then Add an item, then the timeline, with no goal block above them; Home shows no card for
 * a date brought in. Driven through the UI against the mock's "fit-date" scenario (invented data: a
 * PRD with a late goal, the case that used to lead the page with it). 1440 and 390.
 *
 * protects=no fit-a-date block, 'Bring this date in' or 'with a smaller goal' on Roadmap or Home;
 * fails_when=the goal block, its button or the Home card shows; no_claim=the API's fit-date routes
 * (left in place, unused by any page).
 */

const SIZES = [
  ["desktop", { viewport: { width: 1440, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
] as const;

async function open(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "fit-date"] as const);
  await login(page, ADMIN.email);
}

async function noFit(page: Page) {
  await expect(page.getByTestId("fit-roadmap")).toHaveCount(0);
  await expect(page.getByTestId("fit-goal")).toHaveCount(0);
  await expect(page.getByTestId("fit-home")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bring this date in" })).toHaveCount(0);
  await expect(page.getByText(/with a smaller goal/)).toHaveCount(0);
}

for (const [name, size] of SIZES) {
  test.describe(name, () => {
    test.use(size);

    test("the Roadmap page starts with its toolbar, Add an item, then the timeline: no fit-a-date block", async ({ page }) => {
      await open(page);
      await page.goto("/simple/roadmap");
      const roadmap = page.getByTestId("simple-roadmap");
      await expect(roadmap).toBeVisible();
      await expect(page.getByTestId("format-switch")).toBeVisible();
      if (name === "desktop") {
        // Add an item comes straight under the toolbar, with nothing between them.
        const add = page.getByTestId("quick-add");
        await expect(add).toBeVisible();
        const head = (await roadmap.locator("header").first().boundingBox())!;
        const box = (await add.boundingBox())!;
        expect(box.y - (head.y + head.height)).toBeLessThan(24);
      }
      await noFit(page);
    });

    test("Home shows no fit-a-date card", async ({ page }) => {
      await open(page);
      await page.goto("/simple");
      await expect(page.getByTestId("home-goals")).toBeVisible();
      await noFit(page);
    });
  });
}
