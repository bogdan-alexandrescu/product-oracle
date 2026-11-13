import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * agenda-sheet (mk-edit-meetings-tracks, proposal b, the owner's pick Nov 5): in a live
 * review of the invented Usage alerts PRD (the mock's "meeting-agenda-sheet" scenario: Alert
 * rules engine decided, Weekly alert digest now, Dana Whitfield's topic added, Alert history
 * export skipped; Priya Raman decides the PRD), the strip says Now, Next and Item 2 of 5 and
 * Edit agenda opens the Agenda sheet. The owner adds a topic and a feature, renames, reorders
 * by arrows and by drag, removes with Undo; Dana (an approver, not the decider) proposes and
 * the proposal waits for Priya, whose Accept she can Undo; an op of Dana's proposal whose item
 * the owner removed since is left out, and the proposal (or Priya's Accept) says "1 left out";
 * Undo is for the last change only (two tabs, owner and Priya); a viewer reads; on a phone
 * the sheet is a bottom sheet.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page): Promise<string> {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Usage alerts PRD" })).toBeVisible();
  return page.url();
}

/** Signs out from Home's account menu and signs in as another member; the mock's data stays. */
async function switchTo(page: Page, email: string, url: string) {
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.goto(url);
}

const strip = (page: Page) => page.getByTestId("agenda-strip");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Agenda" });
const rows = (page: Page) => sheet(page).getByTestId("agenda-row");
// simple-home-qa-nov12 #2: a feature's code chip (F-06) leads its name; the order is read by names.
const names = async (page: Page) => (await rows(page).locator("p:first-child").allInnerTexts()).map((t) => t.replace(/\s*(✓|skipped)\s*$/, "").replace(/^F-\d+[a-j]?\s?/, "").trim());

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "meeting-agenda-sheet"), MOCK_SCENARIO_KEY);
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the owner adds a topic and a feature, renames, reorders by arrows and drag, removes with Undo", async ({ page }) => {
    test.setTimeout(90_000);
    await startReview(page);
    await expect(strip(page)).toContainText(/Now: F-06\s?Weekly alert digest/);
    await expect(strip(page)).toContainText("Next: Mobile alert push");
    await expect(strip(page)).toContainText("Item 2 of 5");
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    const s = sheet(page);
    await expect(s).toBeVisible();
    expect(await names(page)).toEqual(["Alert rules engine", "Weekly alert digest", "Mobile alert push", "Quiet hours for muted teams", "Alert history export"]);
    // Done and current items are fixed; the item after Now has no up arrow, the last no down arrow.
    await expect(rows(page).nth(0).getByRole("button", { name: /^(Move|Rename|Remove)/ })).toHaveCount(0);
    await expect(rows(page).nth(1).getByRole("button", { name: /^(Move|Rename|Remove)/ })).toHaveCount(0);
    await expect(s.getByRole("button", { name: "Move Mobile alert push up" })).toHaveCount(0);
    await expect(s.getByRole("button", { name: "Move Alert history export down" })).toHaveCount(0);
    await expect(rows(page).nth(3)).toContainText("5 min · topic · added by Dana Whitfield");

    // Up by the arrow.
    await tap(s.getByRole("button", { name: "Move Quiet hours for muted teams up" }));
    await expect.poll(() => names(page)).toEqual(["Alert rules engine", "Weekly alert digest", "Quiet hours for muted teams", "Mobile alert push", "Alert history export"]);
    // Rename in place.
    await tap(s.getByRole("button", { name: "Rename Quiet hours for muted teams" }));
    await s.getByLabel("Item name").fill("Quiet hours by default");
    await tap(s.getByRole("button", { name: "Save" }));
    await expect(rows(page).nth(2)).toContainText("Quiet hours by default");
    // A typed topic and a feature: four features of the PRD are not on the agenda yet.
    for (const f of ["Alert routing by team", "Alert snooze", "Spend limit alerts", "Alert email templates"]) await expect(s.getByRole("button", { name: `+ ${f}` })).toBeVisible();
    await s.getByLabel("Add a feature or a topic").fill("Beta date sign-off");
    await s.getByLabel("Add a feature or a topic").press("Enter");
    await expect(rows(page).last()).toContainText("Beta date sign-off");
    await expect(rows(page).last()).toContainText("5 min · topic · added by Avery Stone");
    await tap(s.getByRole("button", { name: "+ Alert routing by team" }));
    await expect(rows(page).last()).toContainText("Alert routing by team");
    await expect(s.getByRole("button", { name: "+ Alert routing by team" })).toHaveCount(0);
    // Down by dragging: Mobile alert push dropped on the last row.
    await rows(page).filter({ hasText: "Mobile alert push" }).dragTo(rows(page).last());
    await expect.poll(async () => (await names(page)).at(-1)).toBe("Mobile alert push");
    // Remove: it goes, with Undo (port-an-decisions: and waits in Settings › Trash).
    await tap(s.getByRole("button", { name: "Remove Alert history export" }));
    await expect.poll(() => names(page)).not.toContain("Alert history export");
    await page.keyboard.press("Escape");
    await expect(s).toBeHidden();
    const done = page.getByTestId("agenda-done");
    await expect(done).toContainText("Moved Quiet hours for muted teams up and renamed it, added Beta date sign-off, added Alert routing by team, moved Mobile alert push down and removed Alert history export.");
    await expect(strip(page)).toContainText("Next: Quiet hours by default · topic");
    await expect(strip(page)).toContainText("Item 2 of 6");
    await tap(done.getByRole("button", { name: "Undo" }));
    await expect(done).toBeHidden();
    await expect(strip(page)).toContainText("Next: Mobile alert push");
    await expect(strip(page)).toContainText("Item 2 of 5");
  });

  test("an approver who is not the decider proposes; the proposal waits for Priya Raman", async ({ page }) => {
    test.setTimeout(90_000);
    const url = await startReview(page);
    await switchTo(page, "dana.whitfield@example.com", url);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    const s = sheet(page);
    await expect(s.getByText("Waits for Priya Raman")).toBeVisible();
    await tap(s.getByRole("button", { name: "Rename Quiet hours for muted teams" }));
    await s.getByLabel("Item name").fill("Quiet hours by default");
    await tap(s.getByRole("button", { name: "Propose" }));
    // The agenda stays as it is until Priya accepts.
    await expect(rows(page).nth(3)).toContainText("Quiet hours for muted teams");
    await page.keyboard.press("Escape");
    const line = page.getByTestId("agenda-proposal");
    await expect(line).toContainText("Proposed");
    await expect(line).toContainText("Waits for Priya Raman");
    await tap(line.getByRole("button", { name: "About What is proposed" }));
    await expect(page.getByText("Renamed Quiet hours for muted teams to Quiet hours by default.")).toBeVisible();
    await expect(strip(page)).toContainText("Next: Mobile alert push");

    // Priya, the decider, accepts it.
    await switchTo(page, "approver@example.com", url);
    await tap(page.getByTestId("agenda-proposal").getByRole("button", { name: "Accept" }));
    await expect(page.getByTestId("agenda-proposal")).toBeHidden();
    // The accept is Priya's own change: its Undo line shows to her.
    const done = page.getByTestId("agenda-done");
    await expect(done).toContainText("Renamed Quiet hours for muted teams to Quiet hours by default.");
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    await expect(rows(page).nth(3)).toContainText("Quiet hours by default");
    await page.keyboard.press("Escape");
    await tap(done.getByRole("button", { name: "Undo" }));
    await expect(done).toBeHidden();
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    await expect(rows(page).nth(3)).toContainText("Quiet hours for muted teams");
  });

  test("an approver's proposal leaves out an op whose item was removed since, and says so", async ({ page }) => {
    test.setTimeout(120_000);
    const url = await startReview(page);
    await switchTo(page, "dana.whitfield@example.com", url);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    // A move and a rename of one item: when left out, they read as one.
    await tap(sheet(page).getByRole("button", { name: "Move Quiet hours for muted teams up" }));
    await tap(sheet(page).getByRole("button", { name: "Rename Quiet hours for muted teams" }));
    await sheet(page).getByLabel("Item name").fill("Quiet hours by default");
    await tap(sheet(page).getByRole("button", { name: "Propose" }));
    await expect(sheet(page).getByLabel("Item name")).toHaveCount(0);
    await expect(page.getByTestId("agenda-proposal")).toBeVisible();

    // The owner removes the topic Dana's proposal moves and renames.
    await switchTo(page, "admin@example.com", url);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    await tap(sheet(page).getByRole("button", { name: "Remove Quiet hours for muted teams" }));
    await expect.poll(() => names(page)).not.toContain("Quiet hours for muted teams");

    // Dana's next op still goes through; the line says "1 left out", the detail behind the (i).
    await switchTo(page, "dana.whitfield@example.com", url);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    await sheet(page).getByLabel("Add a feature or a topic").fill("Help text");
    await sheet(page).getByLabel("Add a feature or a topic").press("Enter");
    await page.keyboard.press("Escape");
    const line = page.getByTestId("agenda-proposal");
    await expect(line.getByTestId("agenda-dropped")).toHaveText("1 left out");
    await tap(line.getByRole("button", { name: "About What was left out" }));
    await expect(page.getByText("The item was removed since: Moved Quiet hours for muted teams up and renamed it.")).toBeVisible();
    await page.keyboard.press("Escape");
    await tap(line.getByRole("button", { name: "About What is proposed" }));
    await expect(page.getByText("Added Help text.")).toBeVisible();
  });

  test("the decider's Accept says which ops it left out, since their item was removed", async ({ page }) => {
    test.setTimeout(120_000);
    const url = await startReview(page);
    await switchTo(page, "dana.whitfield@example.com", url);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    await tap(sheet(page).getByRole("button", { name: "Rename Quiet hours for muted teams" }));
    await sheet(page).getByLabel("Item name").fill("Quiet hours by default");
    await tap(sheet(page).getByRole("button", { name: "Propose" }));
    await expect(sheet(page).getByLabel("Item name")).toHaveCount(0);
    await sheet(page).getByLabel("Add a feature or a topic").fill("Help text");
    await sheet(page).getByLabel("Add a feature or a topic").press("Enter");
    await expect(sheet(page).getByLabel("Add a feature or a topic")).toHaveValue("");

    // The owner removes the topic before Priya accepts.
    await switchTo(page, "admin@example.com", url);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    await tap(sheet(page).getByRole("button", { name: "Remove Quiet hours for muted teams" }));
    await expect.poll(() => names(page)).not.toContain("Quiet hours for muted teams");

    await switchTo(page, "approver@example.com", url);
    await tap(page.getByTestId("agenda-proposal").getByRole("button", { name: "Accept" }));
    const done = page.getByTestId("agenda-done");
    await expect(done).toContainText("Added Help text.");
    await expect(done.getByTestId("agenda-left-out")).toHaveText("1 left out");
    await tap(done.getByRole("button", { name: "About What was left out" }));
    await expect(page.getByText("The item was removed since: Renamed Quiet hours for muted teams to Quiet hours by default.")).toBeVisible();
  });

  test("Undo is for the last change only: another person's change hides your Undo line, and a stale Undo says so", async ({ page, context }) => {
    test.setTimeout(120_000);
    const url = await startReview(page);
    // Priya, the decider, in a second tab of the same browser (the mock's data is shared there).
    // Her tab does not poll the meeting, so her Undo line is still up after the owner's change.
    const priya = await context.newPage();
    await priya.addInitScript(() => {
      const every = window.setInterval;
      window.setInterval = ((f: TimerHandler, ms?: number, ...rest: unknown[]) => (ms === 5_000 ? 0 : every(f, ms, ...rest))) as typeof window.setInterval;
    });
    await priya.goto("/home");
    await signOut(priya);
    await login(priya, "approver@example.com");
    await priya.goto(url);

    const addTopic = async (tab: Page, title: string) => {
      await tap(strip(tab).getByRole("button", { name: "Edit agenda" }));
      await sheet(tab).getByLabel("Add a feature or a topic").fill(title);
      await sheet(tab).getByLabel("Add a feature or a topic").press("Enter");
      await expect.poll(() => names(tab)).toContain(title);
      await tab.keyboard.press("Escape");
    };

    await page.bringToFront();
    await addTopic(page, "Owner topic");
    await expect(page.getByTestId("agenda-done")).toContainText("Added Owner topic.");
    await priya.bringToFront();
    await addTopic(priya, "Decider topic");
    await expect(priya.getByTestId("agenda-done")).toContainText("Added Decider topic.");
    // The owner's page reads Priya's change: their Undo is not the last change now.
    await page.bringToFront();
    await expect(page.getByTestId("agenda-done")).toBeHidden({ timeout: 15_000 });

    // The owner changes the agenda again; Priya's Undo line is stale.
    await addTopic(page, "Second owner topic");
    await priya.bringToFront();
    const done = priya.getByTestId("agenda-done");
    await expect(done).toContainText("Added Decider topic.");
    await tap(done.getByRole("button", { name: "Undo" }));
    await expect(priya.getByText(/Someone changed the agenda since/)).toBeVisible();
    // The agenda is read again at once: the stale line goes, and the owner's work stays.
    await expect(done).toBeHidden({ timeout: 3_000 });
    await tap(strip(priya).getByRole("button", { name: "Edit agenda" }));
    await expect.poll(() => names(priya)).toEqual(expect.arrayContaining(["Owner topic", "Decider topic", "Second owner topic"]));
  });

  test("a viewer reads the agenda with no controls", async ({ page }) => {
    const url = await startReview(page);
    await switchTo(page, "viewer@example.com", url);
    await expect(strip(page)).toContainText("Item 2 of 5");
    await tap(strip(page).getByRole("button", { name: "See agenda" }));
    const s = sheet(page);
    await expect(s.getByText("View only")).toBeVisible();
    await expect(rows(page)).toHaveCount(5);
    await expect(s.getByRole("button", { name: /^(Move|Rename|Remove)/ })).toHaveCount(0);
    await expect(s.getByLabel("Add a feature or a topic")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the Agenda sheet is a bottom sheet with arrows and no drag", async ({ page }) => {
    await startReview(page);
    await tap(strip(page).getByRole("button", { name: "Edit agenda" }));
    const s = sheet(page);
    await expect(s).toBeVisible();
    const box = (await s.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(840);
    expect(box.width).toBeGreaterThan(380);
    await expect(rows(page).filter({ hasText: "Mobile alert push" })).not.toHaveAttribute("draggable", "true");
    await tap(s.getByRole("button", { name: "Move Quiet hours for muted teams up" }));
    await expect.poll(() => names(page)).toEqual(["Alert rules engine", "Weekly alert digest", "Quiet hours for muted teams", "Mobile alert push", "Alert history export"]);
  });
});
