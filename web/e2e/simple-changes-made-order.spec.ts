import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Simple changes keep the order they were made in (qaC-numfix): the e2e clock is pinned, so
 * two proposals made one after the other share one instant, and only the order they were made
 * in tells them apart. On the mock's invented PRD "guided-setup" (two numbers to fix).
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=a commenter proposes "Use 6" then "Use 200"; the owner (who decides) reads the
 *   two on Home's proposals newest first (the 200 above the 6), accepts both, and the
 *   one-pager lists the fixes in the order made (the 6, then the 200); fails_when=a tie on the
 *   time is broken by the random id or the list's storage order (the page stubs the mock's
 *   ids to fall as changes are made, so an id order reads reversed); no_claim=the API's order
 *   (api tests/test_simple_changes_api.py).
 */

const URL = "/simple/one-pagers/guided-setup";
const COUNT = "Numbers disagree in “Not this quarter”";
const PER = "Numbers disagree in “Targets”";
const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
const item = (page: Page, text: string) => look(page).getByRole("listitem").filter({ has: page.getByTestId("needs-look-line").getByText(text, { exact: true }) });

test("two proposals of one instant list in the order they were made", async ({ page }) => {
  // Each new id is lower than the last: an order by id is the reverse of the order made.
  await page.context().addInitScript(() => {
    let n = 0xffffffff;
    crypto.randomUUID = () => `${(n--).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` as `${string}-${string}-${string}-${string}-${string}`;
  });
  await login(page, "commenter@example.com");
  await page.goto(URL);
  await item(page, COUNT).getByRole("button", { name: "Use 6" }).click();
  await expect(item(page, COUNT).getByTestId("needs-look-proposal")).toHaveText("Waiting for approval");
  await item(page, PER).getByRole("button", { name: "Use 200" }).click();
  await expect(item(page, PER).getByTestId("needs-look-proposal")).toHaveText("Waiting for approval");

  await page.goto("/home");
  await signOut(page);
  await login(page);
  await page.goto("/simple");
  const rows = page.getByTestId("home-proposal");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("to 200");
  await expect(rows.nth(1)).toContainText("to 6");
  await rows.nth(1).getByRole("button", { name: "Accept" }).click();
  await expect(rows).toHaveCount(1);
  await rows.nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(rows).toHaveCount(0);

  await page.goto(URL);
  await expect(look(page).getByTestId("needs-look-fixed").getByRole("status")).toHaveText(["Fixed: set to 6 in “Not this quarter”", "Fixed: set to 200 in “Targets”"]);
});
