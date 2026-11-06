import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * C-8: the one-pager's Present is a run of full-screen slides, driven through the UI on the
 * mock's invented PRD "guided-setup", on a desktop and a phone, light and dark.
 *
 * Card one-pager-present-slides: protects = Present shows one block a slide (the problem,
 * what we build, outcomes, not doing, risks), then the timeline on its own slide; the
 * arrow keys and Space page them, the count says where you are, the type is larger than
 * the page's, the Next and Previous buttons page them too, a feature named on the timeline
 * slide opens the feature panel over it, and Stop presenting ends it; Space on a focused
 * button presses it rather than paging; the timeline slide fits the screen, its last
 * milestone in view, each milestone's items a count with their names on asking;
 * fails_when = Present is the same page without its menu, the keys do nothing, Space on
 * Previous slide pages forward, or the timeline (or its last milestone) sits below the fold;
 * no_claim = the browser's own full-screen frame.
 */

const URL = "/simple/prds/guided-setup";

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test("Present pages through one slide a block, the timeline last", async ({ page }) => {
        await login(page, "viewer@example.com");
        await page.goto(URL);
        await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
        await page.getByRole("button", { name: "Present" }).click();
        await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
        const slide = page.getByTestId("slide");
        const count = page.getByTestId("slide-count");
        await expect(slide.getByRole("heading", { level: 2 })).toHaveText("Problem and who has it");
        await expect(count).toHaveText(/^1 \/ 6$/);
        await expect(slide).toContainText("New workspace admins stall during setup");
        // The page's own blocks are not under the slide.
        await expect(page.getByRole("region", { name: "What we will build" })).toHaveCount(0);
        const size = await slide.locator("li").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(size).toBeGreaterThanOrEqual(20);

        await page.keyboard.press("ArrowRight");
        await expect(slide.getByRole("heading", { level: 2 })).toHaveText("What we will build");
        await expect(count).toHaveText("2 / 6");
        await expect(slide).toContainText("A setup checklist that shows the next step");
        await page.keyboard.press("Space");
        await expect(slide.getByRole("heading", { level: 2 })).toHaveText("Outcomes and how we measure them");
        await expect(slide).toContainText("48% → 65%");
        // Space on a focused button presses it; it does not page the slides.
        await page.getByRole("button", { name: "Previous slide" }).focus();
        await page.keyboard.press("Space");
        await expect(count).toHaveText("2 / 6");
        await page.keyboard.press("ArrowLeft");
        await expect(count).toHaveText("1 / 6");
        await page.getByRole("button", { name: "Next slide" }).click();
        await page.getByRole("button", { name: "Next slide" }).click();
        await page.getByRole("button", { name: "Next slide" }).click();
        await expect(slide.getByRole("heading", { level: 2 })).toHaveText("Not doing");
        await page.keyboard.press("ArrowRight");
        await expect(slide.getByRole("heading", { level: 2 })).toHaveText("Risks and open decisions");
        await page.keyboard.press("ArrowRight");
        await expect(count).toHaveText("6 / 6");
        await expect(slide.getByRole("heading", { level: 2 })).toHaveText("Timeline");
        // The timeline is the slide, in view without scrolling.
        await expect(slide.getByLabel("Timeline strip")).toBeInViewport();
        await expect(page.getByRole("button", { name: "Previous slide" })).toBeInViewport();
        await expect(page.getByRole("button", { name: "Next slide" })).toBeDisabled();
        await page.keyboard.press("ArrowRight");
        await expect(count).toHaveText("6 / 6");
        // The whole timeline fits the slide: every milestone, the last (M3) too, in view.
        const rows = slide.getByTestId("plan-strip-row");
        await expect(rows.filter({ hasText: "M3" })).toHaveCount(1);
        await expect(rows.filter({ hasText: "M3" })).toBeInViewport({ ratio: 1 });
        await expect(rows.last()).toBeInViewport({ ratio: 1 });
        expect(await slide.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
        // Each milestone's items are a count; their names show on asking (and on hover).
        await expect(slide.getByText("Setup checklist", { exact: true })).toHaveCount(0);
        const show = slide.getByRole("button", { name: /^Show the names in / });
        await expect(show.first()).toHaveAttribute("title", /\S/);
        for (const b of await show.all()) await b.click();
        // A feature named on the timeline slide opens the one feature panel, over the slide.
        await slide.getByText("Setup checklist", { exact: true }).first().click();
        await expect(page.getByTestId("item-panel")).toBeVisible();
        await expect(page.getByTestId("item-panel")).toBeInViewport();
        // Escape closes the panel and keeps presenting.
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("item-panel")).toHaveCount(0);
        await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
        await expect(count).toHaveText("6 / 6");

        // Space on a focused Stop presenting presses it.
        await page.getByRole("button", { name: "Stop presenting" }).focus();
        await page.keyboard.press("Space");
        await expect(page.getByTestId("one-pager")).not.toHaveAttribute("data-presenting", "true");
        await expect(page.getByRole("region", { name: "What we will build" })).toBeVisible();
      });
    });
  }
}
