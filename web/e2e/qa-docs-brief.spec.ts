import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * QA pass 1, docs lane, the brief pages on the mock API: a brief before drafting
 * (/intakes/<id>) and a feature's tech brief (/briefs/<id>).
 *
 * qa-docs-19: the readiness title agrees with the critical questions below it, and an open
 * critical question has an Answer that opens it in the thread.
 * qa-docs-65: one actions menu, the back link with the shared chevron, no category line that
 * repeats the statement, days as "Oct 20", and the rail marks PRDs on the tech brief too.
 * qa-docs-36: the tech brief names modules, not module keys, in plain type, and its back link
 * and "Depends on" use titles, not slugs.
 */

/** The "before-drafting" mock scenario: one brief with two batches and a critical blocker. */
async function beforeDrafting(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "before-drafting");
    localStorage.setItem("po-interview-follow-up", "off");
  });
}

async function openIntake(page: Page) {
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("intake-inspector").filter({ visible: true });

test("qa-docs-19: the title agrees with the open critical questions, and each has an Answer", async ({ page }) => {
  await beforeDrafting(page);
  await login(page);
  await openIntake(page);
  const panel = inspector(page);
  // A critical blocker holds the draft: the title says so, never "Ready to draft?".
  await expect(panel).toContainText("Not ready to draft");
  await expect(panel).not.toContainText("Ready to draft?");

  // Decide the blocker: the draft may start, with the critical questions still open.
  const gate = panel.getByTestId("ready-to-draft");
  await gate.getByRole("button", { name: "Decide" }).click();
  await gate.getByRole("radio", { name: "Accept the risk" }).check();
  await gate.getByLabel("Rationale").fill("We ship behind the limit and watch it.");
  await gate.getByRole("button", { name: "Record decision" }).click();
  await expect(gate.getByTestId("missing-gap").first()).toBeVisible();
  await expect(panel).toContainText("Can draft, with gaps");
  await expect(panel).not.toContainText("None of them holds the draft");
  await expect(panel).not.toContainText("Ready to draft");

  // An asked critical question opens in the thread, its Answer focused.
  const answer = gate.getByRole("button", { name: /^Answer: / }).first();
  await expect(answer).toBeVisible();
  await page.getByRole("tab", { name: /Gaps/ }).click();
  await answer.click();
  await expect(page.getByRole("tab", { name: "Questions" })).toHaveAttribute("aria-selected", "true");
  // The question is on screen with the focus on it (on its Answer when it is asked of me).
  await expect(page.locator('[data-testid="question"]:focus, [data-testid="question"]:has(:focus)')).toBeInViewport();
});

test("qa-docs-65: one actions menu, the shared back link, no repeated category, US day format", async ({ page }) => {
  await beforeDrafting(page);
  await login(page);
  await openIntake(page);
  const header = page.locator("[data-page-header]");
  await expect(header.getByRole("button", { name: /^Actions for / })).toHaveCount(1);
  await expect(header.getByRole("button", { name: /More actions|^Delete/ })).toHaveCount(0);
  const back = header.getByRole("link", { name: "PRDs" });
  await expect(back).toBeVisible();
  await expect(back).not.toContainText("‹");
  await expect(back.locator("svg")).toHaveCount(1);
  await header.getByRole("button", { name: /^Actions for / }).click();
  await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Batch lines read "Oct 20", as every other page writes a day.
  await expect(page.getByTestId("batch").first()).toContainText(/asked Oct \d+/);

  // A gap whose statement starts with its category does not repeat the category below it.
  const blocker = inspector(page).getByTestId("blocking-gap");
  await expect(blocker).toContainText("Blockers: not known yet.");
  expect((await blocker.innerText()).match(/Blockers/g)).toHaveLength(1);
});

async function openTechBrief(page: Page, title: string) {
  await page.goto("/documents/checkout-redesign");
  await page.getByTestId("tech-briefs").getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

test("qa-docs-36: the tech brief names modules and the PRD in words; the rail marks PRDs", async ({ page }) => {
  await login(page);
  await openTechBrief(page, "Show the full price early");

  const touches = page.getByRole("table", { name: "What it touches" });
  await expect(touches.getByRole("columnheader", { name: "In the code map" })).toBeVisible();
  const row = touches.getByRole("row", { name: /web\/checkout\/summary/ });
  await expect(row).toContainText("Checkout web");
  await expect(row).not.toContainText("module:");
  await expect(touches.getByRole("row", { name: /GET \/v1\/quotes/ })).toContainText("Not mapped");
  await expect(page.getByTestId("brief-touches")).toContainText("Reuses Pricing");
  await expect(page.getByTestId("brief-touches")).not.toContainText("module:pricing");
  // Nothing in a code font.
  expect(await page.getByTestId("brief-touches").locator(".font-mono").count()).toBe(0);
  expect(await page.getByTestId("brief-code-map").locator(".font-mono").count()).toBe(0);

  // The back link names the PRD by its title.
  const back = page.locator("[data-page-header]").getByRole("link", { name: "Checkout redesign PRD v2" });
  await expect(back).toHaveAttribute("href", "/documents/checkout-redesign");

  // An unanswered question says where it was left open.
  await expect(page.getByTestId("brief-question-q2")).toContainText("Not answered at the Engineering check");

  // qa-docs-65: the rail marks PRDs here too.
  await expect(page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
});

test("qa-docs-36: Depends on names the feature, not its key", async ({ page }) => {
  await login(page);
  await openTechBrief(page, "Keep form state on back navigation");
  await expect(page.getByTestId("brief-size")).toContainText("Depends on Show the full price early");
  await expect(page.getByTestId("brief-size")).not.toContainText("price-early");
});
