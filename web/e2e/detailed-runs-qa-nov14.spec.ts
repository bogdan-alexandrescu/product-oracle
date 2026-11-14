import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Visual QA, Nov 14, 2026 (Runs, Priorities, Inbox, Company, Settings, Trash) on the mock's
 * invented data, at 1440: #3 the Roadmap popover an Inbox Dates row's Open shows names the
 * feature it changes, #4 Reconnect to choose files keeps the account's own name, #5 Members'
 * Last sign-in shows its whole date, #6 a Dates row's cut why reads in full on hover, #7 the
 * goal buckets call a feature a feature.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, path: string) {
  await login(page);
  await page.goto(path);
}

for (const path of ["/simple/inbox"]) {
  /** #3: fails when the popover reads only "Oracle suggests …", with no feature named. */
  test(`#3 ${path}: a Dates row's Open names the feature in the Roadmap popover`, async ({ page }) => {
    await open(page, path);
    await page.getByRole("link", { name: "Open Oracle's dates for Rep daily scoreboard" }).click();
    const pop = page.getByTestId("suggestion-popover");
    await expect(pop).toBeVisible();
    await expect(pop.locator("p").first()).toContainText(/^F-112 Rep daily scoreboard: Oracle suggests /);
  });

  /** #6: fails when a Dates row's why is cut with "…" and nothing shows it in full. */
  test(`#6 ${path}: a Dates row's cut why reads in full on hover`, async ({ page }) => {
    await open(page, path);
    const basis = page.getByTestId("date-suggestion-basis").first();
    await expect(basis).toBeVisible();
    const text = (await basis.textContent()) ?? "";
    expect(text.length).toBeGreaterThan(0);
    await expect(basis).toHaveAttribute("title", text);
  });
}

/** #4: fails when old-drive@example.com comes back from its reconnect as a second pat@example.com. */
test("#4 Reconnect to choose files keeps the account's name", async ({ page }) => {
  await open(page, "/settings/connections");
  const google = page.getByTestId("connection-card-google");
  const old = google.getByRole("listitem").filter({ hasText: "old-drive@example.com" });
  await old.getByRole("button", { name: "Reconnect to choose files" }).click();
  await expect(page).toHaveURL(/connected=google/);
  await expect(google.getByRole("listitem")).toHaveText([/pat@example\.com/, /old-drive@example\.com/]);
  await expect(google.getByRole("button", { name: "Reconnect to choose files" })).toHaveCount(0);
});

/** #5: fails when Avery Stone's "Nov 14, 2026" is cut to "Nov 14, 20…" in its column. */
test("#5 Members' Last sign-in shows its whole date", async ({ page }) => {
  // Signed in on Nov 14: "Nov 14" draws wider than the pinned clock's "Oct 22".
  await page.clock.setSystemTime(new Date("2026-11-14T09:50:00Z"));
  await open(page, "/settings/members");
  const row = page.getByRole("row").filter({ hasText: "Avery Stone" }).first();
  const date = row.locator("span[title]").filter({ hasText: /^Nov 14, 2026$/ });
  await expect(date).toBeVisible();
  const cut = await date.evaluate((el) => {
    const cell = el.closest("td,[role=cell]") as HTMLElement;
    const r = el.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(cell).paddingRight) || 0;
    return r.right > c.right - pad + 0.5;
  });
  expect(cut).toBe(false);
});

/** #7: fails when a goal bucket's feature row offers "Edit task" and a "Save task" form. */
test("#7 the goal buckets edit a feature, not a task", async ({ page }) => {
  await open(page, "/simple/priorities?tab=buckets");
  const row = page.getByTestId("plan-feature").filter({ has: page.getByTestId("task-actions") }).first();
  await row.getByRole("button", { name: /^More for / }).click();
  await expect(row.getByRole("menuitem")).toHaveText(["Edit feature", "Cut from the roadmap"]);
  await row.getByRole("menuitem", { name: "Edit feature" }).click();
  const form = row.getByTestId("task-form");
  await expect(form.getByRole("heading", { name: "Edit feature" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toBeVisible();
});
