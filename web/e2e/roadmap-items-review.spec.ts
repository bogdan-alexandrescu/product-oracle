import { expect, test, type Page } from "@playwright/test";

import fixture from "../lib/api/mock/checkpoint-review.json";
import { ROADMAP_FILE_PROBLEM_RUN, ROADMAP_REVIEW_RUN, ROADMAP_REVIEW_RUN_ATTEMPT2, routeRuns, type RunsContext } from "../lib/api/mock/runs";
import { MOCK_REVIEW_CHANGE_KEY } from "../lib/api/mock/server";
import { login, openSeeded, seedRoadmapAttempt2, seedRoadmapFileProblem, seedRoadmapReview } from "./helpers";

// D1 Roadmap items review (/runs/<id>/review/<checkpoint>): the seeded roadmap review run
// (ROADMAP_REVIEW_RUN: nine items, three blocking reasons, a dropped item) on the mock.

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;

// D1 draws E2's ItemsTable and ItemInspector (no second table): their rows and inspector.
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const pick = (page: Page, key: string) => row(page, key).locator('[data-phone="title"]').click();
const inspector = (page: Page) => page.getByTestId("roadmap-item-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");

async function open(page: Page) {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
}

// Card entry: protects = criterion 1, the run page's Review items and the Inbox's row open
// the review screen and Back returns to the run; fails_when = any of them opens the run page's
// panel instead; no_claim = the other kinds' places.
test("the run page and the Inbox open the review screen; Back returns to the run", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, `/runs/${RUN}`);
  // The run page shows a summary only: counts, Review items and the Raw file; no decision panel.
  const summary = page.getByTestId("items-review-line");
  await expect(summary).toContainText("10 need you · 3 blocking");
  await expect(page.getByRole("group", { name: "Decide: Roadmap items" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and continue" })).toHaveCount(0);
  await expect(page.getByLabel("Note for the agents")).toHaveCount(0);
  await summary.getByRole("button", { name: "Raw file" }).click();
  await expect(page.getByTestId("sheet-raw-file").getByTestId("raw-file-content")).toContainText("slack-alerts");
  await page.getByTestId("sheet-raw-file").getByRole("button", { name: "Close" }).click();
  // The header's Decide opens the review screen.
  await page.getByRole("main").getByRole("link", { name: "Decide", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${SCREEN}$`));
  await page.goto("/runs");
  // The runs list's Decide opens it too.
  await page.getByTestId("run-row").filter({ hasText: /usage-alerts-roadmap(?!-)/ }).getByRole("button", { name: "Decide" }).click();
  await expect(page).toHaveURL(new RegExp(`${SCREEN}$`));
  await page.goto(`/runs/${RUN}`);
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page).toHaveURL(new RegExp(`${SCREEN}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await page.getByRole("link", { name: "Roadmap from an approved PRD from Usage alerts PRD v1" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));

  await page.goto("/inbox");
  await page.locator(`a[href="${SCREEN}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`${SCREEN}$`));
  await expect(page.getByTestId("review-status")).toHaveText(/Waiting for you · 19 h left/);
});

// Card filters: protects = criterion 2, Needs you lists exactly the items with an open reason
// grouped by horizon with "k of n need you", All lists every item, Changed hides on attempt 1;
// fails_when = a fine item under Needs you, a missing one, or Changed shown; no_claim = reasons.
test("Needs you lists the items with an open reason by horizon; All lists every item", async ({ page }) => {
  await open(page);
  const keys = async () => page.getByTestId("roadmap-item-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
  expect(await keys()).toEqual(["slack-alerts", "budget-caps", "usage-export", "webhooks", "cost-forecast", "sso-login", "anomaly-detection", "mobile-push", "invoice-pdf", "weekly-digest"]);
  await expect(page.getByTestId("group-head").first()).toHaveText("Now · 4 of 4 need you");
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 8 to confirm");
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Changed/ })).toHaveCount(0);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^All/ }).click();
  await expect(page.getByTestId("roadmap-item-row")).toHaveCount(10);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Needs you/ }).click();
  // Every chip and sentence is whole at 1366 px: nothing cut with an ellipsis.
  await page.setViewportSize({ width: 1366, height: 900 });
  const clipped = await page.getByTestId("reason-chip").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  expect(clipped).toBe(0);
  // The table and the inspector fit the page (the app shell's own 1 px Ask Oracle strip aside).
  const table = page.getByTestId("roadmap-items-table");
  expect(await table.evaluate((t) => t.scrollWidth <= t.clientWidth)).toBe(true);
  await expect(page.getByTestId("items-table")).toHaveCount(0);
  expect(await inspector(page).evaluate((e) => e.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
});

// Card remove-date: protects = criteria 4 and 5, one click stages Remove date (row done with
// Undo, date struck, tally and chip), a reload keeps it, Undo restores the row; fails_when = it is
// not staged on the server or Undo leaves it; no_claim = applying it (D7).
test("Remove date stages the edit, survives a reload, and Undo restores the row", async ({ page }) => {
  await open(page);
  const slack = row(page, "slack-alerts");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("0 of 10 handled");
  await slack.getByRole("button", { name: "Remove date", exact: true }).click();
  await expect(slack.getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await expect(slack.locator("s", { hasText: "Nov 30, 2026" })).toBeVisible();
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 of 10 handled");
  await expect(bar(page).getByTestId("staged-chip")).toHaveText(["Slack alerts: date removed"]);
  await page.reload();
  await expect(row(page, "slack-alerts").getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await row(page, "slack-alerts").getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true })).toBeVisible();
  await expect(bar(page).getByTestId("staged-chip")).toHaveCount(0);
});

// Card gate: protects = criterion 6, Approve is disabled with "{b} blocking left" while blocking
// reasons are open and reads "Approve with n edits" once each is fixed or waived; then criterion 7,
// approving shows "Approved with n edits" and Agents' file the original; fails_when = Approve
// enabled early, or a dialog/decision missing; no_claim = the real gate's computation.
test("blocking reasons hold Approve; fixed or waived it approves with edits", async ({ page }) => {
  await open(page);
  const approve = bar(page).getByRole("button", { name: /^Approve/ });
  await expect(approve).toBeDisabled();
  await expect(bar(page).getByTestId("decision-tally")).toContainText("3 blocking left");
  await row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true }).click();
  await row(page, "budget-caps").getByRole("button", { name: "Move to Later", exact: true }).click();
  await row(page, "usage-export").getByRole("button", { name: "More actions for Usage export" }).click();
  await page.getByRole("menuitem", { name: "Waive…" }).click();
  await page.getByTestId("roadmap-items-table").getByLabel("Why waive it").fill("The export section lands in the next PRD version");
  await page.getByTestId("roadmap-items-table").getByRole("button", { name: "Waive", exact: true }).click();
  await expect(row(page, "usage-export").getByTestId("row-done")).toHaveText(/✓ Waived/);
  await expect(approve).toHaveText("Approve with 2 edits");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByTestId("review-status")).toHaveText("Approved with 2 edits");
  await page.getByRole("button", { name: "Agents' file" }).click();
  await expect(page.getByTestId("raw-file-content")).toContainText("date: 2026-11-30");
  await page.getByTestId("sheet-raw-file").getByRole("button", { name: "Close" }).click();
  // The run continues to the roadmap draft.
  await page.getByRole("link", { name: "Roadmap from an approved PRD from Usage alerts PRD v1" }).click();
  await expect(page.getByTestId("segment-roadmap_draft").getByTestId("segment-state")).toHaveText("Running");
});

// Card send-back: protects = criterion 8, Send back with two staged actions lists "2 entries"
// in its confirm sheet and the page then reads "Sent back · 2 entries"; fails_when = no confirm,
// a wrong count, or the state missing; no_claim = the review file's text (D4).
test("Send back lists its entries and shows the sent-back state", async ({ page }) => {
  await open(page);
  await row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true }).click();
  await row(page, "anomaly-detection").getByRole("button", { name: "Accept", exact: true }).click();
  await expect(bar(page).getByTestId("staged-chip")).toHaveCount(2);
  await bar(page).getByRole("button", { name: "Send back to agents" }).click();
  const sheet = page.getByTestId("sheet-send-back");
  await expect(sheet).toContainText("2 entries");
  await sheet.getByRole("button", { name: "Send back", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText("Sent back · 2 entries");
  // The run re-runs the roadmap items: attempt 2 running.
  await page.getByRole("link", { name: "Roadmap from an approved PRD from Usage alerts PRD v1" }).click();
  const items = page.getByTestId("segment-roadmap_items");
  await expect(items).toContainText("attempt 2");
  await expect(items.getByTestId("segment-state")).toHaveText("Running");
});

// Card summary-count: protects = the run page's "{n} need you" counts only the items still
// needing a person; fails_when = a handled item still counts; no_claim = the Inbox's counts (D9).
test("the run page's summary counts only the items still needing a person", async ({ page }) => {
  await open(page);
  await row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true }).click();
  await expect(row(page, "slack-alerts").getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await page.goto(`/runs/${RUN}`);
  await expect(page.getByTestId("items-review-line")).toContainText("9 need you · 2 blocking");
});

// Card split: protects = criterion 9, a staged Split disables Approve with "Split needs the agents"
// and Send back stays enabled; fails_when = Approve enabled; no_claim = the agents' split.
test("a staged Split disables Approve; Send back stays enabled", async ({ page }) => {
  await open(page);
  await row(page, "webhooks").getByRole("button", { name: "More actions for Webhooks" }).click();
  await page.getByRole("menuitem", { name: "Split…" }).click();
  await page.getByLabel("Split into").fill("Webhook setup\nWebhook retries");
  await page.getByRole("button", { name: "Stage split" }).click();
  await expect(bar(page).getByTestId("approve-blocked")).toContainText("Split needs the agents");
  await expect(bar(page).getByRole("button", { name: /^Approve/ })).toBeDisabled();
  await expect(bar(page).getByRole("button", { name: "Send back to agents" })).toBeEnabled();
});

// Card inspector: protects = criterion 12, the inspector's Horizon, Outcome and Depends on stage
// their edits, and From the PRD links to the section; fails_when = an edit is not staged or the
// link is wrong; no_claim = the PRD's text.
test("the inspector stages horizon, outcome and dependency edits", async ({ page }) => {
  await open(page);
  await pick(page, "budget-caps");
  const insp = inspector(page);
  await expect(insp).toContainText("Item 3 of 9 · selected");
  await insp.getByRole("group", { name: "Horizon" }).getByRole("button", { name: "Next" }).click();
  await expect(bar(page).getByTestId("staged-chip")).toContainText(["Budget caps: moved to Next"]);
  await insp.getByRole("button", { name: "Edit outcome" }).click();
  await insp.getByRole("textbox", { name: "Outcome" }).fill("No team overspends its monthly budget");
  await insp.getByRole("button", { name: "Save" }).click();
  await expect(bar(page).getByTestId("staged-chip")).toContainText(["Budget caps: outcome edited"]);
  await insp.getByRole("button", { name: "Remove dependency Anomaly detection" }).click();
  await expect(bar(page).getByTestId("staged-chip")).toContainText(["Budget caps: dependency removed"]);
  await expect(insp.getByRole("link", { name: "alerts-caps" })).toHaveAttribute("href", "/documents/usage-alerts/v/1#alerts-caps");
});

// Card attempt-2: protects = criterion 13, Changed lists the diff items with the old value struck
// and each resolution chip, and a declined change is under Needs you; fails_when = a missing diff
// or chip; no_claim = how D6 computes them.
test("attempt 2: Changed lists the diff with resolutions; a declined change needs me", async ({ page }) => {
  await login(page);
  const run = ROADMAP_REVIEW_RUN_ATTEMPT2.run;
  await openSeeded(page, seedRoadmapAttempt2, `/runs/${run.id}/review/${run.checkpoints[1].id}`);
  await expect(row(page, "mobile-push")).toContainText("Change declined");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Changed/ }).click();
  await expect(row(page, "slack-alerts").getByTestId("resolution-chip")).toHaveText("Done");
  await expect(row(page, "invoice-pdf").locator("s")).toContainText("Finance downloads each invoice");
  await expect(row(page, "usage-export").getByTestId("resolution-chip")).toHaveText("Done");
});

// Card file-problem: protects = criterion 14, a file that cannot be read as items shows one error
// card with Send back enabled and Approve disabled; fails_when = a table is drawn or Approve is
// enabled; no_claim = the problem codes' wording.
test("a file Oracle cannot read shows the error card; only Send back", async ({ page }) => {
  await login(page);
  const run = ROADMAP_FILE_PROBLEM_RUN.run;
  await openSeeded(page, seedRoadmapFileProblem, `/runs/${run.id}/review/${run.checkpoints[0].id}`);
  const card = page.getByTestId("file-problems");
  await expect(card).toContainText("Oracle can't read this file as items");
  await expect(card).toContainText("not valid YAML");
  await expect(page.getByTestId("roadmap-item-row")).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: /^Approve/ })).toBeDisabled();
  await expect(bar(page).getByRole("button", { name: "Send back to agents" })).toBeEnabled();
});

// Card stale: protects = criterion 15, a decide over a changed review shows "The review changed
// since you loaded it" with Reload and decides nothing; fails_when = it decides; no_claim = who.
test("a stale decision shows the review changed, with Reload", async ({ page }) => {
  await open(page);
  await row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true }).click();
  await row(page, "budget-caps").getByRole("button", { name: "Move to Later", exact: true }).click();
  await row(page, "usage-export").getByRole("button", { name: "More actions for Usage export" }).click();
  await page.getByRole("menuitem", { name: "Waive…" }).click();
  await page.getByTestId("roadmap-items-table").getByLabel("Why waive it").fill("Lands in the next PRD version");
  await page.getByTestId("roadmap-items-table").getByRole("button", { name: "Waive", exact: true }).click();
  await page.evaluate((key) => localStorage.setItem(key, "commenter@example.com"), MOCK_REVIEW_CHANGE_KEY);
  await bar(page).getByRole("button", { name: /^Approve/ }).click();
  await expect(bar(page).getByTestId("review-changed")).toContainText("The review changed since you loaded it");
  await expect(page.getByTestId("review-status")).toHaveText(/Waiting for you/);
  await bar(page).getByRole("button", { name: "Reload" }).click();
  await expect(bar(page).getByTestId("review-changed")).toHaveCount(0);
});

// Card keyboard: protects = criterion 16, ↑/↓ move the selection and Tab reaches a row's actions;
// fails_when = the keys do nothing; no_claim = contrast (the design system's tokens).
test("arrow keys move the selection; Tab reaches the row actions", async ({ page }) => {
  await open(page);
  await row(page, "slack-alerts").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "budget-caps")).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page)).toContainText("Budget caps");
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "slack-alerts")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true })).toBeFocused();
});

// Card back: protects = criterion 1's Back, a control of its own on the review screen (not only
// the breadcrumb) returns to the run; fails_when = there is no Back, or it opens another page;
// no_claim = the browser's own back button.
test("the review screen's Back returns to the run", async ({ page }) => {
  await open(page);
  await page.getByRole("main").getByRole("link", { name: "Back to run", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
});

/** WCAG's contrast ratio of two CSS colours (rgb()/rgba() strings, alpha ignored). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The focused element's focus ring: its style, width and colour, and the colour it sits on. */
async function ring(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const css = getComputedStyle(el);
    // The ring is drawn outside the element (offset): it sits on the nearest painted ancestor.
    let bg = "rgba(0, 0, 0, 0)";
    for (let p = el.parentElement; p; p = p.parentElement) {
      const c = getComputedStyle(p).backgroundColor;
      if (c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) {
        bg = c;
        break;
      }
    }
    return { style: css.outlineStyle, width: parseFloat(css.outlineWidth), color: css.outlineColor, bg, name: el.textContent?.trim() ?? "" };
  });
}

async function expectVisibleFocus(page: Page, name: string | RegExp) {
  const r = await ring(page);
  expect(r.name).toMatch(name);
  expect(r.style, `${r.name}: focus outline`).not.toBe("none");
  expect(r.width, `${r.name}: focus outline width`).toBeGreaterThanOrEqual(2);
  // WCAG 1.4.11: a focus indicator is at least 3:1 against what it sits on.
  expect(contrast(r.color, r.bg), `${r.name}: ${r.color} on ${r.bg}`).toBeGreaterThanOrEqual(3);
}

// Card keyboard-decide: protects = criterion 16, Enter on a row offers the row's first fix as a
// Confirm button with focus (no single-key decisions) and Enter on Confirm stages it; Tab
// reaches every button of the bottom bar (the staged chips' Undo, Send back, Approve) and Enter
// on Approve decides; the focus ring is visible with at least 3:1 contrast in the light and
// dark themes; fails_when = Enter on a row stages by itself or does nothing, a bar button is
// skipped by Tab, or the ring is missing or too faint; no_claim = screen readers.
test("Enter on a row asks to confirm its first fix; the bar's buttons are reached and used by keyboard", async ({ page }) => {
  await open(page);
  await row(page, "slack-alerts").focus();
  await page.keyboard.press("Enter");
  const confirm = row(page, "slack-alerts").getByRole("button", { name: "Confirm: Remove date" });
  await expect(confirm).toBeFocused();
  // The row's Enter alone stages nothing.
  await expect(bar(page).getByTestId("staged-chip")).toHaveCount(0);
  await expectVisibleFocus(page, /^Confirm: Remove date/);
  await page.keyboard.press("Enter");
  await expect(row(page, "slack-alerts").getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await expect(bar(page).getByTestId("staged-chip")).toHaveCount(1);
  // Escape leaves the confirm without staging.
  await row(page, "budget-caps").focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "budget-caps").getByRole("button", { name: /^Confirm: / })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row(page, "budget-caps").getByRole("button", { name: /^Confirm: / })).toHaveCount(0);
  await expect(row(page, "budget-caps")).toBeFocused();
  await expect(bar(page).getByTestId("staged-chip")).toHaveCount(1);

  // The other two blocking reasons, so Approve opens.
  await row(page, "budget-caps").getByRole("button", { name: "Move to Later", exact: true }).click();
  await row(page, "usage-export").getByRole("button", { name: "More actions for Usage export" }).click();
  await page.getByRole("menuitem", { name: "Waive…" }).click();
  await page.getByTestId("roadmap-items-table").getByLabel("Why waive it").fill("The export section lands in the next PRD version");
  await page.getByTestId("roadmap-items-table").getByRole("button", { name: "Waive", exact: true }).click();
  const approve = bar(page).getByRole("button", { name: "Approve with 2 edits" });
  await expect(approve).toBeEnabled();

  // From the note, Tab reaches Send back then Approve; Shift+Tab goes back to each chip's Undo.
  await bar(page).getByLabel("Note to the agents").focus();
  await page.keyboard.press("Tab");
  await expect(bar(page).getByRole("button", { name: "Send back to agents" })).toBeFocused();
  await expectVisibleFocus(page, "Send back to agents");
  await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await expectVisibleFocus(page, "Approve with 2 edits");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectVisibleFocus(page, "Approve with 2 edits");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(bar(page).getByLabel("Note to the agents")).toBeFocused();
  const undos = bar(page).getByRole("button", { name: /^Undo / });
  await expect(undos).toHaveCount(3);
  for (let i = 2; i >= 0; i--) {
    await page.keyboard.press("Shift+Tab");
    await expect(undos.nth(i)).toBeFocused();
  }
  await expectVisibleFocus(page, "");
  // Back to Approve, and Enter decides.
  for (let i = 0; i < 5; i++) await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("review-status")).toHaveText("Approved with 2 edits");
});

// Card contract: protects = criterion 18 (the mock's half), the mock's review route answers in
// the shared fixture's shapes (lib/api/mock/checkpoint-review.json, which
// api/tests/test_checkpoint_review_contract.py checks against the API); fails_when = a field is
// missing or retyped in the mock; no_claim = the real API (the contract test).
test("the mock's review route answers in the shared fixture's shapes", async () => {
  const db = { runs: [structuredClone(ROADMAP_REVIEW_RUN.run)], artifacts: { ...ROADMAP_REVIEW_RUN.artifacts } };
  let n = 0;
  const ctx = {
    db,
    userId: "u1",
    feedback: [],
    documents: [],
    latestVersion: () => null,
    sectionKeys: () => [],
    sourceVersion: () => "none",
    importDraft: () => ({}) as never,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => "2026-10-20T10:00:00Z",
  } as unknown as RunsContext;
  const call = async (method: string, tail: string, body?: unknown) => {
    const url = `http://mock/v1/runs/${RUN}/checkpoints/${CP}/${tail}`;
    const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
    const res = (await routeRuns(ctx, req, new URL(url).pathname.split("/").slice(1)))!;
    return { status: res.status, json: await res.json() };
  };
  await call("POST", "actions", { item_key: "slack-alerts", kind: "edit", field: "milestone_date", value: null, answers: ["unverified_date"] });
  const got = (await call("GET", "review")).json;
  const kind = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  const same = (mine: Record<string, unknown>, want: Record<string, unknown>, where: string) => {
    for (const key of Object.keys(want)) {
      expect(key in mine, `${where}.${key}`).toBe(true);
      if (mine[key] !== null && want[key] !== null) expect(kind(mine[key]), `${where}.${key}`).toBe(kind(want[key]));
    }
  };
  same(got, fixture.review, "review");
  const slack = got.items.find((i: { key: string }) => i.key === "slack-alerts");
  same(slack, fixture.review.items[0], "item");
  same(slack.reasons[0], fixture.review.items[0].reasons[0], "reason");
  same(slack.actions[0], fixture.review.items[0].actions[0], "action");
  same(got.tally, fixture.review.tally, "tally");
  same(got.gate, fixture.review.gate, "gate");
  // The decide 409s: blocking_open with the gate shut, review_changed on an older revision.
  const shut = await call("POST", "decide", { decision: "approved", expected_revision: got.revision });
  expect(shut.status).toBe(409);
  same(shut.json.detail, fixture.conflicts[shut.json.detail.code as keyof typeof fixture.conflicts], "conflict");
  const stale = await call("POST", "decide", { decision: "approved", expected_revision: 0 });
  expect(stale.json.detail.code).toBe("review_changed");
  same(stale.json.detail, fixture.conflicts.review_changed, "review_changed");
});
