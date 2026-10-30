import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";

/*
 * The Ask panel's thread (qa-shell-20, qa-shell-21), on the mock API as a person would use
 * it: a private chat on Priorities names its subject once, its reply box says who reads the
 * reply, and on a phone the (i) beside "Just you and Oracle" is a circle, not a tall pill.
 *
 * Card: protects=one subject line, the private placeholder, the round (i); fails_when=the
 * subject shows in the About chip, the title and the line under it, a private chat offers
 * "Reply to Oracle and the team", or the (i) is stretched by the sheet's 44 px rule;
 * no_claim=shared threads' own wording (discussions specs).
 */

const panel = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });

test("a private Ask thread names its subject once and its reply box says Reply to Oracle", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await page.getByTestId("hop-strip").click();
  await expect(panel(page).getByTestId("hop-about")).toHaveText("New chat about Priority order");
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill("Why is checkout first?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  const thread = panel(page).getByTestId("discussion-thread");
  await expect(thread.getByTestId("oracle-reply").last()).toHaveAttribute("data-status", "complete");
  await expect(thread.getByTestId("discussion-visibility")).toHaveText("Private");
  // Once: the thread's header names it; no About chip and no repeated line under the title.
  const text = await panel(page).innerText();
  expect(text.split("Priority order").length - 1, text).toBe(1);
  await expect(thread.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Reply to Oracle");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the (i) beside Just you and Oracle in the Ask sheet is round", async ({ page }) => {
    await login(page);
    await page.goto("/priorities");
    await page.getByTestId("phone-ask").click();
    const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
    const tip = sheet.getByTestId("hop-visibility").getByTestId("info-tip");
    await expect(tip).toBeVisible();
    const box = (await tip.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(Math.abs(box.width - box.height), `the (i) is ${box.width} x ${box.height}`).toBeLessThanOrEqual(0.5);
    // Its drawn circle too.
    const circle = (await tip.locator("span").first().boundingBox())!;
    expect(Math.abs(circle.width - circle.height)).toBeLessThanOrEqual(0.5);
  });
});

for (const width of [1366, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`at ${width} px (${theme}) the open Ask drawer lies above the page and takes its own clicks`, async ({ page }) => {
      // protects=below 1600 px the Ask drawer overlays the page above everything in it (fix-shell
      // review); fails_when=a roadmap card's buttons paint over the drawer and take the clicks
      // meant for Send; no_claim=what the answer says (simple-ask-one-box.spec.ts).
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        ([key, themeKey, t]) => {
          localStorage.setItem(key, "simple-chat");
          localStorage.setItem(themeKey, t);
        },
        [MOCK_SCENARIO_KEY, THEME_KEY, theme] as const,
      );
      await page.goto("/login");
      await page.getByLabel("Email").fill("commenter@example.com");
      await page.getByLabel("Password").fill(ADMIN.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).not.toHaveURL(/\/login/);
      await page.goto("/simple/roadmap");
      await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
      const drawer = page.getByTestId("hop-drawer");
      await expect(panel(page).getByTestId("ask-chat")).toBeVisible();
      const box = (await drawer.boundingBox())!;
      const outside = await drawer.evaluate((el, b) => {
        const miss: string[] = [];
        for (let i = 1; i < 10; i++)
          for (let j = 1; j < 10; j++) {
            const x = b.x + (b.width * i) / 10;
            const y = b.y + (b.height * j) / 10;
            const hit = document.elementFromPoint(x, y);
            if (!hit || !el.contains(hit)) miss.push(`${Math.round(x)},${Math.round(y)}`);
          }
        return miss;
      }, box);
      expect(outside, "points of the drawer that the page covers").toEqual([]);
      await panel(page).getByRole("textbox", { name: "Message Oracle" }).fill("who owns Weekly alert digest?");
      await panel(page).getByRole("button", { name: "Send" }).click();
      await expect(panel(page).getByTestId("ask-chat-thread").getByTestId("chat-message").last()).toHaveAttribute("data-kind", "answer");
    });
  }
}
