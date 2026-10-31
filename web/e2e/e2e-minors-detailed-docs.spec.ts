import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { gateReason, openCriticalCount, type Summary } from "../app/intakes/[id]/_lib";
import { login } from "./helpers";

/*
 * Production minors, detailed docs lane, on the mock API and driven as a person: a feature's
 * tech brief (/briefs/<id>), New PRD (/documents/new) and the brief before drafting
 * (/intakes/<id>). Each test runs on a desktop and on a phone.
 *
 * - 18: a brief written for an older PRD version links the PRD as it is now and says
 *   "written for v1", never naming v1 as the PRD's.
 * - 19: an approach's list reads as a list.
 * - 20: a brief written on assumptions says "Not mapped: see assumptions".
 * - 21: no internal file names or question codes reach readers.
 * - 22: the recommendation card is never greyed while a new one is on its way.
 * - 23: the side panel names the template the brief chose.
 * - 24: an answered critical question waiting for review says so.
 * - 25: a "Who answers" pick stays when the list is read again.
 * - 26: an answer sent while Oracle reads the one before waits for it, never fails.
 * - 27: Defer shows "Deferred · Undo", and Undo asks it again.
 * - 28: the answer box does not repeat the question; an answer reads "Your answer".
 */

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const;

const ANSWER_ME = "Which metric shows this worked, what is its value today, and what target by when?";
const GOAL = "Which confirmed company goal";
const LONG = "Repeat checkout time is 95 seconds today and we want 45 seconds by March next year.";

async function openTechBrief(page: Page, title: string) {
  await page.goto("/documents/checkout-redesign");
  await page.getByTestId("tech-briefs").getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

async function beforeDrafting(page: Page, followUp: "on" | "off" = "off") {
  await page.addInitScript((f) => {
    localStorage.setItem("po-mock-scenario", "before-drafting");
    localStorage.setItem("po-interview-follow-up", f);
  }, followUp);
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const bubble = (page: Page, prompt: string): Locator => page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: prompt });

/** The brief's side panel: in the right column, or the sheet behind "Show details" on a phone. */
async function sidePanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("intake-inspector").filter({ visible: true });
  if ((page.viewportSize()?.width ?? 1440) <= 600 && !(await panel.count())) {
    await page.getByRole("button", { name: "Show details" }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

for (const [name, viewport] of VIEWPORTS) {
  test.describe(name, () => {
    test.use({ viewport });

    test(`18-21: a brief for v1 says so, lists its approach, points to its assumptions and shows no codes (${name})`, async ({ page }) => {
      await login(page);
      await openTechBrief(page, "Keep form state on back navigation");

      // 18: the PRD is at v2 now; the link opens it and says the brief was written for v1.
      const back = page.locator("[data-page-header]").getByRole("link", { name: /Checkout redesign PRD/ });
      await expect(back).toContainText("Checkout redesign PRD v2 · written for v1");
      await expect(back).toHaveAttribute("href", "/documents/checkout-redesign");

      // 19: the approach's steps are a list of three, not " - " inside one paragraph.
      const approach = page.getByTestId("brief-approach");
      await expect(approach.getByRole("listitem")).toHaveCount(3);
      await expect(approach.getByRole("listitem").first()).toHaveText("Save the fields when a step is left");
      await expect(approach).not.toContainText(" - ");

      // 20: nothing mapped, because the brief rests on assumptions.
      await expect(page.getByTestId("brief-touches")).toContainText("Not mapped: see assumptions");
      await expect(page.getByTestId("brief-touches")).not.toContainText("Nothing listed");

      // 21: the mitigation names the question in words; no file name, no question code.
      const risks = page.getByTestId("brief-risks");
      await expect(risks).toContainText("see “How long does a checkout session last” and an open question");
      await expect(risks).not.toContainText("questions.json");
      await expect(risks).not.toContainText("otr-q1");
      // Review minors 21: a code in capitals reads as its question too.
      await expect(risks).not.toContainText("OTR-Q1");
      await expect(risks).not.toContainText("src-q1");
    });

    test(`review 19: an approach with " - " asides reads as one paragraph, not a list (${name})`, async ({ page }) => {
      await login(page);
      await openTechBrief(page, "Show the full price early");
      const approach = page.getByTestId("brief-approach");
      await expect(approach).toContainText("as soon as the cart changes - before tax is known - and show it in the checkout summary");
      await expect(approach.getByRole("listitem")).toHaveCount(0);
    });

    test(`22: the recommendation is not greyed while a new one is on its way (${name})`, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("po-mock-slow", "POST /v1/drafts/recommend");
        localStorage.setItem("po-mock-slow-ms", "4000");
      });
      await login(page);
      await page.goto("/documents/new?kind=prd");
      await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeAttached();
      const panel = page.getByTestId("recommendation-panel");
      await expect(panel.getByTestId("recommended-template")).toBeVisible({ timeout: 15_000 });

      // An answer to "About this PRD": the next recommendation is slow to come.
      await page.getByText("Commit to building it", { exact: true }).click();
      await expect(panel).toHaveAttribute("aria-busy", "true");
      await expect(panel).toHaveCSS("opacity", "1");
    });

    test(`23: the side panel names the template the new PRD chose (${name})`, async ({ page }) => {
      await login(page);
      await page.goto("/documents/new?kind=prd");
      await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
      await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype their address at every checkout.");
      const onePager = page.getByTestId("template-option-one-pager");
      await onePager.click();
      await expect(onePager.getByRole("radio")).toBeChecked();
      await page.getByTestId("new-prd-continue-end").click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);

      const panel = await sidePanel(page);
      await expect(panel.getByTestId("intake-template")).toContainText("One-pager");
      await expect(panel.getByTestId("intake-template")).not.toContainText("Goal-traced PRD");
    });

    test(`24: an open critical question says where it stands, and the counts agree (${name})`, async ({ page }) => {
      await beforeDrafting(page);
      // The goal question goes to research: asked, and still open.
      const goal = bubble(page, GOAL);
      await goal.getByRole("button", { name: "Answer", exact: true }).click();
      await goal.getByRole("button", { name: "Research this" }).click();
      await expect(goal.getByTestId("answer")).toBeVisible();

      const panel = await sidePanel(page);
      // Decide the blocker: the draft may start, with the critical questions still open.
      const gate = panel.getByTestId("ready-to-draft");
      await gate.getByRole("button", { name: "Decide" }).click();
      await gate.getByRole("radio", { name: "Accept the risk" }).check();
      await gate.getByLabel("Rationale").fill("We ship behind the limit and watch it.");
      await gate.getByRole("button", { name: "Record decision" }).click();
      const missing = gate.getByTestId("missing-gap");
      await expect(missing.first()).toBeVisible();

      // "Critical open" counts the very list the chip and the lines read.
      const n = await missing.count();
      await expect(panel.getByTestId("stat-critical")).toContainText(String(n));
      await expect(gate).toContainText(`${n} critical question${n === 1 ? "" : "s"} open`);
      // The asked one says where it stands, never "Not asked yet".
      const researched = missing.filter({ hasText: /goal alignment/i });
      await expect(researched).toContainText("Being researched.");
      await expect(researched).not.toContainText("Not asked yet");
    });

    test(`25: a "Who answers" pick stays after another answer refreshes the list (${name})`, async ({ page }) => {
      await beforeDrafting(page);
      const next = page.getByTestId("next-questions");
      const select = next.getByRole("combobox", { name: /^Who answers: / }).first();
      await expect(select).toBeVisible();
      const label = await select.getAttribute("aria-label");
      const current = await select.inputValue();
      const other = (await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).find((v) => v !== current)!;
      await select.selectOption(other);

      // Another answer in the thread: the page reads its questions again.
      const mine = bubble(page, ANSWER_ME);
      await mine.getByRole("button", { name: "Answer", exact: true }).click();
      await mine.getByLabel("Your answer").fill(LONG);
      await mine.getByRole("button", { name: "Send answer" }).click();
      await expect(mine.getByTestId("answer")).toBeVisible();

      await expect(next.getByRole("combobox", { name: label! })).toHaveValue(other);
    });

    test(`26: an answer sent while Oracle reads the one before waits for it (${name})`, async ({ page }) => {
      await beforeDrafting(page, "on");
      await expect(page.getByTestId("follow-up-switch")).toBeVisible();
      // My team interview, opened by the page; its turns come back slowly, as Oracle reads.
      const teamInterview = () =>
        page.evaluate((intake) => {
          const db = JSON.parse(localStorage.getItem("po-mock-db-v2") ?? "{}");
          const all: { id: string; kind: string; intake_id: string }[] = db.interviews?.interviews ?? [];
          return all.find((i) => i.kind === "team" && i.intake_id === intake)?.id ?? null;
        }, BEFORE_DRAFTING.intakeId);
      await expect.poll(teamInterview).not.toBeNull();
      const id = await teamInterview();
      await page.evaluate((path) => {
        localStorage.setItem("po-mock-slow", path);
        localStorage.setItem("po-mock-slow-ms", "2500");
      }, `POST /v1/interviews/${id}/turns`);

      const first = bubble(page, ANSWER_ME);
      await first.getByRole("button", { name: "Answer", exact: true }).click();
      await first.getByLabel("Your answer").fill(LONG);
      await first.getByRole("button", { name: "Send answer" }).click();
      await expect(first.getByTestId("oracle-typing")).toBeVisible();

      // The second answer, while Oracle still reads the first.
      const second = bubble(page, GOAL);
      await second.getByRole("button", { name: "Answer", exact: true }).click();
      await second.getByLabel("Your answer").fill("It serves the faster checkout goal, by cutting the time returning buyers spend on the address.");
      await second.getByRole("button", { name: "Send answer" }).click();

      await expect(first.getByTestId("answer")).toBeVisible({ timeout: 15_000 });
      await expect(second.getByTestId("answer")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Something went wrong|Please wait a moment/)).toHaveCount(0);
    });

    test(`27: Defer shows Deferred with Undo, and Undo asks it again (${name})`, async ({ page }) => {
      await beforeDrafting(page);
      const q = bubble(page, GOAL);
      await q.getByRole("button", { name: "Answer", exact: true }).click();
      await q.getByRole("button", { name: "Defer" }).click();

      const deferred = q.getByTestId("question-deferred");
      await expect(deferred).toContainText("Deferred");
      await expect(q.getByRole("button", { name: /^Undo defer: / })).toBeVisible();

      await q.getByRole("button", { name: /^Undo defer: / }).click();
      await expect(deferred).toHaveCount(0);
      await expect(q.getByRole("button", { name: "Answer", exact: true })).toBeVisible();
    });

    test(`28: the answer box does not repeat the question, and my answer reads "Your answer" (${name})`, async ({ page }) => {
      await beforeDrafting(page);
      const q = bubble(page, ANSWER_ME);
      await q.getByRole("button", { name: "Answer", exact: true }).click();
      const form = q.getByTestId("answer-question");
      await expect(form.getByLabel("Your answer")).toBeVisible();
      await expect(form.getByTestId("answer-prompt")).toHaveCount(0);
      await expect(q.getByText(ANSWER_ME, { exact: true })).toHaveCount(1);

      await form.getByLabel("Your answer").fill(LONG);
      await form.getByRole("button", { name: "Send answer" }).click();
      const answer = q.getByTestId("answer");
      await expect(answer).toContainText("Your answer");
      await expect(answer).not.toContainText("Your decision");
    });
  });
}

test("review minors 24: the critical count is never under the server's, so the gate reason never reads 0", () => {
  // The server counts a critical question this page does not list: its count stands.
  const s = { readiness: { open_critical: 2, blocking_gap_ids: ["g-1"] }, gaps: [{ importance: "critical", status: "unknown" }] } as unknown as Summary;
  expect(openCriticalCount(s)).toBe(2);
  expect(gateReason(1, openCriticalCount(s))).toMatch(/^2 critical/);
});
