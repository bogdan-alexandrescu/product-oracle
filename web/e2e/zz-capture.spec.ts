import { login } from "./helpers";
import { expect, test } from "./test";
const OUT = process.env.SHOTS!;
for (const [size, vp, scheme] of [["desk", { width: 1440, height: 900 }, "light"], ["phone", { width: 390, height: 844 }, "dark"]] as const) {
  test.describe(size, () => {
    test.use({ viewport: vp, colorScheme: scheme });
    test(`cs1 ${size}`, async ({ page }) => {
      await login(page);
      await page.goto("/baseline?view=current");
      await expect(page.getByTestId("cs1-row").first()).toBeVisible();
      await page.screenshot({ path: `${OUT}/cs1-a-${size}-rest.png` });
      await page.getByRole("button", { name: "Check again" }).click();
      await expect(page.getByTestId("cs1-check")).toContainText("not read yet");
      await page.screenshot({ path: `${OUT}/cs1-a-${size}-mid.png` });
      await page.getByRole("button", { name: "Yes, still runs" }).click();
      await expect(page.getByTestId("cs-summary")).toContainText("0 with old proof");
      await page.screenshot({ path: `${OUT}/cs1-a-${size}-done.png` });
    });
    test(`cs2 ${size}`, async ({ page }) => {
      await login(page);
      await page.goto("/simple/priorities");
      await expect(page.getByTestId("cs-legend")).toBeVisible();
      await page.screenshot({ path: `${OUT}/cs2-b-${size}-rest.png` });
      await page.getByTestId("prio-row").first().getByRole("button", { name: /^What / }).click();
      await page.screenshot({ path: `${OUT}/cs2-b-${size}-open.png` });
      await page.keyboard.press("Escape");
      await page.getByTestId("cs-legend").getByRole("button", { name: /^New / }).click();
      await page.screenshot({ path: `${OUT}/cs2-b-${size}-done.png` });
      await page.goto("/simple/roadmap");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("cs-mark").first()).toBeVisible();
      await page.screenshot({ path: `${OUT}/cs2-b-${size}-places.png` });
    });
    test(`cs3 ${size}`, async ({ page }) => {
      await login(page);
      await page.goto("/baseline");
      const band = page.getByTestId("cs3-ready");
      await expect(band).toBeVisible();
      await page.screenshot({ path: `${OUT}/cs3-b-${size}-rest.png` });
      await band.locator("button").first().click();
      await page.screenshot({ path: `${OUT}/cs3-b-${size}-open.png` });
      await page.getByRole("button", { name: "Move to Current state" }).click();
      await expect(band).toContainText("1 ready to move");
      await page.goto("/baseline?view=current");
      await expect(page.getByTestId("cs-moved-note")).toBeVisible();
      await page.screenshot({ path: `${OUT}/cs3-b-${size}-done.png` });
    });
  });
}
