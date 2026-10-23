import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * Home review fixes, round 2: Home's call budget for a large company, columns that never
 * blank after an action, a goal whose target cannot be read, and questions asked of me in
 * the Inbox, the rail badge and Home alike.
 */

const DB_KEY = "po-mock-db-v2";

async function openHome(page: Page, scenario?: "large" | "empty") {
  if (scenario) await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), scenario);
  await login(page);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
}

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

/** Waits until no call has been made for `quietMs`, then returns them all. */
async function settledCalls(page: Page, quietMs = 1500): Promise<string[]> {
  let last = -1;
  for (;;) {
    const now = (await calls(page)).length;
    if (now === last) return calls(page);
    last = now;
    await page.waitForTimeout(quietMs);
  }
}

/** Edits the mock's saved database in place (what another member's change would do). */
async function editDb(page: Page, edit: string, arg?: unknown) {
  await page.evaluate(
    ({ key, edit, arg }) => {
      const db = JSON.parse(localStorage.getItem(key)!);
      new Function("db", "arg", edit)(db, arg);
      localStorage.setItem(key, JSON.stringify(db));
    },
    { key: DB_KEY, edit, arg },
  );
}

/**
 * Home's first paint makes at most this many calls, however large the company. A1 added
 * one: the Set up checklist (/v1/setup), a fixed call whatever the company's size.
 */
const CALL_BUDGET = 14;

test("Home: a large company's first paint stays within the call budget", async ({ page }) => {
  await openHome(page, "large");
  await expect(page.getByTestId("home-in-flight-table").getByTestId("flight-row").first()).toBeVisible();
  await expect(page.getByTestId("home-inspector")).toBeVisible();
  const made = await settledCalls(page);
  // 30 goals and 50 more runs in flight: no call per goal, per run or per PRD.
  expect(made.length, made.join("\n")).toBeLessThanOrEqual(CALL_BUDGET);
  expect(made.filter((c) => /^GET \/v1\/runs\/[^/?]+$/.test(c)).length, "run details").toBeLessThanOrEqual(1);
  expect(made.filter((c) => c.includes("/revisions")).length, "goal trends").toBeLessThanOrEqual(4);
  expect(made.filter((c) => c.includes("/trace")).length, "traces").toBeLessThanOrEqual(1);
  expect(made.filter((c) => c.includes("/readiness")).length, "readiness").toBeLessThanOrEqual(1);
  // Trends read only the newest revisions.
  for (const c of made.filter((c) => c.includes("/revisions"))) expect(c).toMatch(/limit=\d+/);

  // Goals: the first four, the rest one click away.
  await expect(page.getByTestId("home-goals").locator("li[data-testid^='home-goal-']")).toHaveCount(4);
  await expect(page.getByTestId("goals-more")).toHaveText("26 more");
  // Done and Next for every run come from the runs list itself.
  const runs = page.getByTestId("home-in-flight-table").locator("[data-testid=flight-row][data-kind=run]");
  expect(await runs.count()).toBeGreaterThan(50);
  await expect(runs.filter({ hasText: "team-onboarding-12" }).getByRole("meter")).toHaveAttribute("aria-valuenow", "1");

  // Selecting another row loads that row's inspector, and nothing else.
  const before = (await calls(page)).length;
  await runs.filter({ hasText: "team-onboarding-12" }).click();
  await expect(page.getByTestId("home-inspector").getByRole("heading", { name: "team-onboarding-12" })).toBeVisible();
  await expect(page.getByTestId("home-inspector").getByTestId("stat-segments")).toContainText("1/4");
  const after = await settledCalls(page, 800);
  expect(after.slice(before).length, after.slice(before).join("\n")).toBeLessThanOrEqual(2);
});

test("Home: after an action no In flight column blanks while the lists reload", async ({ page }) => {
  await openHome(page);
  const table = page.getByTestId("home-in-flight-table");
  await expect(table.getByTestId("flight-row")).toHaveCount(6);
  await expect(table.locator("[data-kind=run]").first().getByRole("meter")).toBeVisible();
  // Another member starts a run meanwhile: the reload after the action brings a new row.
  await editDb(
    page,
    `const model = db.runs.runs.find((r) => r.status === "awaiting_checkpoint");
     const r = JSON.parse(JSON.stringify(model));
     r.id = "00000000-0000-4000-8000-00000000abcd"; r.document_slug = "late-run"; r.checkpoints = [];
     r.status = "running"; r.segments[1].status = "running"; r.created_at = "2026-10-18T08:00:00Z";
     db.runs.runs.push(r);`,
  );
  // Record every moment a run row's Next or Done cell reads "–", or a row disappears.
  await page.evaluate(() => {
    const w = window as unknown as { __blanks: string[] };
    w.__blanks = [];
    const table = document.querySelector("[data-testid=home-in-flight-table]")!;
    const check = () => {
      const rows = [...table.querySelectorAll("[data-testid=flight-row][data-kind=run]")];
      if (rows.length < 3) w.__blanks.push(`rows ${rows.length}`);
      for (const row of rows) {
        const cells = [...row.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
        if (cells.slice(2, 4).some((t) => t === "–" || t === "")) w.__blanks.push(cells.join(" | "));
      }
    };
    new MutationObserver(check).observe(table, { subtree: true, childList: true, characterData: true });
  });
  const needs = page.getByTestId("home-needs-table").locator("tr[data-row]");
  await needs.filter({ hasText: "$53.00 est." }).getByRole("button", { name: "Approve $53.00" }).click();
  await expect(table.getByTestId("flight-row")).toHaveCount(7);
  await expect(table.getByTestId("flight-row").filter({ hasText: "late-run" }).getByRole("meter")).toBeVisible();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __blanks: string[] }).__blanks)).toEqual([]);
});

test("Home: a readable current with a target Home cannot read shows both, no distance", async ({ page }) => {
  await openHome(page);
  await expect(page.getByTestId("home-goal-G2").getByTestId("goal-to-go")).toHaveText("2.6 pts to go");
  await editDb(page, `db.baseline.entities.find((e) => e.key === "g.paid-conversion").attrs.target = "best in class";`);
  await page.reload();
  const g2 = page.getByTestId("home-goal-G2");
  await expect(g2.getByTestId("goal-figure")).toHaveText("9.4%/ best in class");
  await expect(g2.getByTestId("goal-to-go")).toHaveText("");
  await expect(g2).not.toContainText("No current value");
  await expect(g2.getByRole("img", { name: "No current value" })).toHaveCount(0);
});

test("Questions asked of me: rail badge, Home and the Inbox count the same", async ({ page }) => {
  await openHome(page);
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(page.getByTestId("home-needs").getByText("Questions 2")).toBeVisible();
  await expect(page.getByText("10 waiting")).toBeVisible();
  await expect(badge).toHaveText("10");
  await expect(page.getByTestId("home-needs").getByTestId("panel-count")).toHaveText("10");

  await page.getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  // Next keeps Home mounted but hidden: only the visible page counts.
  await expect(page.getByText("10 waiting").filter({ visible: true })).toBeVisible();
  const questions = page.getByTestId("inbox-questions");
  // The seed asks me two: a v2 question and the deposits PRD's blocker question.
  await expect(questions.locator("tr[data-row]")).toHaveCount(2);
  await expect(questions).toContainText("Same-day cancellation refund?");
  const row = questions.locator("tr[data-row]").filter({ hasText: "Which metric" });
  await expect(row).toContainText("Which metric shows repeat checkout got faster?");
  await expect(row).toContainText("Oracle asks");
  await expect(row.getByRole("link", { name: "Open Before drafting · Saved addresses" })).toHaveAttribute("href", /^\/intakes\/[0-9a-f-]+$/);
  // A first visit: all ten under New, the questions with them.
  await expect(page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^New/ })).toHaveText("New10");
  await expect(page.getByTestId("inbox-tab-new").getByTestId("inbox-questions")).toBeVisible();
  await expect(badge).toHaveText("10");
});

test("Questions asked of me: Home shows one with 7 or more inbox items, and only mine", async ({ page }) => {
  await openHome(page, "large");
  const needs = page.getByTestId("home-needs");
  const rows = needs.getByTestId("home-needs-table").locator("tr[data-row]");
  await expect(rows).toHaveCount(7);
  await expect(rows.filter({ hasText: "Oracle asks" })).toHaveCount(1);
  await expect(needs.getByText("Questions 6")).toBeVisible();
  await expect(needs).not.toContainText("Who owns the pricing page?");
  const waiting = await page.getByTestId("nav-inbox-badge").textContent();
  await expect(page.getByText(`${waiting} waiting`)).toBeVisible();
  await expect(needs.getByTestId("panel-count")).toHaveText(waiting!);

  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-questions").locator("tr[data-row]")).toHaveCount(6);
  await expect(page.getByText(`${waiting} waiting`).filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText(waiting!);
});

test("Questions asked of me: the badge re-reads after an action on Home", async ({ page }) => {
  await openHome(page);
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(badge).toHaveText("10");
  const rows = page.getByTestId("home-needs-table").locator("tr[data-row]");
  await rows.filter({ hasText: "$53.00 est." }).getByRole("button", { name: "Approve $53.00" }).click();
  // No navigation: the badge follows Home.
  await expect(page.getByText("9 waiting")).toBeVisible();
  await expect(badge).toHaveText("9");
  await expect(page).toHaveURL(/\/home$/);
});

test("Home reloads the questions asked of me after an action", async ({ page }) => {
  await openHome(page);
  await expect(page.getByTestId("home-needs").getByText("Questions 2")).toBeVisible();
  // Meanwhile a question is asked of me; the action's reload brings it in.
  await editDb(
    page,
    `const q = db.v2.questions[0];
     db.v2.questions.push({ ...q, id: "00000000-0000-4000-8000-00000000beef", prompt: "Which plan do pilots get?", created_at: "2026-10-19T08:00:00Z" });`,
  );
  const rows = page.getByTestId("home-needs-table").locator("tr[data-row]");
  await rows.filter({ hasText: "$53.00 est." }).getByRole("button", { name: "Approve $53.00" }).click();
  // 10 items: six lines show one question; the count chips and the badge read the new one.
  await expect(page.getByTestId("home-needs").getByText("Questions 3")).toBeVisible();
  await expect(page.getByTestId("home-needs").getByTestId("panel-count")).toHaveText("10");
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("10");
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-questions").locator("tr[data-row]").filter({ hasText: "Which plan do pilots get?" })).toHaveCount(1);
});

test("Questions asked of me: a failing call shows the block's error, never an empty list", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-fail", "/v1/inbox/questions"));
  await openHome(page);
  const needs = page.getByTestId("home-needs");
  await expect(needs.getByTestId("home-questions-error")).toContainText("Mock failure");
  // The inbox rows still show: 8 items, six lines and '+2 more in Inbox'.
  await expect(needs.getByTestId("home-needs-table").locator("tr[data-row]")).toHaveCount(7);
  await expect(needs.getByTestId("home-needs-more")).toHaveText("+2 more in Inbox");
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-questions-error")).toContainText("Mock failure");
});

test("Home: Enter on an In flight row selects it; the inspector's Open opens it", async ({ page }) => {
  await openHome(page);
  const flights = page.getByTestId("home-in-flight-table").getByTestId("flight-row");
  await flights.filter({ hasText: "Checkout redesign PRD" }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/home$/);
  const selected = flights.and(page.locator("[aria-selected=true]"));
  await expect(selected).toHaveCount(1);
  const name = (await selected.locator("td").first().textContent())!;
  await expect(page.getByTestId("home-inspector")).toContainText(name.replace(/v\d+$/, "").trim().slice(0, 12));
  // The inspector shows the selected PRD's goals (loaded for that row only).
  await flights.filter({ hasText: "Checkout redesign PRD" }).click();
  await expect(page.getByTestId("home-inspector").getByTestId("row-goals")).toHaveText("Raise activationGrow paid conversion");
});

test("Home for a viewer: no New PRD, no Build the baseline", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-role", "viewer"));
  await openHome(page);
  await expect(page.getByTestId("home-goal-G1")).toBeVisible();
  await expect(page.getByRole("link", { name: "New PRD" })).toHaveCount(0);
  await expect(page.getByTestId("home-goal-G1").getByTestId("goal-trend").getByRole("img")).toHaveAttribute("aria-label", "Raise activation trend");
});

test("Home for a viewer of a new company: one line per block, no actions they cannot take", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-role", "viewer"));
  await openHome(page, "empty");
  await expect(page.getByTestId("home-goals-empty")).toContainText("No goals yet");
  await expect(page.getByRole("link", { name: "Build the baseline" })).toHaveCount(0);
  await expect(page.getByTestId("home-in-flight-empty")).toContainText("Nothing in flight");
  await expect(page.getByRole("link", { name: "New PRD" })).toHaveCount(0);
});
