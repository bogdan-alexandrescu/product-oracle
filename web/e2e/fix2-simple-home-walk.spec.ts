import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * QA fixes on Simple's Home and its "Walk me through it" (desktop, mock-backed):
 * - qa-onboarding-3: a new company (the "empty" scenario) has no plan, broken links or
 *   review meeting on Simple's Home, and the rail counts no meetings.
 * - qa-simple-home-3: the walk steps through as many broken links as Home's tile counts
 *   (one definition: every red flag with a fix).
 * - qa-simple-home-8: the walk covers the decisions waiting for you, as many as Home counts.
 * - qa-simple-home-7: a step names its item and says its problem once; its card holds the actions.
 * - qa-simple-home-33: Undo is off (and looks it) on the walk's first step.
 * no_claim: the real API's walk (api/tests/test_simple_chat_api.py), phones (same layout).
 */

async function signIn(page: Page, scenario: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

/** A summary tile's number, once it has loaded. */
async function tile(page: Page, id: "decisions" | "broken-links"): Promise<number> {
  const n = page.getByTestId(`home-summary-${id}`).locator(".simple-number");
  await expect(n).toHaveText(/^\d+$/);
  return Number(await n.textContent());
}

async function startWalk(page: Page): Promise<number> {
  await page.getByRole("button", { name: "Walk me through it" }).click();
  const progress = page.getByTestId("walk-progress");
  await expect(progress).toHaveText(/^1 of \d+$/);
  return Number((await progress.textContent())!.split(" of ")[1]);
}

const step = (page: Page) => page.getByTestId("walk-step");

/** Skips through every step from the first, returning each step's kind in order. */
async function walkKinds(page: Page, total: number): Promise<string[]> {
  const kinds: string[] = [];
  for (let n = 1; n <= total; n++) {
    await expect(page.getByTestId("walk-progress")).toHaveText(`${n} of ${total}`);
    kinds.push((await step(page).getAttribute("data-kind"))!);
    await page.getByRole("button", { name: "Skip" }).click();
    if (n < total) await expect(page.getByTestId("walk-progress")).toHaveText(`${n + 1} of ${total}`);
  }
  await expect(page.getByTestId("walk-finished")).toBeVisible();
  return kinds;
}

test("qa-onboarding-3: a new company's Simple Home has no plan, broken links or meeting, and no Meetings count", async ({ page }) => {
  // fails_when: the mock seeds Simple's roadmap, review rituals or meeting chat for a new company
  await signIn(page, "empty");
  await expect(page.getByTestId("home-goals-empty")).toBeVisible();
  await expect(page.getByTestId("home-plan-empty")).toBeVisible();
  await expect(page.getByTestId("home-strip")).toHaveCount(0);
  await expect(page.getByTestId("home-broken")).toHaveCount(0);
  expect(await tile(page, "broken-links")).toBe(0);
  await expect(page.getByTestId("home-sentence")).not.toContainText("broken link");
  await expect(page.getByTestId("home-meeting-empty")).toBeVisible();
  await expect(page.getByTestId("home-meeting-next")).toHaveCount(0);
  await expect(page.getByTestId("simple-nav-meetings")).toBeVisible();
  await expect(page.getByTestId("simple-nav-meetings-count")).toHaveCount(0);
  // Nothing to walk through either: no walk offered.
  await expect(page.getByTestId("home-sentence")).toHaveText("Nothing waits on you today.");
  await expect(page.getByRole("button", { name: "Walk me through it" })).toHaveCount(0);
});

test("qa-simple-home-3: the walk steps through as many broken links as Home counts", async ({ page }) => {
  // fails_when: Home counts only dependency flags while the walk also walks milestone and cut flags
  await signIn(page, "simple-home");
  const broken = await tile(page, "broken-links");
  expect(broken).toBeGreaterThan(2);
  await expect(page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "after its milestone" })).toHaveCount(1);
  const total = await startWalk(page);
  const kinds = await walkKinds(page, total);
  expect(kinds.filter((k) => k === "broken_link")).toHaveLength(broken);
});

test("qa-simple-home-8: the walk covers the decisions waiting for you", async ({ page }) => {
  // fails_when: the walk lists only the next meeting's agenda, not the decisions Home says wait on you
  await signIn(page, "simple-home");
  const waiting = await tile(page, "decisions");
  expect(waiting).toBeGreaterThan(0);
  const total = await startWalk(page);
  const kinds = await walkKinds(page, total);
  expect(kinds.filter((k) => k === "decision")).toHaveLength(waiting);
  // A decision step answers as the PRD recommends, and Undo takes it back.
  await page.getByRole("button", { name: "Done" }).click();
  await startWalk(page);
  while ((await step(page).getAttribute("data-kind")) !== "decision") await page.getByRole("button", { name: "Skip" }).click();
  const at = await page.getByTestId("walk-progress").textContent();
  const decide = step(page).getByRole("button", { name: /^Decide: / });
  await expect(decide).toBeVisible();
  await decide.click();
  await expect(page.getByText(/^Decided Q\d+: /)).toBeVisible();
  await expect(page.getByTestId("walk-progress")).not.toHaveText(at!);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone", { exact: true })).toBeVisible();
  await expect(step(page)).toHaveAttribute("data-kind", "decision");
});

test("qa-simple-home-7: a walk step says its problem once, under the item's name", async ({ page }) => {
  // fails_when: the step's subtitle, the card's title and its red line all repeat the reason, or the card says "Item:"
  await signIn(page, "simple-home");
  await startWalk(page);
  await expect(step(page)).toHaveAttribute("data-kind", "broken_link");
  const why = (await step(page).getByTestId("walk-step-why").textContent())!;
  expect(why.length).toBeGreaterThan(10);
  await expect(step(page).getByText(why)).toHaveCount(1);
  await expect(step(page).getByTestId("walk-step-title")).toHaveText("Weekly alert digest");
  const card = step(page).getByTestId("chat-card");
  await expect(card).not.toContainText("Item:");
  await expect(card.getByTestId("chat-card-summary")).toHaveCount(0);
  await expect(card.getByTestId("chat-card-flag")).toHaveCount(0);
  // Just the actions: the fixes, no Apply or Discard repeating them.
  await expect(card.getByTestId("chat-card-fix").first()).toBeVisible();
  await expect(card.getByRole("button", { name: /^(Apply|Discard)$/ })).toHaveCount(0);
});

test("qa-simple-home-33: Undo is off on the walk's first step until a step is answered or skipped", async ({ page }) => {
  // fails_when: Undo looks enabled (full opacity) or is enabled before anything was done
  await signIn(page, "simple-home");
  const total = await startWalk(page);
  const undo = page.getByTestId("walk").getByRole("button", { name: "Undo" });
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveCSS("opacity", "0.5");
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByTestId("walk-progress")).toHaveText(`2 of ${total}`);
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveCSS("opacity", "1");
  await undo.click();
  await expect(page.getByTestId("walk-progress")).toHaveText(`1 of ${total}`);
  await expect(undo).toBeDisabled();
});
