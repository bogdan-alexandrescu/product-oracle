import { MOCK_MEMBERS } from "../lib/api/mock/fixtures";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { THEME_KEY } from "../lib/theme";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The one-pager's "Needs a look" numbers get a one-click fix (owner, Nov 5, 'New change op'),
 * on the mock's invented PRD "guided-setup": "Eight features wait for next quarter" over six
 * items, and 40 a region × 5 regions against a company-wide 250.
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=an owner's "Use 6" sets the number in the PRD's draft: the item leaves the list,
 *   the other stays, the section reads 6, and Undo brings the item back; fails_when=the item
 *   has no fix, the click leaves it, or Undo does not put it back; no_claim=the op's own
 *   rules (api tests/test_simple_one_pager_numbers.py).
 * - protects=an approver who owns the PRD's track (the PRD has a decider) proposes the fix:
 *   the item waits for approval with Withdraw; the owner reads the proposal on the item and
 *   accepts it, and the item leaves; fails_when=the approver's click writes the PRD, or the
 *   owner cannot accept it there.
 * - protects=each fix in the working draft is listed ("Fixed: set to 6 in “Not this
 *   quarter”") with its own Undo, after a reload too; Undo of one leaves the other (fix
 *   round 2; a count in words staying a word is the API's test_a_count_in_words_stays_in_words); fails_when=the draft bar
 *   says "2 changes" and nothing lists them, or only the latest fix has an Undo.
 * - protects=a viewer reads no fix; fails_when=a viewer is offered "Use 6".
 * - protects=while the PRD's draft is in review (sent for approval in another tab) the owner
 *   is offered no fix, the item staying; "Use 6" on a page read before the draft was sent is
 *   refused in the API's own words ("This PRD's draft is in review: ..."), and the page then
 *   reads the PRD again and offers it no more (train AS replay review); fails_when=the owner
 *   is offered "Use 6" in review, or the refusal says the number changed.
 */

const URL = "/simple/one-pagers/guided-setup";
const COUNT = "Numbers disagree in “Not this quarter”";
const PER = "Numbers disagree in “Targets”";

async function setUp(page: Page, scheme: "light" | "dark", scenario = "", meetings = "") {
  await page.context().addInitScript(
    ([sKey, s, mKey, m, tKey, t]) => {
      if (s) localStorage.setItem(sKey, s);
      if (m) localStorage.setItem(mKey, m);
      localStorage.setItem(tKey, t);
    },
    [MOCK_SCENARIO_KEY, scenario, MOCK_MEETINGS_KEY, meetings, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
}

const FIXED_COUNT = "Fixed: set to 6 in “Not this quarter”";
const FIXED_PER = "Fixed: set to 200 in “Targets”";

const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
const fixed = (page: Page) => look(page).getByTestId("needs-look-fixed").getByRole("status");
const fixedItem = (page: Page, text: string) => look(page).getByTestId("needs-look-fixed").filter({ hasText: text });
const item = (page: Page, text: string) => look(page).getByRole("listitem").filter({ has: page.getByTestId("needs-look-line").getByText(text, { exact: true }) });

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test(`an owner fixes a number in one click and undoes it (${where})`, async ({ page }) => {
        await setUp(page, scheme);
        await login(page);
        await page.goto(URL);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([COUNT, PER]);
        await expect(item(page, PER).getByRole("button", { name: "Use 200" })).toBeVisible();
        const use = item(page, COUNT).getByRole("button", { name: "Use 6" });
        if (phone) expect((await use.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await use.click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([PER]);
        await expect(fixed(page)).toHaveText([FIXED_COUNT]);
        await look(page).getByRole("button", { name: "Undo" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([COUNT, PER]);
        await expect(item(page, COUNT).getByRole("button", { name: "Use 6" })).toBeVisible();
        await expect(fixed(page)).toHaveCount(0);
      });

      test(`each fix stays listed with its Undo after a reload (${where})`, async ({ page }) => {
        await setUp(page, scheme);
        await login(page);
        await page.goto(URL);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await item(page, COUNT).getByRole("button", { name: "Use 6" }).click();
        await expect(fixed(page)).toHaveText([FIXED_COUNT]);
        await item(page, PER).getByRole("button", { name: "Use 200" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveCount(0);
        // Both fixes are listed, each with its Undo; the draft bar counts them.
        await expect(fixed(page)).toHaveText([FIXED_COUNT, FIXED_PER]);
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("2 changes");
        // A reload reads them from the draft: still listed, each with its Undo.
        await page.reload();
        await expect(fixed(page)).toHaveText([FIXED_COUNT, FIXED_PER]);
        await expect(look(page).getByRole("button", { name: "Undo" })).toHaveCount(2);
        await fixedItem(page, FIXED_COUNT).getByRole("button", { name: "Undo" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([COUNT]);
        await expect(fixed(page)).toHaveText([FIXED_PER]);
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
      });

      test(`an approver proposes the fix and the owner accepts it on the item (${where})`, async ({ page }) => {
        // The PRD has a decider (Dana Decider); the approver owns its track, so proposes.
        await setUp(page, scheme, "simple-deciders", "track-owner");
        await login(page, "approver@example.com");
        await page.goto(URL);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await item(page, COUNT).getByRole("button", { name: "Use 6" }).click();
        await expect(item(page, COUNT).getByTestId("needs-look-proposal")).toHaveText("Waiting for approval");
        await expect(item(page, COUNT).getByRole("button", { name: "Withdraw" })).toBeVisible();
        await expect(item(page, COUNT).getByRole("button", { name: "Use 6" })).toHaveCount(0);
        // The owner signs in on the same page (the rail's account menu, desktop-wide, as joinMeeting).
        const size = page.viewportSize()!;
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto("/home");
        await signOut(page);
        await login(page);
        await page.setViewportSize(size);
        await page.goto(URL);
        await expect(item(page, COUNT).getByTestId("needs-look-proposal")).toHaveText(/ proposes 6$/);
        await item(page, COUNT).getByRole("button", { name: "Accept" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([PER]);
      });

      test(`a viewer reads no fix (${where})`, async ({ page }) => {
        await setUp(page, scheme);
        await login(page, "viewer@example.com");
        await page.goto(URL);
        await expect(page.getByRole("article", { name: "One-pager" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Use 6" })).toHaveCount(0);
        await expect(look(page)).toHaveCount(0);
      });
    });
  }
}

// Fix round 3: the number changed since the page was read (here in a second tab of the same
// browser, where the mock keeps its state); "Use 6" on the stale page is refused in words,
// names who changed it, and applies nothing.
test("a number changed since the page was read is refused in words", async ({ page }) => {
  await setUp(page, "light");
  await login(page);
  await page.goto(URL);
  const stale = item(page, COUNT).getByRole("button", { name: "Use 6" });
  await expect(stale).toBeVisible();
  // A second tab of the same browser is signed in already.
  const other = await page.context().newPage();
  await other.goto(URL);
  await item(other, COUNT).getByRole("button", { name: "Use 6" }).click();
  await expect(fixed(other)).toHaveText([FIXED_COUNT]);
  await other.close();
  await stale.click();
  const said = page.getByRole("alert").filter({ hasText: "This number changed since you read it" });
  await expect(said).toBeVisible();
  await expect(said).toContainText(`Changed by ${MOCK_MEMBERS[0].name}`);
  // Nothing applied: the page now reads the draft as it is, with the one fix made in the other tab.
  await expect(fixed(page)).toHaveText([FIXED_COUNT]);
  await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
});

// Train AS replay review: while the PRD's draft is in review a fix that applies is refused,
// so the owner is offered none; "Use 6" on a page read before the draft was sent says the
// API's own words, never that the number changed.
test("while the PRD's draft is in review the fix waits, and a refusal says why", async ({ page }) => {
  await setUp(page, "light");
  await login(page);
  await page.goto(URL);
  await item(page, PER).getByRole("button", { name: "Use 200" }).click();
  await expect(fixed(page)).toHaveText([FIXED_PER]);
  const readBefore = item(page, COUNT).getByRole("button", { name: "Use 6" });
  await expect(readBefore).toBeVisible();
  // A second tab of the same browser sends the draft for approval.
  const other = await page.context().newPage();
  await other.goto(URL);
  const bar = other.getByRole("status", { name: "Working draft" });
  await bar.getByRole("button", { name: "Send for approval…" }).click();
  await other.getByTestId("send-for-approval").getByRole("button", { name: "Send for approval" }).click();
  await expect(bar.getByTestId("draft-waits-on")).toContainText("Sent for approval · waiting on");
  // In review: the item stays, with no fix to click.
  await expect(item(other, COUNT)).toBeVisible();
  await expect(item(other, COUNT).getByRole("button", { name: "Use 6" })).toHaveCount(0);
  await other.close();
  await readBefore.click();
  await expect(page.getByRole("alert").filter({ hasText: "This PRD's draft is in review: changes wait until it is approved" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "This number changed since you read it" })).toHaveCount(0);
  // The page reads the PRD again: the item stays, and its fix waits for the review.
  await expect(item(page, COUNT)).toBeVisible();
  await expect(item(page, COUNT).getByRole("button", { name: "Use 6" })).toHaveCount(0);
});
