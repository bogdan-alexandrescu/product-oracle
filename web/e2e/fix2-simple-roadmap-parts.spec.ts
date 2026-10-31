import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Fix pass 2 on the simple roadmap's parts: the second QA round's findings, driven through
 * the UI against the mock.
 *
 * - qa-simple-roadmap-12/31/32 (FlowVisual, full screen): opening Comments shrinks the Steps
 *   list to fit beside the panel (no overlap); a note's PRD tie reads in plain words, never
 *   "PRD §"; Revise is really disabled (attribute and look) with no open comment.
 * - qa-simple-roadmap-51 (StartSheet): the attendee checkboxes are introduced in plain words.
 * - qa-simple-roadmap-26/35/45 (ChatCard): a move's Before/After reads month-first, like the
 *   rest of the app; Correct's close reads "Undo my edits"; a phone's four action buttons
 *   form a balanced 2-column grid, never three in a row and one alone.
 * - qa-simple-roadmap-24/44 (GoalSuggestions): "+ Suggest a feature" and "Suggest from the
 *   chat" look like buttons; a goal with no suggestions points to the action.
 * - qa-simple-roadmap-33 (key dates): a key date's day stays on one line.
 * - qa-simple-roadmap-46 (AppShell): the account panel's email line keeps the full address
 *   (and the name, when there is one) as a tooltip.
 */

const DESKTOP = { viewport: { width: 1366, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

test.describe("FlowVisual full screen", () => {
  test.use(DESKTOP);

  test("Comments shrinks the Steps list beside it, drops the PRD jargon, and Revise is really disabled", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    // The one-pager names a line by its first words (qa-simple-prd), not its number.
    await page.getByRole("button", { name: /^Flow for “A setup checklist that shows/ }).click();
    const opened = page.getByTestId("flow-detail");
    await expect(opened.getByTestId("flow-steps")).toBeVisible();
    await opened.getByRole("button", { name: "Full screen" }).click();
    const full = page.getByTestId("flow-fullscreen");
    await expect(full).toBeVisible();
    const steps = full.getByTestId("flow-steps");
    await expect(steps).toBeVisible();

    await full.getByRole("button", { name: "Comment" }).click();
    const panel = full.getByTestId("flow-comments-panel");
    await expect(panel).toBeVisible();

    // qa-simple-roadmap-12: the panel is an overlay on the right; the Steps list must end
    // before it starts, not run under it.
    const stepsBox = (await steps.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(stepsBox.x + stepsBox.width).toBeLessThanOrEqual(panelBox.x + 1);

    // qa-simple-roadmap-31: plain words, not the internal "PRD §ar"/"requirement" reference.
    // qa4-simple-prd-32: the section as the one-pager names it, with no requirement code.
    await expect(panel.getByTestId("flow-annotations")).toContainText("From “What we will build”");
    await expect(panel.getByTestId("flow-annotations")).not.toContainText("Requirement R1");
    await expect(page.locator("body")).not.toContainText("PRD §");
    await expect(page.locator("body")).not.toContainText("requirement R1");

    // qa-simple-roadmap-32: Revise reads disabled (the attribute and its look) with no open comment.
    const revise = panel.getByRole("button", { name: "Revise" });
    await expect(revise).toBeVisible();
    await expect(revise).toBeDisabled();
    await expect(revise).toHaveCSS("cursor", "not-allowed");
  });
});

test.describe("StartSheet", () => {
  test.use(DESKTOP);

  test("the attendee checkboxes are introduced in plain words, not just 'Attendees'", async ({ page }) => {
    await login(page);
    await page.goto("/simple/meetings");
    await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
    // qa-simple-decide-34: one verb, "Start review".
    await page.getByRole("button", { name: "Start review" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    // Plain words that fit people listed by name ("Commenter" is a person in the mock, not a role).
    const group = sheet.getByRole("group", { name: "Who attends" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("checkbox").first()).toBeVisible();
  });
});

/** The item's own talk (roadmap-talk's F-16 Adaptive pacing, 16 Nov - 27 Nov 2026), opened
 * the same on a desktop (a button) or a phone (a tab). */
async function openTalk(page: Page, phone: boolean): Promise<Locator> {
  await page.context().addInitScript(([key]) => localStorage.setItem(key, "roadmap-talk"), [MOCK_SCENARIO_KEY] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await openRoadmapItem(page, "adaptive-pacing");
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  if (phone) await card.getByRole("tab", { name: "Talk to Oracle" }).click();
  else await card.getByRole("button", { name: "Talk to Oracle" }).click();
  return card.getByTestId("item-talk");
}

/** Says `text` in the talk and returns its one new card. */
async function moveCard(page: Page, phone = false): Promise<Locator> {
  const talk = await openTalk(page, phone);
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill("move it two weeks later");
  await talk.getByRole("button", { name: "Send" }).click();
  const card = talk.getByTestId("chat-card");
  await expect(card).toHaveCount(1);
  return card;
}

test.describe("ChatCard", () => {
  test.use(DESKTOP);

  test("qa-simple-roadmap-26: the Before/After dates read month-first, like the rest of the app", async ({ page }) => {
    const card = await moveCard(page);
    const change = card.getByTestId("chat-card-change");
    await expect(change).toHaveText("Before: Nov 16 – Nov 27 → After: Nov 30 – Dec 11");
    // The day-first words the reader typed into the chat never show in the card's own line.
    await expect(change).not.toContainText("16 Nov");
    await expect(change).not.toContainText("30 Nov");
  });

  test("qa-simple-roadmap-35: Correct's close reads 'Undo my edits', not 'Keep Oracle's reading'", async ({ page }) => {
    const card = await moveCard(page);
    await card.getByRole("button", { name: "Change it…", exact: true }).click();
    await expect(card.getByRole("button", { name: "Undo my edits" })).toBeVisible();
    await expect(card.getByText("Keep Oracle's reading")).toHaveCount(0);
    await card.getByRole("button", { name: "Undo my edits" }).click();
    await expect(card.getByRole("button", { name: "Change it…", exact: true })).toBeVisible();
  });

  test("qa-simple-roadmap-45: the four action buttons form a balanced 2-column grid on a phone", async ({ page }) => {
    await page.setViewportSize(PHONE.viewport);
    const card = await moveCard(page, true);
    const preview = card.getByRole("button", { name: "Preview" });
    const apply = card.getByRole("button", { name: "Apply" });
    const reject = card.getByRole("button", { name: "Reject" });
    const correct = card.getByRole("button", { name: "Change it…", exact: true });
    for (const b of [preview, apply, reject, correct]) await expect(b).toBeVisible();
    const box = async (l: Locator) => {
      await l.scrollIntoViewIfNeeded();
      return (await l.boundingBox())!;
    };
    const [pBox, aBox, rBox, cBox] = [await box(preview), await box(apply), await box(reject), await box(correct)];
    // Preview and Apply share the first row; Reject and Correct share the next one (never one alone).
    expect(Math.abs(pBox.y - aBox.y)).toBeLessThan(2);
    expect(Math.abs(rBox.y - cBox.y)).toBeLessThan(2);
    expect(rBox.y).toBeGreaterThan(pBox.y + 5);
  });
});

test.describe("GoalSuggestions", () => {
  test.use(DESKTOP);

  test("qa-simple-roadmap-24/44: '+ Suggest a feature' and 'Ask Oracle in the chat' look like buttons; a goal with none points to the action", async ({ page, context }) => {
    await context.addInitScript(([key]) => localStorage.setItem(key, "simple-home"), [MOCK_SCENARIO_KEY]);
    await login(page);
    await page.goto("/simple");
    const quiet = page.getByTestId("home-goal").filter({ hasText: "Keep alerts quiet" });
    await quiet.getByTestId("goal-suggestions-open").click();
    const drawer = page.getByTestId("goal-panel");
    await expect(drawer).toBeVisible();

    const openForm = drawer.getByRole("button", { name: "+ Suggest a feature" });
    const chat = drawer.getByRole("button", { name: "Ask Oracle in the chat" });
    await expect(openForm).toBeVisible();
    await expect(chat).toBeVisible();
    // Before the fix these read as bare bold/underlined text (no border at all: 0px).
    await expect(openForm).toHaveCSS("border-width", "1px");
    await expect(chat).toHaveCSS("border-width", "1px");

    // Keep alerts quiet starts with no person-suggested feature (only Oracle's own, "auto").
    await expect(drawer.getByRole("tab", { name: "People · 0" })).toBeVisible();
    // QA pass 3 (qa-simple-plan-10): the drawer opens where the suggestions are; People is a click away.
    await drawer.getByRole("tab", { name: "People · 0" }).click();
    const empty = drawer.getByRole("tabpanel", { name: "People's suggestions" });
    await expect(empty).toContainText("No one has suggested a feature for Keep alerts quiet yet.");
    // QA pass 3 (qa-simple-plan-35): '+ Suggest a feature' is the one control that opens the form.
    await expect(drawer.getByTestId("suggest-first-feature")).toHaveCount(0);
    await expect(drawer.getByTestId("suggest-form")).toHaveCount(0);
    await openForm.click();
    await expect(drawer.getByTestId("suggest-form")).toBeVisible();
    await expect(drawer.getByTestId("suggest-form-open")).toHaveCount(0);
    // qa-simple-roadmap-24, qa-simple-plan-33: the form says what happens next; the owner decides themselves.
    await expect(drawer.getByTestId("suggest-decider")).toHaveText("You decide on this goal's suggestions: once sent, you can accept it below.");
  });
});

test.describe("Key dates", () => {
  test.use(DESKTOP);

  test("qa-simple-roadmap-33: a key date's day stays on one line next to its name", async ({ page }) => {
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("key-dates-open").click();
    const row = page.getByTestId("key-dates-editor").locator('[data-testid="key-date-row"][data-name="Customer conference"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText("Nov 14");
    const dateSpan = row.locator("span").filter({ hasText: "Nov" });
    await expect(dateSpan).toHaveCSS("white-space", "nowrap");
  });
});

test.describe("AppShell account panel", () => {
  test.use(DESKTOP);

  /** fix2 review (qa-simple-roadmap-46): the name and the whole email each on its own line,
   * wrapped, nothing cut off (not only a hover title). */
  test("qa-simple-roadmap-46: the account panel shows the name and the whole email, uncut", async ({ page }) => {
    await login(page);
    await page.getByTestId("user-menu").click();
    const panel = page.getByRole("dialog", { name: "Account" });
    const email = panel.getByText("admin@example.com", { exact: true });
    await expect(email).toBeVisible();
    await expect(panel.getByText("Admin", { exact: true })).toBeVisible();
    const cut = await email.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis");
    expect(cut).toBe(false);
  });

  test("qa-simple-roadmap-46: a member with no name on file sees the whole email, uncut", async ({ page }) => {
    await login(page, "viewer@example.com");
    await page.getByTestId("user-menu").click();
    const panel = page.getByRole("dialog", { name: "Account" });
    const viewer = panel.getByText("viewer@example.com", { exact: true });
    await expect(viewer).toBeVisible();
    expect(await viewer.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  });
});
