import { expect, type Locator, type Page, test } from "@playwright/test";

import { SOURCES_STORAGE_KEY } from "../lib/api/mock/sources";
import { login } from "./helpers";

async function openAdd(page: Page): Promise<{ form: Locator; picker: Locator }> {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("fireflies");
  await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
  const picker = form.getByTestId("fireflies-picker");
  await expect(picker).toBeVisible();
  // The old title textarea is gone.
  await expect(form.getByText("Meeting title filters")).toHaveCount(0);
  return { form, picker };
}

test("fireflies picker: all meetings in a date range", async ({ page }) => {
  const { form, picker } = await openAdd(page);
  const summary = picker.getByTestId("fireflies-summary");
  await expect(summary).toHaveText("All meetings");
  // The API does not know the person's time zone: days are UTC days, and say so.
  await expect(picker.getByTestId("fireflies-timezone")).toContainText(/^UTC/);
  await expect(picker.getByTestId("fireflies-timezone")).toContainText("Oracle does not know your time zone");
  await picker.getByLabel("From").fill("2026-09-01");
  await expect(summary).toHaveText("All meetings since Sep 1");
  // Lists are only for choosing: nothing to browse while taking everything.
  await expect(picker.getByRole("region", { name: "Series" })).toHaveCount(0);

  await picker.getByLabel("Ongoing").uncheck();
  await picker.getByLabel("To", { exact: true }).fill("2026-10-31");
  await expect(summary).toHaveText("All meetings Sep 1 – Oct 31");
  await picker.getByLabel("Ongoing").check();
  await expect(picker.getByLabel("To", { exact: true })).toBeDisabled();

  await form.getByLabel("Name").fill("All calls");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "All calls" });
  await expect(row.getByTestId("fireflies-included")).toContainText("All meetings since Sep 1");
});

test("fireflies picker: series and single meetings, then edit", async ({ page }) => {
  const { form, picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  const summary = picker.getByTestId("fireflies-summary");
  await expect(summary).toHaveText("Nothing picked yet");
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();

  const series = picker.getByRole("list", { name: "Series" });
  await expect(series.getByRole("listitem")).toHaveCount(2);
  await expect(series).toContainText("AI Agents daily standup");
  await expect(series).toContainText("AI agents sprint planning");
  // One-off meetings are not offered as series.
  await expect(series).not.toContainText("Customer interview");
  // A series counts the meetings of its calendar event: the ad hoc session with the
  // same title and organizer is on no calendar, so not one of them.
  await expect(series.getByRole("listitem").filter({ hasText: "AI agents sprint planning" })).toContainText("4 ·");
  await series.getByLabel("AI agents sprint planning").check();
  await expect(summary).toHaveText("1 series");

  const meetings = picker.getByRole("group", { name: "Meetings" });
  // Grouped by date, newest first.
  await expect(meetings.getByRole("group").first()).toContainText("Fri, Oct 16");
  // A meeting of a picked series is included with it.
  const planning = meetings.getByLabel("AI agents sprint planning #14");
  await expect(planning).toBeChecked();
  await expect(planning).toBeDisabled();

  await picker.getByLabel("Search meetings").fill("sprint planning");
  await expect(meetings.getByRole("checkbox")).toHaveCount(5);
  const adhoc = meetings.getByLabel("AI agents sprint planning", { exact: true });
  await expect(adhoc).not.toBeChecked();
  await expect(adhoc).toBeEnabled();
  await expect(meetings.getByLabel("AI agents sprint planning #11")).toBeChecked();

  await picker.getByLabel("Search meetings").fill("customer");
  await expect(meetings.getByRole("checkbox")).toHaveCount(2);
  await meetings.getByLabel("Customer interview: Acme").check();
  await meetings.getByLabel("Customer interview: Globex").check();
  await expect(summary).toHaveText("1 series, 2 meetings");
  await picker.getByLabel("From").fill("2026-09-01");
  await expect(summary).toHaveText("1 series, 2 meetings, since Sep 1");

  await form.getByLabel("Name").fill("Agents meetings");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Agents meetings" });
  await expect(row.getByTestId("fireflies-included")).toContainText("1 series, 2 meetings, since Sep 1");

  // Editing re-opens the picker with the choices.
  await row.getByRole("button", { name: "More actions for Agents meetings" }).click();
  await row.getByRole("menuitem", { name: "Edit meetings" }).click();
  const edit = row.getByTestId("fireflies-picker");
  await expect(edit.getByRole("button", { name: "Choose" })).toHaveAttribute("aria-pressed", "true");
  await expect(edit.getByLabel("From")).toHaveValue("2026-09-01");
  await expect(edit.getByRole("list", { name: "Series" }).getByLabel("AI agents sprint planning")).toBeChecked();
  await expect(edit.getByTestId("fireflies-summary")).toHaveText("1 series, 2 meetings, since Sep 1");
  const editMeetings = edit.getByRole("group", { name: "Meetings" });
  await expect(editMeetings.getByLabel("Customer interview: Acme")).toBeChecked();

  // Add the standup series, drop one interview.
  await edit.getByRole("list", { name: "Series" }).getByLabel("AI Agents daily standup").check();
  await editMeetings.getByLabel("Customer interview: Globex").uncheck();
  await expect(edit.getByTestId("fireflies-summary")).toHaveText("2 series, 1 meeting, since Sep 1");
  await row.getByRole("button", { name: "Save meetings" }).click();
  await expect(row.getByRole("status")).toHaveText("Meetings saved.");
  await expect(row.getByTestId("fireflies-included")).toContainText("2 series, 1 meeting, since Sep 1");
});

test("fireflies picker: a title rule saved before the picker shows until saved again", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Customer calls" });
  await expect(row.getByTestId("fireflies-included")).toContainText("Title rule");
  await expect(row.getByTestId("fireflies-included")).toContainText("Customer interview, since Sep 1");

  await row.getByRole("button", { name: "More actions for Customer calls" }).click();
  await row.getByRole("menuitem", { name: "Edit meetings" }).click();
  const picker = row.getByTestId("fireflies-picker");
  await expect(picker.getByTestId("title-rule")).toContainText("“Customer interview”");
  await expect(picker.getByLabel("From")).toHaveValue("2026-09-01");
  // Opens on choosing, with nothing picked: saving as it opens must not widen the rule to
  // every meeting.
  await expect(picker.getByRole("button", { name: "Choose" })).toHaveAttribute("aria-pressed", "true");
  await expect(picker.getByTestId("fireflies-summary")).toHaveText("Nothing picked yet");
  await expect(row.getByRole("button", { name: "Save meetings" })).toBeDisabled();
  // The row still reads as the title rule until it is saved.
  await expect(row.getByTestId("fireflies-included")).toContainText("Customer interview, since Sep 1");

  await picker.getByLabel("Search meetings").fill("customer");
  await picker.getByRole("group", { name: "Meetings" }).getByLabel("Customer interview: Acme").check();
  await row.getByRole("button", { name: "Save meetings" }).click();
  await expect(row.getByTestId("fireflies-included")).toContainText("Meetings");
  await expect(row.getByTestId("fireflies-included")).toContainText("1 meeting, since Sep 1");
  await expect(row.getByTestId("fireflies-included")).not.toContainText("Title rule");
});

test("fireflies picker: the browsing budget reads as 'limit reached, try later'", async ({ page }) => {
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  await picker.getByLabel("Search meetings").fill("rate limit");
  await expect(picker.getByRole("alert")).toContainText("Fireflies limit reached, try later.");
  await expect(picker.getByRole("alert")).toContainText("Try again in 5 hours.");
});

test("fireflies picker: search waits until typing stops before it asks Fireflies", async ({ page }) => {
  // The clock is faked before the page loads, so every timer runs on it.
  await page.clock.install();
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  await page.clock.runFor(1000);
  await expect(picker.getByRole("group", { name: "Meetings" }).getByLabel("Customer interview: Acme")).toBeVisible();
  const searches = () =>
    page.evaluate(() => (window.__firefliesBrowseCalls ?? []).filter((c) => c.startsWith("meetings?") && c.includes("search=")));

  // A slow typist: 350 ms between keys never reaches Fireflies mid-word. Time stands still
  // between steps, so each gap is exactly 350 ms however slow the machine is.
  const box = picker.getByLabel("Search meetings");
  await box.click();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  for (const key of "customer") {
    await page.keyboard.type(key);
    await page.clock.runFor(350);
  }
  expect(await searches()).toEqual([]);
  await page.clock.runFor(100);
  // The search is due: let time run again so the answer arrives.
  await page.clock.resume();
  await expect.poll(searches).toEqual(["meetings?search=customer"]);
  await expect(picker.getByRole("group", { name: "Meetings" }).getByLabel("Customer interview: Acme")).toBeVisible();
});

test("fireflies picker: the limit alert has a Retry that waits out the limit", async ({ page }) => {
  // The clock is faked before the page loads, so every timer runs on it.
  await page.clock.install();
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  await picker.getByLabel("Search meetings").fill("rate limit");
  await page.clock.runFor(1000);
  const alert = picker.getByRole("alert");
  await expect(alert).toContainText("Fireflies limit reached, try later.");
  const retry = alert.getByRole("button", { name: "Retry" });
  await expect(retry).toBeDisabled();
  const calls = () => page.evaluate(() => (window.__firefliesBrowseCalls ?? []).filter((c) => c.includes("search=rate")).length);
  expect(await calls()).toBe(1);

  // The mock answers Retry-After: 18000 (5 hours).
  await page.clock.runFor("04:59:00");
  await expect(retry).toBeDisabled();
  await page.clock.runFor("01:01");
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(calls).toBe(2);
  // Still limited: the alert is back, and Retry waits again.
  await expect(alert.getByRole("button", { name: "Retry" })).toBeDisabled();
});

test("fireflies picker: the Series limit alert has a Retry that waits out the limit", async ({ page }) => {
  // The clock is faked before the page loads, so every timer runs on it.
  await page.clock.install();
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  // The mock's series list from 2000-01-01 answers 429 with Retry-After: 60.
  await picker.getByLabel("From").fill("2000-01-01");
  await page.clock.runFor(1000);
  const region = picker.getByRole("region", { name: "Series" });
  const alert = region.getByRole("alert");
  await expect(alert).toContainText("Fireflies limit reached, try later.");
  const retry = alert.getByRole("button", { name: "Retry" });
  await expect(retry).toBeDisabled();
  const calls = () => page.evaluate(() => (window.__firefliesBrowseCalls ?? []).filter((c) => c === "series?from=2000-01-01").length);
  expect(await calls()).toBe(1);

  await page.clock.runFor(59_000);
  await expect(retry).toBeDisabled();
  await page.clock.runFor(1500);
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(calls).toBe(2);
  await expect(region.getByRole("list", { name: "Series" }).getByRole("listitem")).toHaveCount(2);
  await expect(region.getByRole("alert")).toHaveCount(0);
});

test("fireflies picker: phone layout stacks without side scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  const series = picker.getByRole("region", { name: "Series" });
  const meetings = picker.getByRole("region", { name: "Meetings" });
  await expect(series.getByRole("listitem").first()).toBeVisible();
  const [s, m] = await Promise.all([series.boundingBox(), meetings.boundingBox()]);
  expect(m!.y).toBeGreaterThanOrEqual(s!.y + s!.height);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // No text under 13 px inside the picker.
  const small = await picker.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")]
      .filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()))
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((size) => size < 13),
  );
  expect(small).toEqual([]);
});

test("fireflies picker: typing a date makes one request per list, not one per keystroke", async ({ page }) => {
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  await expect(picker.getByRole("list", { name: "Series" }).getByRole("listitem").first()).toBeVisible();
  const calls = () => page.evaluate(() => window.__firefliesBrowseCalls ?? []);
  await expect.poll(async () => (await calls()).length).toBeGreaterThan(0);
  await page.evaluate(() => (window.__firefliesBrowseCalls = []));

  // Month, day, then the year digit by digit: 0002, 0020, 0202, 2026.
  const from = picker.getByLabel("From");
  await from.focus();
  await page.keyboard.type("09012026", { delay: 60 });
  await expect(from).toHaveValue("2026-09-01");
  await expect.poll(async () => (await calls()).filter((c) => c.startsWith("series")).length).toBe(1);
  await page.waitForTimeout(800);
  const made = await calls();
  expect(made.filter((c) => c.startsWith("series"))).toEqual(["series?from=2026-09-01"]);
  expect(made.filter((c) => c.startsWith("meetings"))).toEqual(["meetings?from=2026-09-01"]);
});

test("fireflies picker: at the most series a source takes, no more can be picked", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  await expect(page.getByRole("listitem", { name: "Customer calls" })).toBeVisible();
  // A source saved with 200 picked series (the API's MAX_SERIES).
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    const calls = db.sources.find((s: { name: string }) => s.name === "Customer calls");
    const series = Array.from({ length: 200 }, (_, i) => `cal:picked${i}`);
    const labels = Object.fromEntries(series.map((k, i) => [k, `Picked series ${i}`]));
    calls.config = { mode: "selected", series, meetings: [], labels };
    localStorage.setItem(key, JSON.stringify(db));
  }, SOURCES_STORAGE_KEY);
  await page.reload();
  const row = page.getByRole("listitem", { name: "Customer calls" });
  await expect(row.getByTestId("fireflies-included")).toContainText("200 series");
  await row.getByRole("button", { name: "More actions for Customer calls" }).click();
  await row.getByRole("menuitem", { name: "Edit meetings" }).click();
  const picker = row.getByTestId("fireflies-picker");
  await expect(picker.getByTestId("fireflies-series-cap")).toContainText("200 series picked, the most a source takes");
  const list = picker.getByRole("list", { name: "Series" });
  await expect(list.getByLabel("AI Agents daily standup")).toBeDisabled();
  await expect(list.getByLabel("AI Agents daily standup")).not.toBeChecked();
  // Unpicking one frees a place (a picked series the list no longer shows then goes).
  await list.getByLabel("Picked series 0", { exact: true }).click();
  await expect(list.getByLabel("Picked series 0", { exact: true })).toHaveCount(0);
  await expect(picker.getByTestId("fireflies-series-cap")).toHaveCount(0);
  await expect(list.getByLabel("AI Agents daily standup")).toBeEnabled();
  await expect(row.getByRole("button", { name: "Save meetings" })).toBeEnabled();
});

test("fireflies picker: tick all results of a search, pages not loaded yet included, then undo", async ({ page }) => {
  const { picker } = await openAdd(page);
  await picker.getByRole("button", { name: "Choose" }).click();
  const summary = picker.getByTestId("fireflies-summary");
  const meetings = picker.getByRole("group", { name: "Meetings" });

  // 34 standups, 12 a page: the first page is all that is loaded.
  await picker.getByLabel("Search meetings").fill("standup");
  await expect(meetings.getByRole("checkbox")).toHaveCount(12);
  await picker.getByRole("button", { name: "Tick all 12+ results" }).click();
  await expect(summary).toHaveText("34 meetings");
  await expect(meetings.getByRole("checkbox")).toHaveCount(34);
  for (const box of await meetings.getByRole("checkbox").all()) await expect(box).toBeChecked();
  await expect(picker.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // One click undoes it.
  await picker.getByRole("button", { name: "Undo tick all" }).click();
  await expect(summary).toHaveText("Nothing picked yet");
  await expect(meetings.getByLabel("AI Agents daily standup").first()).not.toBeChecked();
  await expect(picker.getByRole("button", { name: "Tick all 34 results" })).toBeVisible();

  // Meetings already included with a picked series are left out.
  await picker.getByRole("list", { name: "Series" }).getByLabel("AI agents sprint planning").check();
  await picker.getByLabel("Search meetings").fill("sprint planning");
  await expect(meetings.getByRole("checkbox")).toHaveCount(5);
  await picker.getByRole("button", { name: "Tick all 1 result" }).click();
  await expect(summary).toHaveText("1 series, 1 meeting");
  await expect(meetings.getByLabel("AI agents sprint planning", { exact: true })).toBeChecked();
  await expect(picker.getByRole("button", { name: "Undo tick all" })).toBeVisible();
});
