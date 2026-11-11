import type { Locator, Page } from "@playwright/test";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITIES_TWINS_OLD_SCENARIO, TWINS } from "../lib/api/mock/simple-priorities";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test } from "./test";

/*
 * prio-twin-propose (the owner, Nov 10: "Offer a proposal"): on "priorities-twins-old" (invented data) Block list's
 * twin is a separate Ground Truth feature whose only item is on an older roadmap. A commenter, who may not merge
 * Ground Truth features, gets "Propose a merge…" where an approver gets "Merge into…"; the proposal waits in the
 * owner's Inbox under Needs a decision. Accepted, the same merge runs (the twin leaves Block list's row); declined,
 * nothing changes (the twin stays). Desktop 1440x900 and phone 390x844.
 */

async function as(page: Page, email: string): Promise<void> {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

async function priorities(page: Page): Promise<void> {
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
}

const twinOf = (page: Page): Locator =>
  page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(TWINS.unlinked, { exact: true }) }).getByTestId("prio-twin");

/** The commenter, signed in on Priorities, proposes merging Block list's twin into its row. */
async function proposeOn(page: Page): Promise<void> {
  const twin = twinOf(page);
  await expect(twin).toHaveCount(1);
  await expect(twin.getByRole("button", { name: "Merge into…" })).toHaveCount(0);
  await twin.getByRole("button", { name: "Propose a merge…" }).click();
  await twin.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(page.getByText(/^Proposed: /)).toBeVisible();
  // Nothing is merged until it is decided.
  await expect(twinOf(page)).toHaveCount(1);
}

/** The commenter proposes merging Block list's twin into its row, then the owner opens the Inbox. */
async function propose(page: Page): Promise<Locator> {
  await login(page, "commenter@example.com");
  await priorities(page);
  await proposeOn(page);
  await as(page, ADMIN.email);
  await page.goto("/inbox");
  const row = page.getByRole("row").filter({ hasText: `into “${TWINS.unlinked}”` });
  await expect(row).toHaveCount(1);
  return row;
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, PRIORITIES_TWINS_OLD_SCENARIO, THEME_KEY] as const,
  );
});

for (const phone of [false, true]) {
  test.describe(phone ? "390px" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("a commenter proposes a twin's merge; the owner accepts it in the Inbox and it is merged", async ({ page }) => {
      test.setTimeout(120_000);
      const row = await propose(page);
      await row.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByRole("row").filter({ hasText: `into “${TWINS.unlinked}”` })).toHaveCount(0);
      await priorities(page);
      await expect(twinOf(page)).toHaveCount(0);
    });

    test("a waiting twin merge shows on its twin, with no second merge offered", async ({ page }) => {
      test.setTimeout(120_000);
      await login(page, "commenter@example.com");
      await priorities(page);
      await proposeOn(page);
      // The commenter sees their proposal on the twin, and may take it back; no second Propose.
      await expect(twinOf(page).getByTestId("prio-proposal")).toHaveCount(1);
      await expect(twinOf(page).getByTestId("prio-proposal").getByRole("button", { name: "Withdraw" })).toBeVisible();
      await expect(twinOf(page).getByRole("button", { name: "Propose a merge…" })).toBeDisabled();
      // The owner sees it waiting there too, and decides it in place rather than merging around it.
      await as(page, ADMIN.email);
      await priorities(page);
      await expect(twinOf(page).getByRole("button", { name: "Merge into…" })).toBeDisabled();
      await twinOf(page).getByTestId("prio-proposal").getByRole("button", { name: "Accept" }).click();
      await expect(twinOf(page)).toHaveCount(0);
      await page.goto("/inbox");
      await expect(page.getByRole("row").filter({ hasText: `into “${TWINS.unlinked}”` })).toHaveCount(0);
    });

    test("a twin merged directly closes its waiting proposal", async ({ page, context }) => {
      test.setTimeout(120_000);
      // The owner has Priorities open; meanwhile the commenter proposes the merge in another tab.
      await login(page, ADMIN.email);
      await priorities(page);
      const theirs = await context.newPage();
      await theirs.setViewportSize(page.viewportSize()!);
      // It opens signed in as the owner: sign out there, then in as the commenter.
      await as(theirs, "commenter@example.com");
      await priorities(theirs);
      await proposeOn(theirs);
      await twinOf(page).getByRole("button", { name: "Merge into…" }).click();
      await twinOf(page).getByRole("button", { name: "Merge", exact: true }).click();
      await expect(twinOf(page)).toHaveCount(0);
      // The proposal is closed: nothing is left to decide.
      await page.goto("/inbox");
      await expect(page.getByRole("heading").first()).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: `into “${TWINS.unlinked}”` })).toHaveCount(0);
    });

    test("a declined twin merge changes nothing", async ({ page }) => {
      test.setTimeout(120_000);
      const row = await propose(page);
      await row.getByRole("button", { name: "Decline" }).click();
      await expect(page.getByRole("row").filter({ hasText: `into “${TWINS.unlinked}”` })).toHaveCount(0);
      await priorities(page);
      await expect(twinOf(page)).toHaveCount(1);
    });
  });
}
