import { expect, type Locator, type Page } from "@playwright/test";

import { MOCK_LOGIN } from "../lib/api/mock/fixtures";

export const ADMIN = MOCK_LOGIN;

/** Signs in as the mock owner, or as the mock member with `email` (one per role). */
export async function login(page: Page, email: string = ADMIN.email) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
}

/** A section of the visible version (Next keeps recently visited routes mounted but hidden). */
export function section(page: Page, key: string): Locator {
  return page.locator(`section[data-section-key="${key}"]`).filter({ visible: true });
}

/** Selects `text` inside a section body, the way a reader would by dragging. */
export async function selectText(page: Page, key: string, text: string) {
  await page.evaluate(
    ({ key, text }) => {
      const body = [...document.querySelectorAll<HTMLElement>(`[data-section-body="${key}"]`)].find(
        (el) => el.checkVisibility(),
      )!;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const at = node.data.indexOf(text);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
      throw new Error(`"${text}" not found in section ${key}`);
    },
    { key, text },
  );
}

/** The version view's outline rail (>= 1280 px; one section is open at a time). */
export function sectionStrip(page: Page): Locator {
  return page.getByTestId("outline-rail").filter({ visible: true });
}

/** A section's row in the visible outline (rail, switcher popover or Sections sheet). */
export function outlineRow(page: Page, key: string): Locator {
  return page.locator(`a[data-outline-key="${key}"]`).filter({ visible: true });
}

/**
 * Opens a section of the current Brief / Full mode from the outline, and waits for its
 * panel. A row inside a folded chapter (or no rail, below 1280 px) is opened by its #key.
 */
export async function openSection(page: Page, key: string): Promise<Locator> {
  const row = outlineRow(page, key);
  if (await row.count()) await row.first().click();
  else await page.evaluate((k) => (window.location.hash = k), key);
  const s = section(page, key);
  await expect(s).toBeVisible();
  return s;
}

/** Opens a review panel tab (Feedback, Sources, History) in the visible panel. */
export async function openTab(page: Page, name: "Feedback" | "Sources" | "History") {
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).filter({ visible: true }).click();
}

/** Picks a Feedback state chip (Open, Staged, Declined, Done). */
export async function feedbackState(page: Page, state: "Open" | "Staged" | "Declined" | "Done") {
  await page.getByTestId("feedback-state").filter({ visible: true }).getByRole("button", { name: new RegExp(`^${state}`) }).click();
}

/** The review panel's feedback for every section, not only the open one. */
export async function showAll(page: Page) {
  await page.getByTestId("inspector-scope").filter({ visible: true }).getByRole("button", { name: /^All sections/ }).click();
}

/** Picks an item from the open section's ⋯ menu. */
export async function sectionAction(scope: Locator, heading: string, item: string | RegExp) {
  await scope.getByRole("button", { name: `Actions for ${heading}` }).click();
  await scope.getByRole("menuitem", { name: item }).click();
}

/**
 * Seeds the mock with what the adapter puts in the Inbox: a run whose lost submission is past
 * the lookup cap (Retry, Cancel run) and still looked for, a run whose output Oracle stopped
 * importing (Retry), and an ended run whose spend went over its ceiling while a workflow an
 * approver stopped cancelling still runs (Cancel again). Returns the overrun run's id.
 */
export async function seedStuckRuns(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type R = Record<string, unknown> & { id: string; document_slug: string; segments: Record<string, unknown>[] };
    const runs: R[] = db.runs.runs;
    const base = runs.find((r) => r.document_slug === "team-onboarding")!;
    const clone = (id: string, at: string): R => ({
      ...JSON.parse(JSON.stringify(base)),
      id,
      status: "running",
      checkpoints: [],
      waiting_on: null,
      created_at: at,
      started_at: at,
    });
    const lost = clone("7a11c0de-0000-4000-8000-000000000001", "2026-10-17T06:00:00Z");
    Object.assign(lost, {
      stuck: "Submission seg-1-a2 was lost and is still not found. Retry looks again; Cancel ends the run.",
      can_retry: true,
      searching: "Oracle still looks for submission seg-1-a1, given up on: if it landed, it is cancelled and its cost counted.",
    });
    const failed = clone("7a11c0de-0000-4000-8000-000000000002", "2026-10-17T07:00:00Z");
    failed.segments[0] = { ...failed.segments[0], status: "failed", error: "Couldn't import its output: DataError on 5 tries in a row." };
    Object.assign(failed, {
      import_failed:
        "Couldn't import team-onboarding's output: DataError on 5 tries in a row, and Oracle stopped trying. Retry tries again.",
      can_retry_import: true,
    });
    const done = runs.find((r) => r.document_slug === "checkout-redesign" && r.status === "succeeded")!;
    done.segments[0] = { ...done.segments[0], cost_usd: 16.4 };
    Object.assign(done, {
      spent_usd: 16.4,
      stuck:
        "After the run ended its spend reached $16.40, over its $13.50 ceiling: workflow mock-wf-done still runs in SwarmCloud, and Oracle counts its spend on the run until it ends. An approver stopped cancelling mock-wf-done: Cancel again turns Oracle's cancel calls back on (nothing restarts), or cancel it in SwarmCloud's console.",
      cancel_again: ["mock-wf-done"],
      can_dismiss_overrun: false,
    });
    runs.push(lost, failed);
    localStorage.setItem(key, JSON.stringify(db));
    return done.id;
  });
}
