import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

import { MOCK_FAIL_ONCE_KEY, MOCK_SIMPLE_MODE_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";

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
  // A short caption (Value/effort's side list) names the rest in its title.
  const named = `${await caption.textContent()} ${(await caption.getAttribute("title")) ?? ""}`;
  for (const r of missing) expect(named, r.title).toContain(r.title);
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
          const title = (r: Locator) => r.getByTestId("prio-title");
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
          await checkLine(page, side, side.getByTestId("side-row"), (r) => r.getByTestId("prio-title"), "By Dec 31, 2026");
          await select.selectOption("now");
          await expect(page).not.toHaveURL(/line=/);
        });
      }

      for (const [role, email] of Object.entries(ROLES)) {
        /**
         * Card walk-prio-home-first-paint: protects = Simple's Home draws its frame at once while
         * the person's permissions are still on their way (the greeting, the goal band and cards as
         * skeleton placeholders, the rail's frame on a desktop), then fills them in place for an
         * owner and a viewer alike: the goal band starts where its skeleton stood, no card the
         * skeleton names moves, and the first card under the band starts where the skeleton's
         * first card stood; fails_when = Home stays blank until the permissions answer, or the
         * band or a card jumps when it fills (a viewer has no "Walk me through it", an owner has
         * cards a viewer does not); no_claim = how fast the real API answers, the cards' contents
         * (simple-home specs).
         */
        test(`Home paints its frame and skeleton at once, then fills in place (${role})`, async ({ page, context }) => {
          await login(page, email);
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
          const cards = page.getByTestId("simple-page").locator("section.simple-card");
          await expect(page.getByTestId("home-greeting")).toHaveAttribute("data-skeleton", "true", { timeout: 2500 });
          await expect(page.getByTestId("home-goals-skeleton")).toBeVisible();
          await expect(page.getByTestId("home-skeleton-rows").first()).toBeVisible();
          if (where === "desktop") await expect(page.getByTestId("simple-nav-skeleton")).toBeVisible();
          const before = (await goals.boundingBox())!;
          const firstCard = (await cards.first().boundingBox())!;
          const named = await cards.evaluateAll((els) => els.filter((e) => e.getAttribute("aria-label")).map((e) => [e.getAttribute("aria-label")!, e.getBoundingClientRect().top] as const));
          await expect(page.getByTestId("home-sentence")).toBeVisible({ timeout: 8000 });
          await expect(page.getByTestId("home-goal").first()).toBeVisible();
          await expect(page.getByTestId("simple-nav-skeleton")).toHaveCount(0);
          const after = (await goals.boundingBox())!;
          expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
          expect(Math.abs((await cards.first().boundingBox())!.y - firstCard.y)).toBeLessThanOrEqual(1);
          for (const [name, top] of named) {
            const now = await page.getByRole("region", { name, exact: true }).evaluate((e) => e.getBoundingClientRect().top);
            expect(Math.abs(now - top), name).toBeLessThanOrEqual(1);
          }
          await page.evaluate(([slow, ms]) => [slow, ms].forEach((k) => localStorage.removeItem(k)), [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY]);
        });
      }
    });
  }
}

/**
 * Card walk-prio-home-off: protects = with Simple off, opening Simple's Home starts none of its
 * queries before Detailed's Home opens instead (#725: nothing of Simple while it is off);
 * fails_when = Home's queries (its working drafts among them) run while Simple is off;
 * no_claim = Detailed's Home, the switch (simple-mode spec).
 */
test("with Simple off, Simple's Home starts none of its queries before Detailed opens", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  await page.evaluate(
    ([mode, once]) => {
      localStorage.setItem(mode, "off");
      // Home's working drafts are read on Simple's Home alone: a call would use this up.
      localStorage.setItem(once, "GET /v1/simple/drafts");
    },
    [MOCK_SIMPLE_MODE_KEY, MOCK_FAIL_ONCE_KEY],
  );
  await page.goto("/simple");
  await expect(page).toHaveURL(/localhost:\d+\/home$/);
  await expect(page.locator('[data-mode="detailed"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "Home", exact: true })).toBeVisible();
  expect(await page.evaluate((once) => localStorage.getItem(once), MOCK_FAIL_ONCE_KEY)).toBe("GET /v1/simple/drafts");
  await page.evaluate(([mode, once]) => [mode, once].forEach((k) => localStorage.removeItem(k)), [MOCK_SIMPLE_MODE_KEY, MOCK_FAIL_ONCE_KEY]);
});

/**
 * Card walk-prio-side-caption: protects = Value/effort's 320 px side list names at most three
 * that miss the line and "and N more" (all of them in the caption's title), so a long list of
 * misses never runs on; the ranked list's caption still names them all; fails_when = the side
 * list's caption lists every missing title in one line; no_claim = which rows miss.
 */
test("Value/effort's side caption names three that miss the line and counts the rest", async ({ page }) => {
  await login(page);
  await page.goto(PRIORITIES);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  const select = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
  await select.selectOption("pick");
  await page.getByLabel("The line's date").fill("2026-10-28");
  const label = "By Oct 28, 2026";
  await expect(page.getByTestId("line-caption")).toContainText(` miss ${label}`);
  const titles = async (rows: Locator) => (await rows.evaluateAll((rs) => rs.filter((r) => r.getAttribute("data-misses") === "true").map((r) => r.querySelector('[data-testid="prio-title"]')!.textContent!.trim())));
  const all = await titles(page.getByTestId("prio-row"));
  expect(all.length).toBeGreaterThan(3);
  for (const t of all) await expect(page.getByTestId("line-caption")).toContainText(t);

  await page.getByRole("tab", { name: "Value / effort" }).click();
  const side = page.getByRole("region", { name: "Ranked side list" });
  const caption = side.getByTestId("line-caption");
  const missing = await titles(side.getByTestId("side-row"));
  await expect(caption).toContainText(`${missing.length} of `);
  await expect(caption).toContainText(`${missing.slice(0, 3).join(", ")} and ${missing.length - 3} more`);
  for (const t of missing.slice(3)) await expect(caption).not.toContainText(t);
  expect(await caption.getAttribute("title")).toBe(missing.join(", "));
  await select.selectOption("now");
});
