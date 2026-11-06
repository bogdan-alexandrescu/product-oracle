import { MOCK_NOW } from "../lib/api/mock/clock";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Pre-demo QA, driven through Simple's UI on the mock's invented data:
 * - P-1 / V-1 / V-2 / S-13: the mock's data does not depend on which page opens first (the Goal
 *   map's features are seeded with the db, not on the map's first read): the Roadmap's Q1 2027,
 *   Priorities' ranked list and the Inbox badge read the same whichever order they open in.
 * - S-7: Simple's rail Inbox opens Simple's own Inbox (/simple/inbox), in Simple, with no console error.
 * - P-4: "Decide as recommended" on Decisions says the question by its code and its words, and
 *   the message covers no control.
 */

test.use({ viewport: { width: 1512, height: 900 } });

type Counts = { q1: string[]; ranked: string[]; inbox: string };

async function goalMap(page: Page) {
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-guardrail")).toBeVisible();
}

async function counts(page: Page): Promise<Counts> {
  await page.goto("/simple/roadmap");
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap" })).toBeVisible();
  // The Roadmap's Q1 2027: its timeline rows, from Q1 2027 to Q1 2027 (the items, by their names).
  await page.getByTestId("filter-from").selectOption({ label: "Q1 2027" });
  await page.getByTestId("filter-to").selectOption({ label: "Q1 2027" });
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
  const q1 = [...new Set(await page.getByTestId("timeline-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-item") ?? "")))].sort();
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
  // Priorities' ranked list, by the features' names.
  const ranked = (await page.getByTestId("prio-row").getByTestId("prio-title").allTextContents()).map((t) => t.trim());
  const inbox = page.getByTestId("simple-nav").getByTestId("simple-nav-inbox-count");
  await expect(inbox).toBeVisible();
  return { q1, ranked, inbox: (await inbox.textContent())!.trim() };
}

test.describe("P-1: the mock's counts do not depend on which page opens first", () => {
  // fails_when: the Goal map's first read adds its features to the roadmap, so the counts read
  // before it differ from those read after it (Q1 2027 4 -> 16 items, Priorities 10 -> 22, Inbox 11 -> 22).
  test("Roadmap, Priorities and the Inbox badge first, then the Goal map: the same counts", async ({ page }) => {
    await login(page);
    const before = await counts(page);
    // The map's features (roadmap items gm-f1 ...) are on the Roadmap from the first load, not only once the map was opened.
    expect(before.q1).toContain("gm-f1");
    await goalMap(page);
    const after = await counts(page);
    expect(after).toEqual(before);
  });

  test("the Goal map first, then Roadmap, Priorities and the Inbox badge: the same counts as the other order", async ({ page, browser }) => {
    await login(page);
    await goalMap(page);
    const mapFirst = await counts(page);
    // A fresh browser (its own mock db) that never opens the Goal map.
    const other = await browser.newContext({ viewport: { width: 1512, height: 900 } });
    try {
      await other.clock.install({ time: MOCK_NOW });
      const fresh = await other.newPage();
      await login(fresh);
      const mapNever = await counts(fresh);
      expect(mapNever).toEqual(mapFirst);
    } finally {
      await other.close();
    }
  });
});

test("S-7: Simple's rail Inbox keeps the person in Simple, with no console error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await page.goto("/simple/roadmap");
  const rail = page.getByTestId("simple-nav");
  await rail.getByTestId("simple-nav-inbox").click();
  await expect(page).toHaveURL(/\/simple\/inbox$/);
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  // Still Simple's rail, the Inbox lit in it.
  await expect(rail.getByTestId("simple-nav-inbox")).toBeVisible();
  await expect(rail.getByTestId("simple-nav-inbox")).toHaveAttribute("aria-current", "page");
  // Opened straight, the page is there too (no 404).
  await page.goto("/simple/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page.getByTestId("simple-nav")).toBeVisible();
  expect(errors).toEqual([]);
});

test("P-4: Decide as recommended names the question and its message covers no control", async ({ page }) => {
  await login(page);
  await page.goto("/simple/decisions");
  await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
  const row = page.getByTestId("question-row").filter({ visible: true }).and(page.locator('[data-code="Q5"]'));
  await row.getByRole("button", { name: "Decide as recommended" }).click();
  const shown = page.getByRole("status").filter({ hasText: /^Decided Q5/ });
  await expect(shown).toHaveText(/^Decided Q5 Reminder default time: 9:00 in each person's zone/);
  // It settles at a spot clear of every control on the page (the next question's "Another answer" too).
  await expect
    .poll(
      () =>
        shown.evaluate((el) => {
          const t = el.getBoundingClientRect();
          const controls = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]')];
          return controls
            .filter((c) => !el.contains(c))
            .filter((c) => {
              const r = c.getBoundingClientRect();
              return r.width > 1 && r.height > 1 && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
            })
            .map((c) => c.textContent?.trim() || c.getAttribute("aria-label") || c.tagName);
        }),
      { timeout: 5000 },
    )
    .toEqual([]);
});
