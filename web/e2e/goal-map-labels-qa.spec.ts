import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal map visual QA (R-2, R-3), driven through the UI against the mock (invented data).
 * R-2: the week strip's labels ("We are here" and each milestone's name) never overlap; at 1024
 * "M2 50 sign-ups per rep" (week 5) and "M5 10 paid conversions" (week 9) were drawn on top of
 * each other. R-3: the Overview (the map's three-part pill, one part per goal) shows each goal's
 * number in every part, and each part is named.
 *
 * protects: every milestone label on the ladder's time strip can be read; the Overview's parts say what they are.
 * fails_when: two label boxes intersect, or an Overview part is blank or unnamed.
 * no_claim: the labels' wording or the Overview's click-to-pan.
 */

const SHOTS = process.env.LADDER_SHOTS;

async function open(page: Page, scheme: "light" | "dark", role?: "approver" | "commenter") {
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple");
  if (page.viewportSize()!.width <= 600) {
    await page.getByTestId("simple-tab-more").click();
    await page.getByTestId("simple-more-sheet").getByRole("link", { name: "Goal map" }).click();
  } else await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-page")).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const meet = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every label under the week chips, as drawn; and each pair that overlaps. */
async function clashes(page: Page) {
  const labels = page.locator('[data-testid="ld-week-mark"], [data-testid="ld-here"]');
  const boxes: { text: string; box: Box }[] = [];
  for (const l of await labels.all()) boxes.push({ text: (await l.innerText()).replace(/\n/g, " / "), box: (await l.boundingBox())! });
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (meet(boxes[i].box, boxes[j].box)) out.push(`${boxes[i].text} × ${boxes[j].text}`);
  return { n: boxes.length, out };
}

for (const width of [1024, 1440]) {
  for (const scheme of ["light", "dark"] as const) {
    for (const role of [undefined, "approver"] as const) {
      test(`${width} ${scheme} ${role ?? "owner"}: the week strip's labels never overlap; each Overview part shows and names its goal`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, scheme, role);
        await expect(page.getByTestId("ld-periods")).toBeVisible();
        await expect(page.getByTestId("ld-week-mark").filter({ hasText: "M2 50 sign-ups per rep" })).toBeVisible();
        await expect(page.getByTestId("ld-week-mark").filter({ hasText: "M5 10 paid conversions" })).toBeVisible();
        const { n, out } = await clashes(page);
        expect(n).toBeGreaterThan(2);
        expect(out).toEqual([]);

        // R-3: the Overview's parts, one per goal: each shows its goal's number and is named.
        const overview = page.getByRole("button", { name: "Overview" });
        await expect(overview).toBeVisible();
        const parts = overview.getByTestId("ld-overview-goal");
        await expect(parts).toHaveCount(3);
        for (const [i, name] of ["Sign-ups per rep per day", "Paid conversions per rep per day", "Revenue per day"].entries()) {
          const part = parts.nth(i);
          await expect(part).toHaveText(String(i + 1));
          await expect(part).toHaveAccessibleName(`Goal ${i + 1}: ${name}`);
          // Its number can be seen: drawn in a colour unlike the part's own background.
          const [fg, bg] = await part.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
          expect(fg).not.toBe(bg);
          const box = (await part.boundingBox())!;
          expect(box.width).toBeGreaterThan(8);
          expect(box.height).toBeGreaterThan(10);
        }
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/qa-${width}-${scheme}-${role ?? "owner"}.png` });
      });
    }
  }
}

test("1024 light commenter: the week strip's labels never overlap", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await open(page, "light", "commenter");
  await expect(page.getByTestId("ld-week-mark").filter({ hasText: "M5 10 paid conversions" })).toBeVisible();
  expect((await clashes(page)).out).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("390 dark approver: no two week labels overlap", async ({ page }) => {
    await open(page, "dark", "approver");
    await expect(page.getByTestId("gm-page")).toBeVisible();
    expect((await clashes(page)).out).toEqual([]);
  });
});
