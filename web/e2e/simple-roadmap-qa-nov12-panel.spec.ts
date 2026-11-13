import { GM_TRACKS_SCENARIO } from "../lib/api/mock/goal-map-tracks";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA of Simple's Roadmap, Nov 12, 2026: the feature panel (#2, #5, #9, #10) and the Goal
 * map's panel (GM2). Mock data, clock pinned to Oct 22, 2026: Weekly alert digest (F-06) sits under
 * the roadmap's milestone M1 Beta; Alert rules engine has its own code, F-86, from its PRD's section
 * (every feature shows its code with its name, per the Ground Truth rule).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const panel = (page: Page) => page.getByTestId("floating-card");

async function openItem(page: Page, key: string) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("#2: an item's code shows with its name; its tooltip says it comes from its PRD", async ({ page }) => {
    await openItem(page, "alert-rules");
    const code = panel(page).getByTestId("card-code");
    await expect(code).toContainText("F-86");
    await panel(page).getByRole("button", { name: "About this code" }).hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "It comes from its PRD's section" })).toBeVisible();
  });

  test("#5: the Milestone field and its picker name the milestone with its code", async ({ page }) => {
    await openItem(page, "alert-digest");
    await expect(panel(page).getByTestId("card-milestone")).toHaveText(/^M\d+ Beta$/);
    await panel(page).getByRole("button", { name: "Change the milestone" }).click();
    const pick = panel(page).getByTestId("card-milestone-edit").getByRole("combobox");
    await expect(pick.locator("option").first()).toHaveText(/^M\d+ Beta$/);
  });

  test("#10: the Dates row's why is the circled InfoTip, not a plain (i)", async ({ page }) => {
    await openItem(page, "alert-digest");
    const dates = panel(page).getByTestId("card-dates");
    await expect(dates).not.toContainText("(i)");
    const tip = panel(page).getByRole("button", { name: "About these dates" });
    await tip.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("#9: each label sits on its value's line", async ({ page }) => {
    await openItem(page, "alert-digest");
    for (const id of ["card-status", "card-confidence", "card-outcome"]) {
      const value = panel(page).getByTestId(id);
      await value.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const gap = await value.evaluate((el) => {
        const dt = el.closest("dd")!.previousElementSibling!;
        const range = (n: Element) => {
          const r = document.createRange();
          r.selectNodeContents(n);
          return r.getClientRects()[0];
        };
        return Math.abs(range(dt).bottom - range(el).bottom);
      });
      expect(gap, id).toBeLessThanOrEqual(3);
    }
  });
});

test.describe("Goal map (GM2)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the panel reads the milestone the chip sits under, and its Serves line is inside the card", async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GM_TRACKS_SCENARIO] as const);
    await login(page);
    await page.goto("/simple/goals");
    await expect(page.getByTestId("gm-grid")).toBeVisible();
    const name = "No-show reminder texts";
    const id = await page.getByTestId("gm-goal").filter({ hasText: "Booked demos per rep per day" }).getAttribute("data-goal");
    const chip = page.locator(`[data-testid="gm-cell"][data-goal="${id}"]`).getByTestId("gm-chip").filter({ hasText: name });
    await chip.getByRole("button", { name: new RegExp(name) }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByTestId("card-milestone")).not.toHaveText("No milestone");
    await expect(panel(page).getByTestId("card-milestone")).toContainText("32 demos per rep");
    const serves = panel(page).getByTestId("gm-panel-milestone");
    await serves.scrollIntoViewIfNeeded();
    await expect(serves).toBeInViewport();
    const box = (await serves.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  });
});
