import { MOCK_NOW } from "../lib/api/mock/clock";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Simple changes keep the order they were made in (qaC-numfix): the clock is held at the
 * mock's now (e2e/test.ts pins it, then lets it run; here it stays), so two changes made one
 * after the other share one instant, and only the order they were made in tells them apart. Each test stubs the mock's ids to fall as changes are made, so a list
 * ordered by id reads reversed. Invented data: the mock's "simple-plan" scenario (archived
 * goals Cut support tickets in half and Faster first report; Theo Brandt a commenter, Avery
 * Stone the owner) and its PRD "guided-setup" (two numbers to fix).
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=a commenter asks to restore two archived goals, one after the other; the owner's
 *   Home lists the two proposals newest first (the second ask above the first); fails_when=a
 *   tie on the time is broken by the random id or by the list's storage order;
 *   no_claim=the API's order (api tests/test_simple_changes_api.py).
 * - protects=an owner fixes two numbers on a one-pager, "Use 200" then "Use 6"; the fixed list
 *   reads them in the order made, after a reload too; fails_when=the list follows the
 *   section order; no_claim=an id order (the one-pager mock's ids are hashes of the change's
 *   place and time, not the stubbed ones; the first test covers a tie broken by id).
 */

/** Time held still, and each new id lower than the last: an order by id is the reverse of the order made. */
async function fallingIds(page: Page, scenario = "") {
  await page.clock.setFixedTime(new Date(MOCK_NOW));
  await page.context().addInitScript(
    ([key, s]) => {
      if (s) localStorage.setItem(key, s);
      let n = 0xffffffff;
      crypto.randomUUID = () => `${(n--).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` as `${string}-${string}-${string}-${string}-${string}`;
    },
    [MOCK_SCENARIO_KEY, scenario] as const,
  );
}

test("a commenter's two asks of one instant read newest first on the owner's Home", async ({ page }) => {
  await fallingIds(page, "simple-plan");
  await login(page, "commenter@example.com");
  await page.goto("/simple/priorities?tab=buckets");
  const fold = page.getByTestId("archived-goals");
  await fold.locator("summary").click();
  const row = (title: string) => fold.getByTestId("archived-goal").filter({ hasText: title });
  const note = page.getByTestId("bucket-note");
  await row("Cut support tickets in half").getByRole("button", { name: "Ask to restore" }).click();
  await expect(note).toContainText("restore Cut support tickets in half.");
  await row("Faster first report").getByRole("button", { name: "Ask to restore" }).click();
  await expect(note).toContainText("restore Faster first report.");

  await signOut(page);
  await login(page, ADMIN.email);
  await page.goto("/simple");
  const asks = page.getByTestId("home-proposal").filter({ hasText: "Restore the goal:" });
  await expect(asks).toHaveCount(2);
  await expect(asks.nth(0)).toContainText("Restore the goal: Faster first report");
  await expect(asks.nth(1)).toContainText("Restore the goal: Cut support tickets in half");
});

test("an owner's two number fixes of one instant list in the order made", async ({ page }) => {
  await fallingIds(page);
  await login(page);
  await page.goto("/simple/one-pagers/guided-setup");
  const look = page.getByRole("region", { name: "Needs a look" });
  const item = (text: string) => look.getByRole("listitem").filter({ has: page.getByTestId("needs-look-line").getByText(text, { exact: true }) });
  const fixed = look.getByTestId("needs-look-fixed").getByRole("status");
  // The section's later number first, so the order made is not the page's order either.
  await item("Numbers disagree in “Targets”").getByRole("button", { name: "Use 200" }).click();
  await expect(fixed).toHaveText(["Fixed: set to 200 in “Targets”"]);
  await item("Numbers disagree in “Not this quarter”").getByRole("button", { name: "Use 6" }).click();
  const made = ["Fixed: set to 200 in “Targets”", "Fixed: set to 6 in “Not this quarter”"];
  await expect(fixed).toHaveText(made);
  await page.reload();
  await expect(fixed).toHaveText(made);
});
