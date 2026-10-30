import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { quoteLine } from "../components/simple/quote-line";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The fix2-simple-prd review's findings on the one-pager, driven through the UI against the
 * mock (invented data): who may start a review (the start API's rule: an owner or the PRD's
 * decider), Escape in the dialogs over open sources, the margin note's flow dialog, a missing
 * PRD's page and the risk wording.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function seed(page: Page, key: string, value: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value] as const);
}

async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByTestId("one-pager")).toBeVisible();
}

const line = (page: Page, id: string) => page.locator(`[data-line="${id}"]`);

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("a decider-less track owner who approves edits lines but reads who starts a review (qa-10)", async ({ page }) => {
      // The approver owns Guided setup's track; the PRD has no decider.
      await seed(page, MOCK_MEETINGS_KEY, "track-owner");
      await open(page, "approver@example.com");
      const bet = line(page, "bets-1");
      await bet.hover();
      await expect(bet.getByRole("button", { name: "Edit “A setup checklist that shows" })).toBeAttached();
      const start = page.getByRole("button", { name: "Start review" });
      await expect(start).toBeDisabled();
      await expect(page.getByText("Ask an owner to start a review")).toBeVisible();
      await expect(page.getByText(/owner or approver/)).toHaveCount(0);
    });

    test("the PRD's decider starts its review from the one-pager (qa-10)", async ({ page }) => {
      await seed(page, MOCK_SCENARIO_KEY, "simple-deciders");
      await open(page, "dana.decider@example.com");
      await page.getByRole("button", { name: "Start review" }).click();
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      await expect(sheet.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
      await expect(sheet.getByTestId("start-not-allowed")).toHaveCount(0);
    });

    test("a viewer is told the decider or an owner starts the review (qa-10)", async ({ page }) => {
      await seed(page, MOCK_SCENARIO_KEY, "simple-deciders");
      await open(page, "viewer@example.com");
      await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
      await expect(page.getByText("Ask Dana Decider or an owner to start a review")).toBeVisible();
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("Escape in the start sheet closes the sheet, not the line's open sources", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /A setup checklist that shows the next step/ }).click();
    const sources = page.getByRole("region", { name: "Sources of “A setup checklist that shows" });
    await expect(sources).toBeVisible();
    await page.getByRole("button", { name: "Start review" }).click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(sources).toBeVisible();
  });

  test("Escape closes a margin note's flow, and only the flow", async ({ page }) => {
    await open(page);
    const bet = line(page, "bets-1");
    await bet.hover();
    await bet.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
    await page.getByLabel("New wording for").fill("A setup checklist that shows the next two steps");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("button", { name: /A setup checklist that shows the next two/ }).click();
    const sources = page.getByRole("region", { name: /^Sources of “A setup checklist/ });
    await expect(sources).toBeVisible();
    const note = page.getByRole("complementary", { name: "Changes and proposals" }).getByRole("note").first();
    await note.getByRole("button", { name: /^Flow for/ }).click();
    const flow = page.getByRole("dialog", { name: "User flow" });
    await expect(flow).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(flow).toHaveCount(0);
    await expect(sources).toBeVisible();
  });

  test("a missing PRD's address says so under a page title", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers/no-such-prd");
    // qa-shell-11: the app's not-found pattern.
    await expect(page.getByRole("heading", { level: 1, name: "One-pager not found" })).toBeVisible();
    await expect(page.getByText("This one-pager doesn't exist or was deleted.")).toBeVisible();
    await expect(page.getByText(/^Not found$/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to One-pagers" })).toBeVisible();
  });
});

test("a note's line with no earlier words is named by the line's own (OnePager quoteLine)", () => {
  expect(quoteLine("")).toBe("");
  expect(quoteLine("   ")).toBe("");
  expect(quoteLine(undefined)).toBe("");
  expect(quoteLine("A setup checklist that shows the next step")).toBe("“A setup checklist that shows…”");
});
