import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";

/**
 * Simple production walk (#723): the line on Priorities marks each row that misses it (a
 * "Misses <line>" tag and a muted row, the caption "N of M miss <line>" with the names) in
 * rank order, with no single divider unless everything below it misses the line; and Simple's
 * Home paints its frame and skeleton at once while the person's permissions and its queries
 * answer, then fills them in place. Driven through the UI against the mock
 * (web/lib/api/mock/simple-priorities.ts, server.ts' slow switch) on desktop (1366x820) and
 * phone (390x844), light and dark, as an owner and a viewer. Each test's card is in its
 * comment.
 */

const PRIORITIES = "/simple/priorities";
const DESKTOP = { viewport: { width: 1366, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const ROLES = { owner: undefined, viewer: "viewer@example.com" } as const;

type Marks = { above: boolean; misses: boolean; tag: string | null; title: string }[];

async function marks(rows: Locator, titleOf: (row: Locator) => Locator): Promise<Marks> {
  const out: Marks = [];
  for (const r of await rows.all()) {
    const tag = r.getByTestId("prio-misses");
    out.push({
      above: (await r.getAttribute("data-above")) === "true",
      misses: (await r.getAttribute("data-misses")) === "true",
      tag: (await tag.count()) ? await tag.textContent() : null,
      title: ((await titleOf(r).textContent()) ?? "").trim(),
    });
  }
  return out;
}

/** Each row's mark agrees with its side of the line, the caption counts and names them, and a divider shows only when everything below it misses. */
async function checkLine(page: Page, scope: Locator, rows: Locator, titleOf: (row: Locator) => Locator, label: string): Promise<boolean> {
  await expect(rows.first()).toBeVisible();
  const m = await marks(rows, titleOf);
  const missing = m.filter((r) => !r.above);
  for (const r of m) {
    expect(r.misses, r.title).toBe(!r.above);
    expect(r.tag, r.title).toBe(r.above ? null : `Misses ${label}`);
  }
  const caption = scope.getByTestId("line-caption");
  await expect(caption).toContainText(`${missing.length} of ${m.length} miss ${label}`);
  for (const r of missing) await expect(caption).toContainText(r.title);
  const first = m.findIndex((r) => !r.above);
  const interleaved = first >= 0 && m.slice(first).some((r) => r.above);
  await expect(scope.getByTestId("line-divider")).toHaveCount(first >= 0 && !interleaved ? 1 : 0);
  return interleaved;
}

for (const [where, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...size, colorScheme: scheme });

      for (const [role, email] of Object.entries(ROLES)) {
        /**
         * Card walk-prio-line-marks: protects = on Priorities' ranked list and the 2x2's ranked
         * side list, rank (dependency) order stays and each row that misses the line carries
         * "Misses <line>" and is muted, the caption above says "N of M miss <line>" and names
         * them, and the one divider row shows only when every row below it misses (never with
         * rows that make the line under it), for This quarter, each key date and a picked date;
         * fails_when = a row that makes the line sits under a divider, a missing row has no tag
         * (or a making row has one), or the caption miscounts or leaves a name out; no_claim =
         * which rows miss (API and roadmap-plus tests), the ranking itself.
         */
        test(`each row that misses the line is marked, no divider over rows that make it (${role})`, async ({ page }) => {
          await login(page, email);
          await page.goto(PRIORITIES);
          await expect(page.getByTestId("simple-priorities")).toBeVisible();
          const select = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
          const list = page.getByRole("list", { name: "Ranked list" }).locator("..");
          const rows = page.getByTestId("prio-row");
          const title = (r: Locator) => r.locator("span.flex-1.font-medium");
          const picks = (await select.locator("option").evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent ?? ""]))).filter(([v]) => v !== "pick");
          let sawInterleaved = false;
          for (const [value, text] of picks) {
            await select.selectOption(value);
            const label = text.replace(/^(Key date|Milestone): /, "");
            await expect(page.getByTestId("line-caption")).toContainText(` miss ${label}`);
            sawInterleaved = (await checkLine(page, list, rows, title, label)) || sawInterleaved;
          }
          await select.selectOption("pick");
          await page.getByLabel("The line's date").fill("2026-12-31");
          await expect(page.getByTestId("line-caption")).toContainText(" miss By Dec 31, 2026");
          sawInterleaved = (await checkLine(page, list, rows, title, "By Dec 31, 2026")) || sawInterleaved;
          // The mock's plan has a line where a row that makes it ranks below one that misses it.
          expect(sawInterleaved).toBe(true);

          await page.getByRole("tab", { name: "Value / effort" }).click();
          const side = page.getByRole("region", { name: "Ranked side list" });
          await checkLine(page, side, side.getByTestId("side-row"), (r) => r.locator("span.truncate"), "By Dec 31, 2026");
          await select.selectOption("now");
          await expect(page).not.toHaveURL(/line=/);
        });
      }

      /**
       * Card walk-prio-home-first-paint: protects = Simple's Home draws its frame at once while
       * the person's permissions are still on their way (the greeting, the goal band and cards as
       * skeleton placeholders, the rail's frame on a desktop), then fills them in place: the goal
       * band starts where its skeleton stood; fails_when = Home stays blank until the
       * permissions answer, or the band jumps when it fills; no_claim = how fast the real API
       * answers, the cards' contents (simple-home specs).
       */
      test("Home paints its frame and skeleton at once, then fills in place", async ({ page, context }) => {
        await login(page);
        await page.goto("/home");
        await context.addInitScript(
          ([slow, ms]) => {
            if (!sessionStorage.getItem("walk-prio-slow")) {
              localStorage.setItem(slow, "/v1/me/capabilities");
              localStorage.setItem(ms, "4000");
              sessionStorage.setItem("walk-prio-slow", "1");
            }
          },
          [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY],
        );
        await page.goto("/simple");
        const goals = page.getByTestId("home-goals");
        await expect(page.getByTestId("home-greeting")).toHaveAttribute("data-skeleton", "true", { timeout: 2500 });
        await expect(page.getByTestId("home-goals-skeleton")).toBeVisible();
        await expect(page.getByTestId("home-skeleton-rows").first()).toBeVisible();
        if (where === "desktop") await expect(page.getByTestId("simple-nav-skeleton")).toBeVisible();
        const before = (await goals.boundingBox())!;
        await expect(page.getByTestId("home-sentence")).toBeVisible({ timeout: 8000 });
        await expect(page.getByTestId("home-goal").first()).toBeVisible();
        await expect(page.getByTestId("simple-nav-skeleton")).toHaveCount(0);
        const after = (await goals.boundingBox())!;
        expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
        await page.evaluate(([slow, ms]) => [slow, ms].forEach((k) => localStorage.removeItem(k)), [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY]);
      });
    });
  }
}
