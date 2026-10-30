import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * QA fixes on Simple's Home, its decision rows and its "Walk me through it" (mock-backed):
 * - qa-simple-home-3: one control moves a walk step on: Skip in the bar; no Next in the card.
 * - qa-simple-home-4: Home's decision row and the walk word the recommendation the same way, naming the document.
 * - qa-simple-home-5: the walk never calls a meeting "next" unless it is Home's Next review meeting, with its date.
 * - qa-simple-home-6: Another answer keeps the recommended answer offered (a chip) and the row's column as it was.
 * - qa-simple-home-7: skipping every step ends by saying what is left, with a way to start again.
 * - qa-simple-home-8: the walk's type box hint fits the step and a phone.
 * - qa-simple-home-28: Another answer closes on Escape or a click elsewhere; the chosen chip reads as chosen.
 * no_claim: the real API's walk (api/tests/test_simple_chat_api.py).
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

async function startWalk(page: Page): Promise<number> {
  await tap(page.getByRole("button", { name: "Walk me through it" }));
  const progress = page.getByTestId("walk-progress");
  await expect(progress).toHaveText(/^1 of \d+$/);
  return Number((await progress.textContent())!.split(" of ")[1]);
}

const step = (page: Page) => page.getByTestId("walk-step");

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** Walks every step, calling `each` on it, then Skip; returns the steps' kinds in order. */
async function skipAll(page: Page, total: number, each?: (kind: string, n: number) => Promise<void>): Promise<string[]> {
  const kinds: string[] = [];
  for (let n = 1; n <= total; n++) {
    await expect(page.getByTestId("walk-progress")).toHaveText(`${n} of ${total}`);
    const kind = (await step(page).getAttribute("data-kind"))!;
    kinds.push(kind);
    if (each) await each(kind, n);
    await tap(page.getByTestId("walk").getByRole("button", { name: "Skip" }));
  }
  await expect(page.getByTestId("walk-finished")).toBeVisible();
  return kinds;
}

test("qa-simple-home-3 and qa-simple-home-8: Skip is the one way on, and the type box hint fits the step on a phone", async ({ page }) => {
  // fails_when: a decision or agenda step's card has its own Next beside the bar's Skip, or the type box always hints "move Weekly alert digest to Q2" (cut on a phone)
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "simple-chat");
  const total = await startWalk(page);
  const kinds = await skipAll(page, total, async (kind) => {
    await expect(step(page).getByRole("button", { name: "Next" })).toHaveCount(0);
    const box = step(page).getByLabel("Or type what to do");
    const hint = (await box.getAttribute("placeholder"))!;
    expect(hint).not.toContain("Q2");
    if (kind === "decision") expect(hint).toBe("Or type your answer");
    // The whole hint shows in the box at 390 px.
    const fits = await box.evaluate((el: HTMLInputElement) => {
      const cs = getComputedStyle(el);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = cs.font;
      return ctx.measureText(el.placeholder).width <= el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });
    expect(fits, `"${hint}" fits its box`).toBe(true);
  });
  expect(kinds).toContain("decision");
  expect(kinds).toContain("agenda_decision");
});

test("qa-simple-home-4: Home's decision row and the walk say '<document> recommends: …' the same way", async ({ page }) => {
  // fails_when: Home's row says "PRD recommends" while the walk says "Guided setup recommends:"
  await signIn(page, "simple-home");
  const row = page.getByTestId("home-question").filter({ hasText: "Reminder default time" });
  const rec = row.locator(".simple-rec");
  await expect(rec).toHaveText("Guided setup recommends: 9:00 in each person's zone");
  const words = (await rec.textContent())!.trim();
  await startWalk(page);
  while ((await step(page).getAttribute("data-kind")) !== "decision") await tap(page.getByRole("button", { name: "Skip" }));
  await expect(step(page).getByTestId("walk-step-title")).toContainText("Reminder default time");
  await expect(step(page).getByTestId("walk-step-why")).toContainText(words);
});

test("qa-simple-home-5: the walk's agenda step agrees with Home's Next review meeting", async ({ page }) => {
  // fails_when: the agenda step says "On the next meeting's agenda" of a meeting that is not Home's Next review meeting
  await signIn(page, "simple-chat");
  const card = page.getByTestId("home-meeting");
  await expect(card.getByTestId("home-meeting-next").or(card.getByTestId("home-meeting-empty"))).toBeVisible();
  const next = card.getByTestId("home-meeting-next");
  const nextTitle = (await next.count()) ? ((await next.textContent()) ?? "") : "";
  await startWalk(page);
  while ((await step(page).getAttribute("data-kind")) !== "agenda_decision") await tap(page.getByRole("button", { name: "Skip" }));
  const kind = step(page).getByTestId("walk-step-kind");
  const words = (await kind.textContent())!;
  if (/next/i.test(words)) {
    // Named as the next meeting: Home's, by name, with its date.
    expect(nextTitle).not.toBe("");
    expect(nextTitle).toContain(words.split("next review meeting, ")[1]!.split(",")[0]!);
    expect(words).toMatch(/[A-Z][a-z]{2} \d{1,2}$/);
  } else {
    await expect(kind).toHaveText("On a meeting's agenda");
  }
});

test("qa-simple-home-6: Another answer keeps the recommended answer offered and the row's buttons as they were", async ({ page }) => {
  // fails_when: opening Another answer hides Decide as recommended, narrows the buttons' column or restyles its buttons
  await signIn(page, "simple-home");
  const row = page.getByTestId("home-question").filter({ hasText: "Reminder default time" });
  const column = row.locator(".simple-actions");
  const before = (await column.boundingBox())!;
  const ask = row.getByRole("button", { name: "Ask Oracle" });
  const askClass = await ask.getAttribute("class");
  await row.getByRole("button", { name: "Another answer" }).click();
  await expect(row.getByTestId("question-answers")).toBeVisible();
  await expect(row.getByRole("button", { name: "Decide as recommended" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Decide as recommended" })).toHaveClass(/simple-button-primary/);
  await expect(ask).toHaveAttribute("class", askClass!);
  const after = (await column.boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  // The recommended answer is a chip beside the others, and decides.
  const answers = row.getByRole("group", { name: /^Answers for / });
  await expect(answers.getByRole("button")).toHaveText(["9:00 in each person's zone (recommended)", "Noon", "Let each person pick", "Something else…"]);
  await answers.getByRole("button", { name: "9:00 in each person's zone (recommended)" }).click();
  await expect(page.getByText("Decided Q5: 9:00 in each person's zone")).toBeVisible();
});

test("qa-simple-home-28: Another answer closes on Escape or a click elsewhere; the chosen chip shows chosen", async ({ page }) => {
  // fails_when: the answers stay open after Escape or an outside click, or Something else… looks like the unchosen chips
  await signIn(page, "simple-home");
  const row = page.getByTestId("home-question").filter({ hasText: "Reminder default time" });
  const another = row.getByRole("button", { name: "Another answer" });
  await another.click();
  await expect(row.getByTestId("question-answers")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("question-answers")).toHaveCount(0);
  await expect(another).toHaveAttribute("aria-expanded", "false");
  await expect(another).toBeFocused();

  await another.click();
  await expect(row.getByTestId("question-answers")).toBeVisible();
  await page.getByTestId("home-greeting").click();
  await expect(row.getByTestId("question-answers")).toHaveCount(0);

  await another.click();
  const other = row.getByRole("button", { name: "Something else…" });
  const noon = row.getByRole("button", { name: "Noon", exact: true });
  await expect(other).toHaveAttribute("aria-pressed", "false");
  const unchosen = await other.evaluate((el) => getComputedStyle(el).borderStyle);
  await other.click();
  await expect(other).toHaveAttribute("aria-pressed", "true");
  await expect(noon).toHaveAttribute("aria-pressed", "false");
  await expect(row.getByLabel(/^Your answer to /)).toBeVisible();
  await page.mouse.move(0, 0);
  const [chosenBg, noonBg, chosenBorder] = await Promise.all([
    other.evaluate((el) => getComputedStyle(el).backgroundColor),
    noon.evaluate((el) => getComputedStyle(el).backgroundColor),
    other.evaluate((el) => getComputedStyle(el).borderStyle),
  ]);
  expect(chosenBg).not.toBe(noonBg);
  expect(chosenBorder).not.toBe(unchosen);
});

test("qa-simple-home-28: a press outside that drags (a text selection) still closes Another answer", async ({ page }) => {
  // fails_when: the answers close only on a click, so a press that ends away from where it began leaves them open
  await signIn(page, "simple-home");
  const row = page.getByTestId("home-question").filter({ hasText: "Reminder default time" });
  await row.getByRole("button", { name: "Another answer" }).click();
  await expect(row.getByTestId("question-answers")).toBeVisible();
  const greeting = (await page.getByTestId("home-greeting").boundingBox())!;
  await page.mouse.move(greeting.x + 2, greeting.y + greeting.height / 2);
  await page.mouse.down();
  await page.mouse.move(greeting.x + greeting.width - 2, greeting.y + greeting.height + 40, { steps: 8 });
  await page.mouse.up();
  await expect(row.getByTestId("question-answers")).toHaveCount(0);
});

test("qa-simple-home-7: skipping every step ends by saying what is left, and starts again from the first skipped", async ({ page }) => {
  // fails_when: the end says "That is everything for now." with "15 of 15" though nothing was decided, or offers no way back
  await signIn(page, "simple-home");
  const total = await startWalk(page);
  const kinds = await skipAll(page, total);
  const decisions = kinds.filter((k) => k === "decision" || k === "agenda_decision").length;
  const broken = kinds.filter((k) => k === "broken_link").length;
  const finished = page.getByTestId("walk-finished");
  await expect(finished).not.toContainText("That is everything");
  await expect(page.getByTestId("walk-progress")).toHaveCount(0);
  const left = page.getByTestId("walk-left");
  await expect(left).toContainText(`You skipped ${total}.`);
  if (decisions) await expect(left).toContainText(`${decisions} decision${decisions === 1 ? "" : "s"}`);
  if (broken) await expect(left).toContainText(`${broken} broken link${broken === 1 ? "" : "s"}`);
  await expect(left).toContainText(/still waits?\.$/);
  await tap(finished.getByRole("button", { name: "Start again from the first skipped" }));
  await expect(page.getByTestId("walk-progress")).toHaveText(`1 of ${total}`);
  await expect(step(page)).toHaveAttribute("data-kind", kinds[0]!);
});
