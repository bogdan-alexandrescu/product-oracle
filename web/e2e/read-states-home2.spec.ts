import { MOCK_SCENARIO_KEY, REPLACED_PRD_SCENARIO } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * #1586 on Simple's lists and sheets: a read that failed says so (Could not ..., its reason behind
 * an (i)), never reads as "none": no code on a waiting row or an Inbox row, nothing removed, no
 * PRDs you started, no goals, no approved PRDs to replace, no proposals waiting. Each case is
 * checked both ways: answered, then failed. Against the mock's invented data.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const failGets = (page: Page, path: string) => page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);

const loadError = (page: Page, text: string) => page.getByTestId("load-error").filter({ hasText: text });

async function reason(page: Page, at: ReturnType<Page["getByTestId"]>) {
  await at.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
}

test("Home: a waiting row whose roadmap could not be read says its code could not be checked, never no code", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  const list = page.getByTestId("home-also-waiting-list");
  const health = () => list.getByTestId("waiting-item").filter({ hasText: "Health log" }).first();
  await expect(health()).toContainText("F-03");
  await expect(list.getByTestId("item-ref-failed")).toHaveCount(0);

  await failGets(page, "/v1/simple/roadmap");
  await page.reload();
  const failed = health().getByTestId("item-ref-failed");
  await expect(failed).toContainText("Could not check its code.");
  await expect(health()).not.toContainText("F-03");
  await reason(page, failed);
});

test("Inbox: a Dates row whose roadmap could not be read says its code could not be checked, never no code", async ({ page }) => {
  await login(page);
  await page.goto("/simple/inbox");
  const names = page.locator('[data-testid="date-suggestion-context"]').locator("xpath=..");
  await expect(names.getByTestId("feature-name").first().locator("span.simple-code")).toBeVisible();
  await expect(names.getByTestId("item-ref-failed")).toHaveCount(0);

  await failGets(page, "/v1/simple/roadmap");
  await page.reload();
  const failed = names.getByTestId("item-ref-failed").first();
  await expect(failed).toContainText("Could not check its code.");
  await expect(names.getByTestId("feature-name").first().locator("span.simple-code")).toHaveCount(0);
  await reason(page, failed);
});

test("Roadmap: a Removed list that could not be read says so, never an empty list", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap");
  const button = page.getByTestId("removed-open");
  const list = page.getByRole("dialog", { name: "Removed from your plans" });
  await expect(button).toHaveText(/Removed · \d+/);
  await button.click();
  await expect(list.getByTestId("removed-row").first()).toBeVisible();
  await expect(list.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/simple/removed");
  await page.reload();
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("removed-open").click();
  const failed = list.getByTestId("load-error");
  await expect(failed).toContainText("Could not load what was removed.");
  await expect(list.getByTestId("removed-row")).toHaveCount(0);
  await expect(list.getByText("Nothing removed")).toHaveCount(0);
  await reason(page, failed);
});

test("Roadmap: a feature's proposals that could not be read say so, never No proposals waiting", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap");
  await openRoadmapItem(page, "alert-rules");
  const card = page.getByTestId("floating-card");
  await expect(card.getByText("No proposals waiting", { exact: true })).toBeVisible();
  await expect(card.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/simple/changes");
  await page.reload();
  await openRoadmapItem(page, "alert-rules");
  const failed = page.getByTestId("floating-card").getByTestId("load-error").filter({ hasText: "Could not load the proposals." });
  await expect(failed).toBeVisible();
  await expect(page.getByTestId("floating-card").getByText("No proposals waiting", { exact: true })).toHaveCount(0);
  await reason(page, failed);
});

test("One-pagers: the PRDs you started that could not be read say so, never left out", async ({ page }) => {
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
  await expect(page.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/intakes");
  await page.reload();
  const failed = loadError(page, "Could not load the PRDs you started.");
  await expect(failed).toBeVisible();
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
  await reason(page, failed);
});

test("New PRD: goals that could not be read say so, never only Not sure yet", async ({ page }) => {
  await login(page);
  await page.goto("/simple/one-pagers");
  const open = async () => {
    await page.getByTestId("simple-one-pagers").getByRole("button", { name: "New PRD" }).click();
    return page.getByTestId("np-sheet").getByRole("group", { name: "The goals it helps" });
  };
  const goals = await open();
  await expect(goals.getByRole("button", { name: "Activation" })).toBeVisible();
  await expect(goals.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/baseline/entities?type=goal&status=confirmed");
  await page.reload();
  const failedGoals = await open();
  const failed = failedGoals.getByTestId("load-error");
  await expect(failed).toContainText("Could not load the goals.");
  await expect(failedGoals.getByRole("button", { name: "Activation" })).toHaveCount(0);
  await expect(failedGoals.getByRole("button", { name: "Not sure yet" })).toBeVisible();
  await reason(page, failed);
});

test("New PRD: approved PRDs that could not be read say so, never only None: a new PRD", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, REPLACED_PRD_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  const open = async () => {
    await page.getByTestId("simple-page").getByRole("button", { name: "New PRD" }).click();
    return page.getByTestId("np-sheet").getByRole("group", { name: /Replaces/ });
  };
  const replaces = await open();
  await expect(replaces.getByLabel("Approved PRD it replaces").locator("option", { hasText: "Usage alerts PRD" })).toHaveCount(1);
  await expect(replaces.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/documents?kind=prd");
  await page.reload();
  const failedReplaces = await open();
  const failed = failedReplaces.getByTestId("load-error");
  await expect(failed).toContainText("Could not load the approved PRDs.");
  await expect(failedReplaces.getByLabel("Approved PRD it replaces").locator("option", { hasText: "Usage alerts PRD" })).toHaveCount(0);
  await reason(page, failed);
});
