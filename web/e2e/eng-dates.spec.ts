import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ENG_DATES_RUN, ENG_DATES_WAITING_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * F4 Engineering review stop, lane B: the Engineering dates of Baseline to PRD. After the PRD
 * review, the engineering lead accepts, changes or marks No date on each proposed date of the
 * draft's Now items, on its own review screen. On the mock layer, driven as a person would.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const row = (page: Page, key: string) => page.locator(`[data-testid="date-row"][data-item="${key}"]`);
const bar = (page: Page) => page.getByTestId("decision-bar");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Draft with Oracle" });

async function openDatesAsLead(page: Page) {
  await withScenario(page, "eng-dates");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering dates" });
  await expect(inboxRow.getByTestId("checkpoint-label")).toHaveText("Engineering dates · usage-alerts · 4 Now items · 3 to decide");
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("date-row")).toHaveCount(4);
}

const accept = (page: Page, key: string) => row(page, key).getByRole("button", { name: "Accept", exact: true }).click();

async function noDate(page: Page, key: string, reason: string) {
  await row(page, key).getByRole("button", { name: "No date", exact: true }).click();
  const dialog = page.getByTestId("date-none");
  await dialog.getByRole("textbox", { name: "Reason" }).fill(reason);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, key).getByTestId("date-decision")).toHaveText("No date");
}

test("inbox and accept: the lead's row counts the Now items and dates to decide, Review opens the screen, Accept decides a row", async ({ page }) => {
  // protects=the Inbox summary and Review of an eng_dates stop, and Accept as a staged choice; fails_when=the row miscounts, Review opens the run page, or Accept leaves the row "Decide" or the tally unmoved; no_claim=the API's D9 summaries (api tests).
  await openDatesAsLead(page);
  await expect(bar(page).getByTestId("dates-tally")).toHaveText("0 of 3 decided · 3 to decide");
  await expect(row(page, "shipping-step").getByTestId("date-proposed")).toHaveText("Nov 30 · est-shipping-step");
  await expect(row(page, "shipping-step").getByTestId("date-reasons")).toHaveText("Date not decided yet");
  await expect(row(page, "cart-review").getByTestId("date-proposed")).toContainText("No date proposed");
  await expect(row(page, "cart-review").getByTestId("date-reasons")).toHaveText("");
  await expect(row(page, "shipping-step").getByTestId("date-decision")).toHaveText("Decide");
  // The row's More is an icon, never a text glyph: without a font that has the glyph,
  // Chromium crashed the lead's screen before it drew (#590 review, blocker 1).
  const more = row(page, "shipping-step").getByRole("button", { name: "More for Shipping step" });
  await expect(more.locator("svg")).toHaveCount(1);
  await expect(more).toHaveText("");
  await accept(page, "shipping-step");
  await expect(row(page, "shipping-step").getByTestId("date-decision")).toHaveText("Accepted");
  await expect(row(page, "shipping-step").getByTestId("date-reasons")).toHaveText("");
  await expect(bar(page).getByTestId("dates-tally")).toHaveText("1 of 3 decided · 2 to decide");
  // Nothing is lost on refresh: the choices are the shared draft's.
  await page.reload();
  await expect(row(page, "shipping-step").getByTestId("date-decision")).toHaveText("Accepted");
});

test("change: the dialog opens pre-filled from the proposal and saves another basis", async ({ page }) => {
  // protects=Change pre-fills kind, reference and date from the proposal and saves a changed basis; fails_when=the fields are empty, a missing reference saves, or the row does not read "Changed" with the new date; no_claim=the API's 422 wording.
  await openDatesAsLead(page);
  await row(page, "saved-addresses").getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByTestId("date-change");
  await expect(page.getByRole("dialog", { name: "Change the date: Saved addresses" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Kind" })).toHaveValue("capacity");
  await expect(dialog.getByRole("textbox", { name: "Reference" })).toHaveValue("cap-q4-checkout");
  await expect(dialog.getByRole("textbox", { name: "Date", exact: true })).toHaveValue("2026-12-11");
  await dialog.getByRole("combobox", { name: "Kind" }).selectOption("estimate");
  await dialog.getByRole("textbox", { name: "Reference" }).fill("");
  await expect(dialog.getByRole("button", { name: "Save date" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Reference" }).fill("ENG-412");
  await dialog.getByRole("textbox", { name: "Date", exact: true }).fill("2026-12-18");
  await dialog.getByRole("button", { name: "Save date" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "saved-addresses").getByTestId("date-decision")).toHaveText("Changed");
  await expect(row(page, "saved-addresses").getByTestId("date-proposed")).toContainText("Now Dec 18 · ENG-412");
});

test("no date: a reason is required before it saves", async ({ page }) => {
  // protects=No date needs a reason; fails_when=Save is enabled with an empty reason or the row does not read "No date" with the reason; no_claim=the API's validation (api tests).
  await openDatesAsLead(page);
  await row(page, "price-early").getByRole("button", { name: "No date", exact: true }).click();
  const dialog = page.getByTestId("date-none");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("   ");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Waits on the pricing service rewrite");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "price-early").getByTestId("date-decision")).toHaveText("No date");
  await expect(row(page, "price-early")).toContainText("Waits on the pricing service rewrite");
});

test("approve: Approve waits for every dated Now row, then the run succeeds", async ({ page }) => {
  // protects=the D3 gate on date_undecided and Approve ending the run; fails_when=Approve opens while a proposed date is undecided, or the run does not succeed after it; no_claim=the verified bases on the PRD's Roadmap tab (not modelled in the mock).
  await openDatesAsLead(page);
  const approve = bar(page).getByRole("button", { name: "Approve" });
  await expect(approve).toBeDisabled();
  await accept(page, "shipping-step");
  await noDate(page, "price-early", "Waits on the pricing service rewrite");
  await expect(bar(page).getByTestId("dates-tally")).toHaveText("2 of 3 decided · 1 to decide");
  await expect(approve).toBeDisabled();
  await accept(page, "saved-addresses");
  await expect(bar(page).getByTestId("dates-tally")).toHaveText("3 of 3 decided");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${ENG_DATES_RUN}$`));
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Succeeded");
  await expect(page.getByTestId("segment-eng_dates").getByTestId("segment-state")).toHaveText("Succeeded");
});

test("next and later: only in the collapsed read-only group, with no date actions", async ({ page }) => {
  // protects=Next and Later items carry no dates (O4) and no actions; fails_when=they show as rows, the group is open on arrival, or it offers Accept, Change or No date; no_claim=the Roadmap shape rules themselves.
  await openDatesAsLead(page);
  for (const key of ["guest-checkout", "saved-cards", "gift-wrap"]) await expect(row(page, key)).toHaveCount(0);
  const others = page.getByTestId("dates-others");
  await expect(others.locator("summary")).toHaveText("Next 2 · Later 1 · no dates (O4 Roadmap shape)");
  await expect(others.getByTestId("dates-other").first()).toBeHidden();
  await others.locator("summary").click();
  await expect(others.getByTestId("dates-other")).toHaveCount(3);
  await expect(others.getByTestId("dates-other").filter({ hasText: "Gift wrap" })).toContainText("Later");
  await expect(others.getByRole("button")).toHaveCount(0);
});

test("approver, lead named: the screen never decides and says it waits for the engineering lead", async ({ page }) => {
  // protects=who does not decide never sees Approve or Send back, and the screen names the lead; fails_when=Approve or Send back shows or the waits-for line is missing; no_claim=the API's may_decide rule (api tests).
  await withScenario(page, "eng-dates");
  await login(page, "approver@example.com");
  await page.goto(`/runs/${ENG_DATES_RUN}`);
  const line = page.getByTestId("segment-eng_dates").getByTestId("review-screen-line");
  await expect(line).toContainText("4 Now items · 3 to decide");
  await expect(line).toContainText("Waits for the engineering lead");
  await line.getByRole("link", { name: "View" }).click();
  await expect(page.getByTestId("view-only")).toContainText("Waits for the engineering lead");
  await expect(page.getByTestId("date-row")).toHaveCount(4);
  await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Send back to architect" })).toHaveCount(0);
});

test("waiting: the run page says it waits for v2's roadmap items before the Engineering dates", async ({ page }) => {
  // protects=RunOut.waiting_for on the timeline, between the PRD draft and the Engineering dates; fails_when=the line is missing or below the dates stop; no_claim=the draft-items run itself.
  await withScenario(page, "eng-dates");
  await login(page);
  await page.goto(`/runs/${ENG_DATES_WAITING_RUN}`);
  const waiting = page.getByTestId("waiting-for");
  await expect(waiting).toHaveText("Waiting for v2's roadmap items");
  await expect(page.getByTestId("segment-eng_dates").getByTestId("segment-state")).toHaveText("Pending");
  const above = await waiting.boundingBox();
  const dates = await page.getByTestId("segment-eng_dates").boundingBox();
  const prd = await page.getByTestId("segment-prd_draft").boundingBox();
  expect(above && dates && prd && above.y > prd.y && above.y < dates.y).toBeTruthy();
});

/**
 * Oracle's ticker: POST /v1/internal/tick. The mock API lives in the page, so the call goes
 * through the mock's own fetch, as page.request would reach the real API.
 */
async function tick(page: Page) {
  const code = await page.evaluate(async () => {
    const fetchMock = (globalThis as { __poMockFetch?: (r: Request) => Promise<Response> }).__poMockFetch!;
    const res = await fetchMock(new Request(new URL("/v1/internal/tick", location.origin), { method: "POST" }));
    return res.status;
  });
  expect(code).toBe(200);
}

test("wait ends: once v2's roadmap items are ready, the Engineering dates run and their stop opens", async ({ page }) => {
  // protects=the wait for the draft's items ends on a tick and the dates stop opens on the run page; fails_when=the waiting line stays, or the Engineering dates never reach their review; no_claim=E1's derivation itself (draft-roadmap.spec).
  await withScenario(page, "eng-dates");
  await login(page);
  await page.goto(`/runs/${ENG_DATES_WAITING_RUN}`);
  await expect(page.getByTestId("waiting-for")).toHaveText("Waiting for v2's roadmap items");
  await tick(page);
  await tick(page);
  await page.reload();
  await expect(page.getByTestId("waiting-for")).toHaveCount(0);
  await expect(page.getByTestId("segment-eng_dates").getByTestId("review-screen-line")).toContainText("2 Now items · 1 to decide");
});

test("phone: at 390 px the rows are cards, the decision bar stays on screen and nothing scrolls sideways", async ({ page }) => {
  // protects=the screen at 390 px; fails_when=rows are not stacked cards, the decision bar is off screen, or the page scrolls sideways; no_claim=other phone layouts.
  await page.setViewportSize({ width: 390, height: 844 });
  await openDatesAsLead(page);
  const first = await row(page, "shipping-step").boundingBox();
  const second = await row(page, "price-early").boundingBox();
  expect(first && second && second.y >= first.y + first.height).toBeTruthy();
  await expect(bar(page).getByTestId("dates-tally")).toBeInViewport();
  await page.mouse.wheel(0, 2000);
  await expect(bar(page).getByTestId("dates-tally")).toBeInViewport();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

test("sheet toggle: Engineering dates is on with its help, unchecking it lowers the estimate by $5.00, and the run then skips the step", async ({ page }) => {
  // protects=the stop on by default with its help, in the estimate; fails_when=the switch is missing, unchecked, unchecking it does not lower the estimate by $5.00, or the run started with it off does not skip the step with its note; no_claim=the API's estimate ($36.50 with both stops on a rebuild).
  await login(page, "approver@example.com");
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Dates for the shipping step");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Buyers drop off when shipping options show up late in checkout.");
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const toggle = sheet(page).getByRole("switch", { name: "Engineering dates" });
  await expect(toggle).toBeChecked();
  await expect(sheet(page).getByTestId("stop-help").filter({ hasText: "dates" })).toHaveText(
    "After the PRD review, the engineering lead records the dates behind the draft's Now items.",
  );
  await sheet(page).getByRole("button", { name: "Estimate" }).click();
  await expect(sheet(page).getByTestId("draft-estimate")).toHaveText("Estimated $29.50");
  await toggle.uncheck();
  await expect(sheet(page).getByTestId("draft-estimate")).toHaveText("Estimated $24.50");
  // Off, the run skips the whole step, with its note.
  await sheet(page).getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  const dates = page.getByTestId("segment-eng_dates");
  await expect(dates.getByTestId("segment-state")).toHaveText("Skipped");
  await expect(dates).toContainText("Engineering dates: Not asked (checkpoint skipped)");
});
