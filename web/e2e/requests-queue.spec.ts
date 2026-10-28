import { expect, test, type Page, mockNow } from "./test";

import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * #348 Requests queue: the queue's filters, the inspector's actions (edit, link, qualify,
 * merge, disqualify, reopen, accept or decline Oracle's suggestion) and the Themes tab,
 * driven through the UI as a person would, on the mock API. Synthetic placeholders only.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const TITLE = "Reorder a past basket in one click";
const WHY = "Buyers order the same things every week and build the basket again by hand each time.";

async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("request-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("request-inspector");
const filter = (page: Page, name: string) => page.getByTestId("request-filters").getByLabel(name, { exact: true });

async function pick(page: Page, title: string) {
  await row(page, title).getByRole("button", { name: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
}

test("Queue: filters by state, goal and theme, searches, and shows a filed request", async ({ page }) => {
  // protects=#348 Build 1 and Done when (the queue's columns and filters; New request's
  // requests show up in it); fails_when=a filter keeps rows it should drop, a column is
  // missing, or a filed request is not in the queue; no_claim=the real API's filters.
  await login(page);
  await openRequests(page);
  const address = row(page, "Keep the delivery address between orders");
  await expect(address).toContainText("Qualified");
  await expect(address).toContainText("Faster check-out");
  await expect(address).toContainText("Support");
  await expect(address).toContainText("A buyer at a retail customer");
  await expect(address.getByTestId("request-age")).toHaveText("2w");
  await expect(address.getByTestId("goal-chip")).toHaveCount(1);

  await filter(page, "State").selectOption("qualified");
  await expect(page.getByTestId("request-row")).toHaveCount(4);
  await filter(page, "Theme").selectOption({ label: "Team sharing" });
  await expect(page.getByTestId("request-row")).toHaveCount(2);
  await filter(page, "State").selectOption("");
  await filter(page, "Theme").selectOption("");
  await filter(page, "Goal").selectOption({ label: "Raise activation" });
  await expect(row(page, "Weekly summary email")).toBeVisible();
  await expect(row(page, "Invite a whole team at once")).toHaveCount(0);
  await filter(page, "Goal").selectOption("");
  await filter(page, "Search requests").fill("dark");
  await expect(page.getByTestId("request-row")).toHaveText([/Dark mode/]);
  await filter(page, "Search requests").fill("");

  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(row(page, TITLE)).toHaveAttribute("aria-current", "true");
  await expect(row(page, TITLE).getByTestId("request-age")).toHaveText("now");
  await expect(inspector(page).getByRole("heading", { name: TITLE })).toBeVisible();
  await filter(page, "State").selectOption("new");
  await expect(row(page, TITLE)).toBeVisible();
});

test("Inspector: the filer edits a New request's words", async ({ page }) => {
  // protects=#348 Build 2 (edit); fails_when=Edit is missing for the filer or the new
  // title is not saved; no_claim=the API's filer rule.
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();

  await inspector(page).getByRole("button", { name: "Edit" }).click();
  await inspector(page).getByLabel("Title").fill("Reorder last week's basket");
  await inspector(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Reorder last week's basket" })).toBeVisible();
  await page.reload();
  await expect(row(page, "Reorder last week's basket")).toBeVisible();
});

test("Inspector: link goals, theme, feature and PRD, then qualify with a reason", async ({ page }) => {
  // protects=#348 Build 2 (link; Qualify with a reason; a state block is disabled with its
  // reason); fails_when=links are not saved or the request does not qualify;
  // no_claim=the API's confirmed-goal rule.
  await login(page);
  await openRequests(page);
  await pick(page, "Dark mode");
  const panel = inspector(page);
  await panel.getByRole("checkbox", { name: "Raise activation" }).check();
  await panel.getByRole("combobox", { name: "Theme", exact: true }).selectOption({ label: "Reporting" });
  await panel.getByLabel("Feature").selectOption({ label: "Dark mode" });
  await panel.getByLabel("PRD").selectOption({ index: 1 });
  await panel.getByRole("button", { name: "Save links" }).click();
  await expect(row(page, "Dark mode").getByTestId("goal-chip")).toHaveText(["Raise activation"]);
  await expect(row(page, "Dark mode")).toContainText("Reporting");

  await panel.getByRole("button", { name: "Qualify", exact: true }).click();
  await panel.getByLabel("Reason").fill("Asked for by every team we spoke to");
  await panel.getByRole("button", { name: "Qualify request" }).click();
  await expect(row(page, "Dark mode")).toContainText("Qualified");
  await expect(panel).toContainText("Asked for by every team we spoke to");
  await expect(panel.getByRole("button", { name: "Qualify", exact: true })).toBeDisabled();
  await expect(panel.getByTestId("decide-reason")).toHaveText("Only a New request can be qualified");
});

test("Inspector: merge into another request, disqualify with a reason, and reopen", async ({ page }) => {
  // protects=#348 Build 2 (Merge, Disqualify, Reopen); fails_when=the state does not
  // change or Reopen does not bring it back to New; no_claim=merge chains (the API's root rule).
  await login(page);
  await openRequests(page);
  await pick(page, "Bulk edit prices");
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Merge", exact: true }).click();
  await panel.getByLabel("Merge into").selectOption({ label: "Export orders to a spreadsheet" });
  await panel.getByRole("button", { name: "Merge request" }).click();
  await expect(row(page, "Bulk edit prices")).toContainText("Merged");
  await panel.getByRole("button", { name: "Reopen" }).click();
  await expect(row(page, "Bulk edit prices")).toContainText("New");

  await pick(page, "Pay by bank transfer");
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Out of scope" });
  await panel.getByLabel("Note").fill("Payments by transfer are not planned");
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(row(page, "Pay by bank transfer")).toContainText("Disqualified");
  await expect(panel).toContainText("Out of scope");
  await panel.getByRole("button", { name: "Reopen" }).click();
  await expect(row(page, "Pay by bank transfer")).toContainText("New");
});

test("Inspector: accept Oracle's suggestion", async ({ page }) => {
  // protects=#348 Build 2 (accept Oracle's suggestion); fails_when=accepting does not
  // link the suggested goal and theme; no_claim=the triage that writes suggestions.
  await login(page);
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  const suggestion = inspector(page).getByTestId("request-suggestion");
  await expect(suggestion).toContainText("Faster check-out");
  await suggestion.getByRole("button", { name: "Accept suggestion" }).click();
  await expect(row(page, "Save my card for the next order")).toContainText("Faster check-out");
  await expect(row(page, "Save my card for the next order").getByTestId("goal-chip")).toHaveCount(1);
  await expect(inspector(page).getByTestId("request-suggestion")).toHaveCount(0);
});

test("Inspector: decline Oracle's suggestion; it stays declined, with who and when, after Classify now", async ({ page }) => {
  // protects=#348 Build 2 (decline Oracle's suggestion) and the owner's decision of
  // 2026-10-23 (a declined suggestion stays marked declined, who and when, is no longer
  // offered, and triage leaves it); fails_when=the suggestion is still offered, the request
  // gains its goal or theme, the inspector does not say who declined it and when, or a
  // triage run brings it back; no_claim=the real triage run (the mock finishes it itself).
  await login(page);
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  const declinedOn = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(mockNow());
  await inspector(page).getByTestId("request-suggestion").getByRole("button", { name: "Decline" }).click();
  const suggestion = inspector(page).getByTestId("request-suggestion");
  await expect(suggestion).toContainText(`Declined by Admin, ${declinedOn}`);
  await expect(suggestion.getByRole("button")).toHaveCount(0);
  await expect(row(page, "Save my card for the next order").getByTestId("goal-chip")).toHaveCount(0);

  await page.getByRole("button", { name: "Classify now", exact: true }).click();
  await expect(page.getByTestId("triage-status")).toContainText(/suggestions on \d+ requests? and found/, { timeout: 15_000 });
  await page.reload();
  await pick(page, "Save my card for the next order");
  await expect(inspector(page).getByTestId("request-suggestion")).toContainText(`Declined by Admin, ${declinedOn}`);
  await expect(inspector(page).getByRole("button", { name: "Accept suggestion" })).toHaveCount(0);
  await expect(row(page, "Save my card for the next order").getByTestId("goal-chip")).toHaveCount(0);
});

test("Inspector: Oracle's suggestion names the feature it suggests", async ({ page }) => {
  // protects=review fix 6 (the suggestion names the feature by its title); fails_when=the
  // suggestion says "A feature in the baseline" or a feature other than the one accepting
  // links; no_claim=the triage that picks the feature.
  await login(page);
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  const feature = inspector(page).getByTestId("suggested-feature");
  await expect(feature).toHaveText(/^Feature: \S/);
  await expect(feature).not.toContainText("A feature");
  // The features load with the page; read the title once it has replaced "Loading…".
  await expect(feature).not.toContainText("Loading");
  const title = ((await feature.textContent()) ?? "").replace(/^Feature: /, "");
  await inspector(page).getByRole("button", { name: "Accept suggestion" }).click();
  await expect(inspector(page).getByTestId("request-suggestion")).toHaveCount(0);
  await page.reload();
  await pick(page, "Save my card for the next order");
  await expect(inspector(page).getByLabel("Feature").locator("option:checked")).toHaveText(title);
});

test("Inspector: a Merged or Disqualified request shows its links without Save links", async ({ page }) => {
  // protects=review fix 2 (the API refuses link changes on a Merged or Disqualified
  // request, so the inspector offers none); fails_when=Save links shows for either;
  // no_claim=the API's refusal (the API's tests).
  await login(page);
  await openRequests(page);
  await pick(page, "Remember my address");
  await expect(inspector(page).getByText("Merged into Keep the delivery address between orders")).toBeVisible();
  await expect(inspector(page).getByRole("button", { name: "Save links" })).toHaveCount(0);
  await pick(page, "Pay by bank transfer");
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Out of scope" });
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(row(page, "Pay by bank transfer")).toContainText("Disqualified");
  await expect(panel.getByRole("button", { name: "Save links" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Reopen" }).click();
  await expect(row(page, "Pay by bank transfer")).toContainText("New");
  await expect(panel.getByRole("button", { name: "Save links" })).toBeVisible();
});

test("Inspector: clearing the description sends no description (null)", async ({ page }) => {
  // protects=review fix 3 (a cleared description is sent as null, not ""); fails_when=the
  // PATCH carries body "" or the inspector does not say "No description"; no_claim=the
  // API's own normalising of "".
  await page.addInitScript(() => {
    // Records the PATCH bodies the typed client builds, as the network would see them.
    const Native = window.Request;
    const sent: unknown[] = [];
    (window as unknown as { __patches: unknown[] }).__patches = sent;
    window.Request = class extends Native {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        if (init?.method === "PATCH" && typeof init.body === "string") sent.push(JSON.parse(init.body));
      }
    } as typeof Request;
  });
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();

  await inspector(page).getByRole("button", { name: "Edit" }).click();
  await inspector(page).getByLabel("What it is and why").fill("");
  await inspector(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(inspector(page).getByText("No description")).toBeVisible();
  const patches = await page.evaluate(() => (window as unknown as { __patches: Record<string, unknown>[] }).__patches);
  expect(patches.at(-1)).toMatchObject({ title: TITLE, body: null });
});

test("Themes: create, rename and archive a theme", async ({ page }) => {
  // protects=#348 Build 3; fails_when=a theme cannot be created, renamed or archived;
  // no_claim=the API's unique-title rule.
  await login(page);
  await openRequests(page);
  await page.getByTestId("requests-tab-themes").filter({ visible: true }).click();
  await page.getByLabel("New theme").fill("Payments");
  await page.getByRole("button", { name: "Create theme" }).click();
  const theme = page.getByTestId("theme-row").filter({ hasText: "Payments" });
  await expect(theme).toBeVisible();
  await theme.getByRole("button", { name: "Rename" }).click();
  // While renaming, the title is in the input, so find the row by its testid.
  const editing = page.getByTestId("theme-row").filter({ has: page.getByLabel("Theme title") });
  await editing.getByLabel("Theme title").fill("Payments and billing");
  await editing.getByRole("button", { name: "Save", exact: true }).click();
  const renamed = page.getByTestId("theme-row").filter({ hasText: "Payments and billing" });
  await expect(renamed).toBeVisible();
  await renamed.getByRole("button", { name: "Archive" }).click();
  await expect(renamed).toContainText("Archived");
  await page.getByTestId("requests-tab-all").filter({ visible: true }).click();
  await expect(filter(page, "Theme").locator("option", { hasText: "Payments and billing" })).toHaveText("Payments and billing (archived)");
});

test("Themes: restore an archived theme", async ({ page }) => {
  // protects=#348 Build 3 (restore, un-archive) and review fix 5; fails_when=Restore is
  // missing on an archived theme, the theme stays archived, or the Theme filter still marks
  // it archived; no_claim=the API's unique-title rule on restore.
  await login(page);
  await openRequests(page);
  await page.getByTestId("requests-tab-themes").filter({ visible: true }).click();
  const theme = page.getByTestId("theme-row").filter({ hasText: "Reporting" });
  await theme.getByRole("button", { name: "Archive" }).click();
  await expect(theme).toContainText("Archived");
  await expect(theme.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await theme.getByRole("button", { name: "Restore" }).click();
  await expect(theme).not.toContainText("Archived");
  await expect(theme.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(theme.getByRole("button", { name: "Rename" })).toBeVisible();
  await page.reload();
  await page.getByTestId("requests-tab-themes").filter({ visible: true }).click();
  await expect(page.getByTestId("theme-row").filter({ hasText: "Reporting" })).not.toContainText("Archived");
  await page.getByTestId("requests-tab-all").filter({ visible: true }).click();
  await expect(filter(page, "Theme").locator("option", { hasText: "Reporting" })).toHaveText("Reporting");
});

test("Queue: the Theme filter lists archived themes, marked, and filters by them", async ({ page }) => {
  // protects=review fix 4 (requests on an archived theme can still be found);
  // fails_when=an archived theme is missing from the Theme filter, unmarked, or filtering
  // by it drops its requests; no_claim=the API's theme_id filter.
  await login(page);
  await openRequests(page);
  await page.getByTestId("requests-tab-themes").filter({ visible: true }).click();
  await page.getByTestId("theme-row").filter({ hasText: "Reporting" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("theme-row").filter({ hasText: "Reporting" })).toContainText("Archived");
  await page.getByTestId("requests-tab-all").filter({ visible: true }).click();
  await filter(page, "Theme").selectOption({ label: "Reporting (archived)" });
  await expect(page.getByTestId("request-row")).toHaveCount(2);
  await expect(row(page, "Weekly summary email")).toBeVisible();
  await expect(row(page, "Export orders to a spreadsheet")).toBeVisible();
});

test("A commenter sees no decisions, links or theme controls", async ({ page }) => {
  // protects=the #370 rule (hide controls a role can't act on); fails_when=a commenter is
  // shown Qualify, Merge, Disqualify, Save links, Accept or Create theme; no_claim=the API's 403s.
  await login(page, "commenter@example.com");
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  const panel = inspector(page);
  for (const name of ["Qualify", "Merge", "Disqualify", "Save links", "Accept suggestion", "Edit"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await page.getByTestId("requests-tab-themes").filter({ visible: true }).click();
  await expect(page.getByTestId("theme-row").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create theme" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
});

test("#549 Queue: the filters share one wrapping row, and wrap without sideways scroll on a phone", async ({ page }) => {
  // protects=#549 1 (Search, State, Goal and Theme sit on one row at desktop widths, the
  // selects at their own width); fails_when=a select stretches to the filter bar's full width
  // or drops below Search at 1280 px, or the page scrolls sideways at 390 px; no_claim=the
  // exact widths, or browsers other than Chromium.
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await openRequests(page);
  const bar = (await page.getByTestId("request-filters").boundingBox())!;
  const search = (await filter(page, "Search requests").boundingBox())!;
  const state = (await filter(page, "State").boundingBox())!;
  expect(state.width).toBeLessThan(bar.width / 2);
  expect(Math.abs(state.y - search.y)).toBeLessThan(search.height / 2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(filter(page, "State")).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
});

/** Relative luminance of a computed `rgb(...)` colour (WCAG). */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const theme of ["light", "dark"] as const) {
  test(`#549 the inspector's channel chip reads on the dark head in the ${theme} theme`, async ({ page }) => {
    // protects=#549 2 (the channel chip's text shows on the inspector's dark head, like the
    // state chip beside it); fails_when=the chip's text colour is near the head's background
    // (contrast under 4.5:1); no_claim=the chip's exact colours.
    await page.addInitScript(([key, t]) => localStorage.setItem(key, t), [THEME_KEY, theme] as const);
    await login(page);
    await openRequests(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await pick(page, "Keep the delivery address between orders");
    const chip = inspector(page).locator("[data-kind=line]", { hasText: /^Support$/ });
    await expect(chip).toHaveText("Support");
    const [text, head] = await chip.evaluate((el) => {
      let bg = el.parentElement;
      while (bg && getComputedStyle(bg).backgroundColor.match(/rgba\(.*, 0\)|transparent/)) bg = bg.parentElement;
      return [getComputedStyle(el).color, getComputedStyle(bg!).backgroundColor];
    });
    const [hi, lo] = [luminance(text), luminance(head)].sort((a, b) => b - a);
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
}
