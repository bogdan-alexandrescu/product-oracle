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
 * - protects=a viewer reads no fix; fails_when=a viewer is offered "Use 6".
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

const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
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
        await expect(look(page).getByRole("status")).toHaveText("Set to 6");
        await look(page).getByRole("button", { name: "Undo" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([COUNT, PER]);
        await expect(item(page, COUNT).getByRole("button", { name: "Use 6" })).toBeVisible();
        await expect(look(page).getByRole("status")).toHaveCount(0);
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
