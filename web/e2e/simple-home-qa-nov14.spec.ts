import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * simple-home-qa-nov14: a visual QA of Simple Home, Inbox, Decisions and Meetings, driven through
 * the UI on the mock's invented data, as a person would.
 *
 * #1 protects = a waiting row, an Inbox row and the meeting's Roadmap step name a feature with no
 * code with the "Not in the Ground Truth" flag, a coded one with its code; fails_when = the bare name.
 * #2 protects = a waiting row's feature on Home and Decisions opens its one feature panel;
 * fails_when = the name is plain text.
 * #3 protects = Home's decision row reads "Blocks F-03 Health log" and opens its panel;
 * fails_when = "Blocks Health log" in plain text.
 * #4 protects = the meeting's Roadmap step reads an undated item as Oracle's estimate ("No dates
 * yet · estimated …"), never the horizon's window as if someone set it; fails_when = a bare span.
 * #5 protects = the meeting one-pager's pill for an old proof reads "Exists · checked <day>";
 * fails_when = "Exists · proof old".
 * #6 protects = a question decided in a meeting keeps its stamp's zone, as "Decisions in this
 * meeting" does; fails_when = "Sat Nov 14, 1:55 AM" with no zone.
 * Missing (a) protects = the Inbox lists the broken links Home sends there, each fixed in place;
 * fails_when = the Inbox has no broken-link row.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const panel = (page: Page) => page.getByTestId("item-panel");
const waitingRow = (scope: Locator, name: string) => scope.getByTestId("waiting-item").filter({ hasText: name });

async function startReview(page: Page) {
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = page.getByRole("dialog", { name: "Start a review" });
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await s.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });

test("#1 #2 Home's waiting rows flag a feature with no code, and a feature's name opens its panel", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  const list = page.getByTestId("home-also-waiting-list");
  await expect(list).toBeVisible();
  const coded = waitingRow(list, "Health log").first();
  await expect(coded).toContainText("F-03");
  await expect(coded.getByTestId("not-in-gt")).toHaveCount(0);
  const bare = list.getByTestId("waiting-item").filter({ has: page.getByTestId("not-in-gt") });
  await expect(bare.first()).toContainText("Not in the Ground Truth");
  await tap(coded.getByTestId("waiting-feature"));
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("aria-label", "Health log");
});

test("#3 Home's decision row names the feature it blocks with its code, and opens its panel", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  const q = page.getByTestId("home-question").filter({ hasText: "Reminder default time" }).first();
  await expect(q).toBeVisible();
  const blocks = q.getByTestId("question-blocks-feature").first();
  await expect(blocks).toContainText("F-03 Health log");
  await tap(blocks);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("aria-label", "Health log");
});

test("#1 #2 Decisions' waiting rows flag a feature with no code, and a feature's name opens its panel", async ({ page }) => {
  await login(page);
  await page.goto("/simple/decisions");
  const coded = waitingRow(page.locator("body"), "Health log").first();
  await expect(coded).toContainText("F-03");
  const bare = page.getByTestId("waiting-item").filter({ has: page.getByTestId("not-in-gt") });
  await expect(bare.first()).toBeVisible();
  await tap(coded.getByTestId("waiting-feature"));
  await expect(panel(page)).toHaveAttribute("aria-label", "Health log");
});

test("#1 the Inbox flags a feature with no code; missing (a): it lists the broken links, fixed in place", async ({ page }) => {
  await login(page);
  await page.goto("/simple/inbox");
  const needs = page.getByTestId("inbox-needs");
  await expect(needs).toBeVisible();
  await expect(needs.getByTestId("not-in-gt").first()).toBeVisible();
  const broken = page.getByTestId("inbox-broken-links");
  await expect(broken.getByTestId("waiting-item").first()).toBeVisible();
  const row = broken.getByTestId("waiting-item").first();
  await tap(row.getByRole("button", { name: "Fix the link" }));
  await expect(row.getByRole("button", { name: "Fix the link" })).toHaveAttribute("aria-expanded", "true");
});

test("#1 #4 #5 #6 a review: flagged names, estimates read as estimates, the checked day, the decided stamp's zone", async ({ page }) => {
  await login(page);
  await startReview(page);
  // #5: the one-pager's timeline pill for an old proof.
  const old = page.locator('[data-mark="exists_old"]').filter({ visible: true }).first();
  await expect(old).toHaveText(/^Exists · checked [A-Z][a-z]{2} \d{1,2}$/);
  await expect(page.getByTestId("cs-mark").filter({ hasText: /proof old/i })).toHaveCount(0);
  // #1 and #4: the Roadmap step.
  await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
  const slice = page.getByRole("region", { name: "Roadmap slice" });
  await expect(slice.getByTestId("not-in-gt").first()).toBeVisible();
  await expect(slice.getByTestId("roadmap-span").filter({ hasText: "No dates yet · estimated" }).first()).toBeVisible();
  await expect(slice.getByTestId("roadmap-span").filter({ hasText: /2028/ }).filter({ hasNotText: "estimated" })).toHaveCount(0);
  // #6: a question decided here keeps its zone.
  await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
  const q5 = page.getByRole("region", { name: "On the agenda", exact: true }).locator('[data-code="Q5"]');
  await tap(q5.getByRole("button", { name: "Decide as recommended" }));
  await expect(q5).toContainText(/Decided in this meeting.* · \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M (PDT|PST)\b/);
});
