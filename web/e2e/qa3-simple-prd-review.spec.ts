import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The fix4-simple-prd review, on the mock (invented data), driven through the UI:
 *
 * - presenting: protects = Tab inside a flow opened over the presented page stays in that
 *   dialog; fails_when = every Tab pulls focus back to "Stop presenting" behind it.
 * - presenting: protects = Escape on the editor's "Discard your changes?" answers that question
 *   and keeps presenting; fails_when = it ends present mode.
 * - phone: protects = a touch that scrolls from a line's hidden Edit leaves the Edit's next
 *   keyboard Enter working; fails_when = that Enter is swallowed.
 * - the plan's bars: protects = a bar too short for its name still shows a few letters of it
 *   ("Sett…"), never a two-letter stub; fails_when = "Se…".
 * - the one-pager's status: protects = the chip reads the PRD's own summary, the list's numbers,
 *   without fetching every PRD; fails_when = the page loads the whole PRD list.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const ONE_PAGER = "/simple/one-pagers/guided-setup";

const inFlow = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-testid="flow-detail"]'));

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("a flow opened while presenting keeps Tab inside it", async ({ page }) => {
    await login(page);
    await page.goto(ONE_PAGER);
    await expect(page.getByTestId("one-pager")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.requestFullscreen = () => Promise.reject(new Error("refused"));
    });
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
    await page.getByRole("group", { name: /^User flow of “A setup checklist that shows/ }).getByRole("button", { name: "Open the flow", exact: true }).click();
    const opened = page.getByTestId("flow-detail");
    await expect(opened.getByTestId("flow-svg")).toBeVisible();
    await opened.getByRole("button", { name: "Full screen" }).focus();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      expect(await inFlow(page), `Tab ${i + 1} stays in the flow`).toBe(true);
    }
    await expect(page.getByRole("button", { name: "Stop presenting" })).not.toBeFocused();
    await opened.getByRole("button", { name: "Close", exact: true }).click();
    await expect(opened).toHaveCount(0);
    await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
  });

  test("Escape on 'Discard your changes?' while presenting keeps presenting", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Team workspaces PRD" }).click();
    await expect(page.getByRole("article", { name: "One-pager" })).toBeVisible();
    await page.locator('[data-line="not_doing-2"]').hover();
    await page.getByRole("button", { name: "Edit “A mobile setup flow" }).click();
    const box = page.getByLabel("New wording for");
    await box.fill("A phone setup flow");
    await page.evaluate(() => {
      document.documentElement.requestFullscreen = () => Promise.reject(new Error("refused"));
    });
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
    await box.click();
    await page.keyboard.press("Escape");
    const ask = page.getByRole("alertdialog", { name: "Discard your changes?" });
    await ask.getByRole("button", { name: "Keep editing" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
    await expect(box).toHaveValue("A phone setup flow");
  });

  test("the status chip reads the PRD's own summary, as the list does, without loading every PRD", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    const row = page.getByTestId("one-pager-row").filter({ hasText: "Team workspaces PRD" });
    await expect(row).toContainText("In review");
    await row.getByRole("link", { name: "Team workspaces PRD" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Team workspaces PRD" })).toBeVisible();
    await expect(page.getByTestId("one-pager-status")).toHaveText("In review");
    // Opened afresh (a link from elsewhere), the page asks for this PRD only.
    await page.reload();
    await expect(page.getByTestId("one-pager-status")).toHaveText("In review");
    const calls = await page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);
    expect(calls.filter((c) => /^GET \/v1\/documents\?/.test(c))).toEqual([]);
  });

  test("a bar too short for its name still shows a few letters of it", async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await login(page);
    await page.goto(ONE_PAGER);
    const bars = page.getByRole("region", { name: "Timeline" }).getByTestId("timeline-bar");
    await expect(bars.first()).toBeVisible();
    // The width of the label's first four letters and "…", in its own font, against the room it has.
    const short = await bars.locator("span").evaluateAll((spans) =>
      spans
        .map((s) => {
          const ctx = document.createElement("canvas").getContext("2d")!;
          const cs = getComputedStyle(s);
          ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const text = s.textContent ?? "";
          const cut = s.scrollWidth > s.clientWidth + 1;
          return { text, room: s.clientWidth, need: ctx.measureText(`${text.slice(0, 4)}…`).width, cut };
        })
        .filter((b) => b.cut && b.room + 1 < b.need)
        .map((b) => b.text),
    );
    expect(short, "every shortened bar shows at least four letters of its name").toEqual([]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("a touch that scrolls from a hidden Edit leaves its keyboard Enter working", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Team workspaces PRD" }).click();
    await expect(page.getByRole("article", { name: "One-pager" })).toBeVisible();
    const edit = page.locator('[data-line="bets-1"] [data-edit-for]');
    const e = (await edit.boundingBox())!;
    const x = e.x + e.width / 2;
    const y = e.y + e.height / 2;
    // A finger lands on the hidden Edit and drags the page up: a scroll, no tap.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let d = 20; d <= 200; d += 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - d }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByLabel("New wording for")).toHaveCount(0);
    // Then, with a keyboard, Enter on that Edit opens it.
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("New wording for")).toBeFocused();
  });
});
