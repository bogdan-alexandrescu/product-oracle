import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * BR goal map codes (docs/qa/2026-11-12/simple-goalmap.md GM6), on the mock's default data: the
 * default Goal map's milestones sit on the default roadmap, as the API's, so each strip reads its
 * roadmap code with its name ("M4 32 demos per rep"), one code per milestone.
 * protects: every milestone of the default map's strip leads with an M code, no two alike.
 * fails_when: a strip shows its name with no code.
 */

test("the default Goal map's milestones read their roadmap codes", async ({ page }) => {
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
  const strips = page.getByTestId("gm-strip-milestone");
  await expect(strips.first()).toBeVisible();
  const n = await strips.count();
  expect(n).toBeGreaterThan(1);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = strips.nth(i).locator("b").first();
    await expect(code).toHaveText(/^M\d+$/);
    codes.push((await code.textContent()) ?? "");
  }
  expect(new Set(codes).size).toBe(n);
});
