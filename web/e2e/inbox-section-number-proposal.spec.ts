import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * A proposed number fix on a one-pager ("Use 6", set_section_number) in the decider's Inbox
 * (PR 1320 merge re-review). The mock's invented PRD "Guided setup" in "simple-deciders" with
 * "track-owner": its "Not this quarter" section says eight features over six listed; Priya
 * Raman (an approver owning its track: Needs a look, where Use 6 is, shows only to whoever
 * owns the PRD) proposes 6; Dana Decider, the PRD's decider, decides.
 *
 * Card inbox-section-number-proposal: protects = the decider's Inbox row reads "Section number
 * on Guided setup: Use 6" and as proposed; its Open lands on the one-pager at that PRD section;
 * the side menu's Roadmap count is what it was before the proposal; fails_when = the row reads
 * "An item", Open goes to a roadmap, or the Roadmap count goes up by the proposal; no_claim =
 * the API's row (api tests/test_inbox_section_number_proposals.py).
 */

const DESKTOP = { width: 1440, height: 900 };
const ONE_PAGER = "/simple/one-pagers/guided-setup";
const COUNT = "Numbers disagree in “Not this quarter”";
const NAME = "Section number on Guided setup: Use 6";
const DECIDER = "dana.decider@example.com";

const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
const item = (page: Page, text: string) => look(page).getByRole("listitem").filter({ has: page.getByTestId("needs-look-line").getByText(text, { exact: true }) });

/** The side menu's Roadmap count on Simple's Home, once the rail's counts are read (0 when it shows none). */
async function roadmapCount(page: Page): Promise<number> {
  await page.goto("/simple");
  const rail = page.getByTestId("simple-nav");
  await expect(rail.getByTestId("simple-nav-inbox-count")).toBeVisible();
  const count = rail.getByTestId("simple-nav-roadmap-count");
  return (await count.count()) ? Number((await count.textContent())!.trim()) : 0;
}

test.use({ viewport: DESKTOP });

test("a proposed section number reads as one in the Inbox, opens on its section and stays out of the Roadmap count", async ({ page }) => {
  test.setTimeout(120_000);
  await page.context().addInitScript(
    ([sKey, s, mKey, m]) => {
      localStorage.setItem(sKey, s);
      localStorage.setItem(mKey, m);
    },
    [MOCK_SCENARIO_KEY, "simple-deciders", MOCK_MEETINGS_KEY, "track-owner"] as const,
  );
  // The decider reads the roadmap first (Oracle's dates and goal suggestions are made as it is first read).
  await login(page, DECIDER);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  const before = await roadmapCount(page);
  await page.goto("/home");
  await signOut(page);

  await login(page, "approver@example.com");
  await page.goto(ONE_PAGER);
  await item(page, COUNT).getByRole("button", { name: "Use 6" }).click();
  await expect(item(page, COUNT).getByTestId("needs-look-proposal")).toHaveText("Waiting for approval");
  await page.goto("/home");
  await signOut(page);

  await login(page, DECIDER);
  expect(await roadmapCount(page)).toBe(before);
  await page.getByTestId("simple-nav").getByRole("link", { name: "Inbox", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: NAME }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("An item");
  await expect(row.getByTestId("meeting-proposal-context")).toContainText("Proposed setting the number in “Not this quarter” to 6 · asked for by Priya Raman");
  await row.getByRole("link", { name: `Open ${NAME} on its one-pager` }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers\/[^?]+\?section=later$/);
  const section = page.locator('[data-prd-sec="later"]');
  await expect(section).toBeInViewport();
  await expect(section).toContainText("Eight features wait for next quarter");
  // On the one-pager too, the Roadmap count leaves the proposal out.
  const n = page.getByTestId("simple-nav").getByTestId("simple-nav-roadmap-count");
  if (before) await expect(n).toHaveText(String(before));
  else await expect(n).toHaveCount(0);
});
