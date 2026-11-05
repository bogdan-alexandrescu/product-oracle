import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * walkc-roadmap-tasks: after a roadmap changes, on the mock with two roadmaps ("Usage
 * alerts" and "Guided setup"): a working draft belongs to one roadmap, a moved item is drawn
 * where it now is, an item's tasks reach their owner, and its decisions say who, when and
 * where the minutes are. Each test's card is in its comment.
 */

const URL = "/simple/roadmap";
const PHONE = { width: 390, height: 844 };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
/** The picked Timeline (build-roadmap) draws one bar per item, in the item's row. */
const timelineBar = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="timeline-row"][data-item="${key}"]`).getByTestId("timeline-bar");

async function drag(page: Page, key: string, dx: number) {
  const body = bar(page, key).locator("rect[data-body]");
  await body.scrollIntoViewIfNeeded();
  const box = (await body.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

/**
 * Card walkc-drafts-per-roadmap: protects = a change staged on "Usage alerts" shows in that
 * roadmap's working draft only; "Guided setup"'s page has no draft banner (desktop and
 * phone); fails_when = one person's draft lists every roadmap's changes on every roadmap's
 * page; no_claim = the all-roadmaps view, which lists every draft.
 */
for (const where of ["desktop", "phone"] as const) {
  test(`a working draft belongs to one roadmap (${where})`, async ({ page }) => {
    await login(page);
    await page.goto(`${URL}?roadmap=alerts-roadmap`);
    await page.getByTestId("format-gantt").click();
    await expect(bar(page, "alert-export")).toBeVisible();
    await drag(page, "alert-export", 90);
    await expect(page.getByTestId("draft-count")).toHaveText("1");
    if (where === "phone") await page.setViewportSize(PHONE);
    await page.goto(`${URL}?roadmap=onboarding-roadmap`);
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await expect(page.locator('[data-item="setup-checklist"]').first()).toBeAttached();
    await expect(page.getByTestId("draft-banner")).toHaveCount(0);
    await page.goto(`${URL}?roadmap=alerts-roadmap`);
    await expect(page.getByTestId("draft-count")).toHaveText("1");
  });
}

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** A review of "Guided setup" on the plan scenario (its items dated by the PRD's slices). */
async function startReview(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

/**
 * Card walkc-moved-drawn-where-it-moved: protects = after a review meeting moves "Sample data
 * import" (F-02, dated by its PRD slice) to Later, the Timeline's item bar and the Gantt's
 * slice bars start where the Waterfall's bar does, the item's new dates, not the plan's Nov 9;
 * fails_when = a moved item is drawn at its slice's old dates; no_claim = an estimated
 * item's slices, which stay on the plan.
 */
for (const where of ["desktop", "phone"] as const) {
  test(`a moved item is drawn where it moved (${where})`, async ({ page }) => {
    await startReview(page);
    await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
    await tap(page.getByRole("button", { name: "Move Sample data import to Later" }));
    await expect(page.getByTestId("roadmap-said")).toHaveText("Moved Sample data import to Later.");
    if (where === "phone") await page.setViewportSize(PHONE);
    await page.goto(`${URL}?roadmap=onboarding-roadmap`);
    await expect(page.getByTestId("simple-chart")).toBeVisible();
    await page.getByTestId("format-waterfall").click();
    const now = await bar(page, "setup-import").getAttribute("data-start");
    expect(now).not.toBe("2026-11-09");
    if (where === "desktop") {
      // The picked Timeline draws the item itself, not its slices: its bar starts there too.
      await page.getByTestId("format-timeline").click();
      await expect(timelineBar(page, "setup-import"), "timeline").toHaveAttribute("data-start", now!);
    }
    await page.getByTestId("format-gantt").click();
    await expect(page.locator('g[data-testid="slice-bar"][data-code^="F-02"]').first(), "gantt").toHaveAttribute("data-start", now!);
  });
}

/** Signs in as `email` with the mock's one password (as simple-roadmap-talk.spec.ts). */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Card walkc-tasks-reach-their-owner: protects = a task added to an item through Ask Oracle
 * ("for Theo Brandt by Nov 20") is listed under the item's Tasks with its owner and due
 * day, and Theo's Simple Home lists it under "Tasks waiting for you" (no "Nothing waits on
 * you"), desktop and phone; fails_when = the task is only a past chat line, or never reaches
 * its owner; no_claim = editing or closing a task.
 */
for (const where of ["desktop", "phone"] as const) {
  test(`a task added to an item is listed and reaches its owner (${where})`, async ({ page }) => {
    const phone = where === "phone";
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-chat"] as const);
    if (phone) await page.setViewportSize(PHONE);
    await signIn(page, ADMIN.email);
    await page.goto(URL);
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
    const ask = page.getByTestId("ask-chat").filter({ visible: true });
    await ask.getByLabel("Message Oracle").fill("add a task 'Draft the digest email' to Weekly alert digest for Theo Brandt by nov 20");
    await tap(ask.getByRole("button", { name: "Send" }));
    const c = ask.getByTestId("chat-card").filter({ hasText: "Draft the digest email" });
    await tap(c.getByRole("button", { name: "Apply" }));
    await expect(c.getByTestId("chat-card-outcome")).toContainText("Applied by you");
    await page.goto(URL);
    await page.getByTestId("format-gantt").click();
    await bar(page, "alert-digest").click();
    const card = page.getByTestId("floating-card");
    const task = card.getByTestId("card-task");
    await expect(task).toHaveCount(1);
    await expect(task).toHaveText("Draft the digest email · Theo Brandt · due Nov 20 · To do");
    // The account menu is the desktop rail's: sign out there, then come back as Theo.
    await card.getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);
    if (phone) await page.setViewportSize({ width: 1366, height: 820 });
    await signOut(page);
    if (phone) await page.setViewportSize(PHONE);
    await signIn(page, "commenter@example.com");
    await page.goto("/simple");
    const mine = page.getByTestId("home-tasks");
    await expect(mine).toBeVisible();
    // build-current-state: the item's feature carries its word pill after its name (it runs today: Exists).
    await expect(mine.getByTestId("home-task")).toHaveText(/^Draft the digest email · Weekly alert digest Exists · due Nov 20/);
    await expect(mine.getByTestId("cs-mark")).toHaveText("Exists");
    await expect(page.getByTestId("home-nothing-waits")).toHaveCount(0);
  });
}

/**
 * Card walkc-decisions-who-when-minutes: protects = a decision taken in a review meeting
 * ("Moved Weekly alert digest", in "Review: Usage alerts") shows on the item's sheet and on
 * Detailed's Plan item with who decided, when (month first) and a link to the meeting's
 * minutes, which opens them; fails_when = either shows the title alone or the Plan item
 * shows no decision; no_claim = decisions made outside a meeting (who and when, no minutes).
 */
for (const where of ["desktop", "phone"] as const) {
  test(`an item's decisions say who, when and link the minutes (${where})`, async ({ page }) => {
    const phone = where === "phone";
    if (phone) await page.setViewportSize(PHONE);
    await login(page);
    // Simple's Decisions page first: the meetings and their decisions are read there.
    await page.goto("/simple/decisions");
    await expect(page.getByText("Moved Weekly alert digest").first()).toBeVisible();
    await page.goto(URL);
    await page.getByTestId("format-gantt").click();
    await bar(page, "alert-digest").click();
    const card = page.getByTestId("floating-card");
    const decided = card.getByTestId("card-decided-in");
    await expect(decided).toContainText("Moved Weekly alert digest");
    const who = decided.getByTestId("decided-who").first();
    await expect(who).toContainText(/Decided by \S+.* · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
    const minutes = who.getByTestId("decided-minutes");
    await expect(minutes).toHaveText("Minutes of Review: Usage alerts");
    await expect(minutes).toHaveAttribute("href", /^\/simple\/meetings\/[0-9a-f-]+$/);
    const href = await minutes.getAttribute("href");
    await page.goto("/plan");
    const row = page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Daily alert digest email" });
    await row.getByTestId("plan-title").click();
    const panel = page.getByTestId(phone ? "sheet-plan-item" : "plan-inspector").filter({ visible: true });
    const list = panel.getByTestId("plan-decided");
    await expect(list).toContainText("Moved Weekly alert digest");
    await expect(list.getByTestId("decided-who").first()).toContainText(/Decided by \S+/);
    await expect(list.getByTestId("decided-minutes").first()).toHaveAttribute("href", href!);
    await tap(list.getByTestId("decided-minutes").first());
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole("region", { name: "Minutes" })).toBeVisible();
  });
}

/**
 * Card walkc-review-estimated-moved: protects = after a review meeting moves "Team invites"
 * (F-05, no dates of its own: estimated, as the API reads an undated item) to Later, its
 * Timeline bar and Gantt slice bars start where the Waterfall's bar does, in Later's window, not
 * at the plan's dates; fails_when = an estimated item's slices stay at the plan's dates
 * after a move; no_claim = how long the slices are drawn.
 */
for (const where of ["desktop", "phone"] as const) {
  test(`an estimated item moved in a review is drawn in its new horizon (${where})`, async ({ page }) => {
    await startReview(page);
    await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
    await tap(page.getByRole("button", { name: "Move Team invites to Later" }));
    await expect(page.getByTestId("roadmap-said")).toHaveText("Moved Team invites to Later.");
    if (where === "phone") await page.setViewportSize(PHONE);
    await page.goto(`${URL}?roadmap=onboarding-roadmap`);
    await expect(page.getByTestId("simple-chart")).toBeVisible();
    await page.getByTestId("format-waterfall").click();
    await expect(bar(page, "plan-f-05")).toHaveAttribute("data-kind", "estimated");
    const now = (await bar(page, "plan-f-05").getAttribute("data-start"))!;
    if (where === "desktop") {
      // The picked Timeline draws the item itself, not its slices: its bar starts there too.
      await page.getByTestId("format-timeline").click();
      await expect(timelineBar(page, "plan-f-05"), "timeline").toHaveAttribute("data-start", now);
    }
    await page.getByTestId("format-gantt").click();
    await expect(page.locator('g[data-testid="slice-bar"][data-code^="F-05"]').first(), "gantt").toHaveAttribute("data-start", now);
  });
}

/**
 * Card walkc-review-card-no-tasks: protects = an item with no tasks keeps the picked card
 * design: no "Tasks" part and no "No tasks yet" line, and with the card open a click on the
 * rail still goes to that page; fails_when = every card shows an empty Tasks part;
 * no_claim = a card with tasks (the test above).
 */
test("an item with no tasks shows no Tasks part on its card", async ({ page }) => {
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  // The page opens on the picked Timeline: an item's bar opens its card in the side panel.
  await timelineBar(page, "alert-rules").click();
  const card = page.getByTestId("item-panel").getByTestId("floating-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("Proposals on it")).toBeVisible();
  await expect(card.getByTestId("card-tasks")).toHaveCount(0);
  await expect(card.getByText("No tasks yet")).toHaveCount(0);
});
