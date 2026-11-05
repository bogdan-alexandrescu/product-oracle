import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { ROADMAP_REVIEW_RUN, RUN_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, seedRun } from "./helpers";

/*
 * Visual QA pass B (task_5580666d17444da7935f) on Runs, Inbox and Priorities, driven through
 * the UI on the mock:
 * B-06 a roadmap reason reads its date month first on the run page, also one stored before
 *      the API wrote it so;
 * B-16 the PRD review line takes the full width on a phone, Open review below it;
 * B-17 a viewer's runs list says who a waiting review waits on;
 * B-21 the runs list filters by state and by words;
 * B-15 an Inbox date suggestion after the planning horizon carries a Far out chip;
 * B-22 three or more runs of one flow waiting at the same stop read as one Inbox row;
 * B-19 Priorities follows the scenario: none for a new company, many for a large one.
 */

const scenario = (page: Page, name: string) => page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, name] as const);
const rows = (page: Page) => page.getByTestId("run-row");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("B-06: a stored ISO date in a roadmap reason reads month first on the run page", async ({ page }) => {
    // A run past its Roadmap items stop (its reasons listed on the run page), with a reason
    // stored before the API wrote days month first.
    const run = JSON.parse(JSON.stringify(ROADMAP_REVIEW_RUN)) as typeof ROADMAP_REVIEW_RUN;
    for (const c of run.run.checkpoints) c.status = "approved";
    const [items] = run.run.segments;
    for (const r of items.items_check!.reasons) r.text = r.text.replace("Nov 30, 2026", "2026-11-30");
    await login(page);
    await seedRun(page, run);
    await page.goto(`/runs/${run.run.id}`);
    const reason = page.locator('[data-testid="item-reason"][data-code="unverified_date"]').getByTestId("reason-text");
    await expect(reason).toHaveText("No verified estimate, capacity or commitment supports Nov 30, 2026.");
    await expect(page.getByTestId("items-reasons")).not.toContainText("2026-11-30");
  });

  test("B-17: a viewer's runs list says the approvers review a run waiting at its checkpoint", async ({ page }) => {
    await login(page, "viewer@example.com");
    await page.goto("/runs");
    await expect(page.getByTestId("runs-waiting-others")).toBeVisible();
    const waiting = rows(page).filter({ has: page.getByTestId("run-status").getByText("Waiting for review", { exact: true }) });
    await expect(waiting.first()).toBeVisible();
    for (const row of await waiting.all()) await expect(row.getByTestId("run-waits-on")).toHaveText("Approvers review");
    await expect(page.getByTestId("run-waits-on").filter({ hasText: /^Owner approves \$/ })).toHaveCount(1);
  });

  test("B-21: a large runs list filters by Waiting on me, Running and Done, and by search", async ({ page }) => {
    await scenario(page, "large");
    await login(page);
    await page.goto("/runs");
    const filters = page.getByRole("group", { name: "Show runs" });
    const all = filters.getByRole("button", { name: /^All/ });
    await expect(all).toHaveAttribute("aria-pressed", "true");
    const total = Number(await all.locator("b").textContent());
    expect(total).toBeGreaterThan(50);
    await expect(rows(page)).toHaveCount(total);

    await filters.getByRole("button", { name: /^Running/ }).click();
    const running = Number(await filters.getByRole("button", { name: /^Running/ }).locator("b").textContent());
    expect(running).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(running);
    for (const s of await rows(page).getByTestId("run-status").allTextContents()) expect(["Running", "Delivering decision"]).toContain(s);
    await expect(page.getByTestId("panel-count")).toHaveText(`${running} of ${total}`);

    await filters.getByRole("button", { name: /^Waiting on me/ }).click();
    const mine = Number(await filters.getByRole("button", { name: /^Waiting on me/ }).locator("b").textContent());
    await expect(rows(page)).toHaveCount(mine);
    await expect(page.getByTestId("runs-table").getByRole("button")).toHaveCount(mine);

    await filters.getByRole("button", { name: /^Done/ }).click();
    for (const s of await rows(page).getByTestId("run-status").allTextContents()) expect(["Succeeded", "Failed", "Cancelled"]).toContain(s);

    await filters.getByRole("button", { name: /^All/ }).click();
    const search = page.getByRole("searchbox", { name: "Search runs" });
    await search.fill("checkout");
    await expect(rows(page).first()).toBeVisible();
    for (const t of await rows(page).allTextContents()) expect(t.toLowerCase()).toContain("checkout");
    await search.fill("no run is called this");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId("runs-none-match")).toBeVisible();
  });

  test("B-15: an Inbox date suggestion after the planning horizon is marked Far out, its reason on hover", async ({ page }) => {
    await scenario(page, "inbox-reviewer");
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.goto("/inbox");
    const contexts = page.getByTestId("date-suggestion-context");
    await expect(contexts.first()).toBeVisible();
    const far = contexts.filter({ has: page.getByTestId("date-suggestion-far-out") });
    await expect(far.first()).toBeVisible();
    const chip = far.first().getByTestId("date-suggestion-far-out");
    await expect(chip).toHaveText("Far out");
    await expect(chip).toHaveAttribute("title", "Low confidence, after the planning horizon (Feb 28, 2027)");
    // Only a suggestion that ends after Feb 28, 2027 carries it.
    for (const t of await contexts.allTextContents()) {
      const year = Number(/(\d{4})(?!.*\d{4})/.exec(t)?.[1]);
      if (t.includes("Far out")) expect(year).toBeGreaterThanOrEqual(2027);
      else expect(/2027|2028/.test(t) && !/(Jan|Feb) \d{1,2}, 2027$/.test(t.trim())).toBe(false);
    }
  });

  test("B-22: three or more runs waiting at the same stop read as one Inbox row, each run with its own action", async ({ page }) => {
    await scenario(page, "large");
    await login(page);
    await page.goto("/inbox");
    const group = page.getByTestId("checkpoint-group").first();
    await expect(group).toHaveText(/ · \d+ runs$/);
    const n = Number(/(\d+) runs$/.exec((await group.textContent())!)![1]);
    expect(n).toBeGreaterThan(5);
    // The count still counts each run: the rail badge and the heading agree.
    const waiting = (await page.getByTestId("nav-inbox-badge").first().textContent())!.trim();
    await expect(page.getByText(`${waiting} waiting`)).toBeVisible();
    await expect(page.getByTestId("inbox-needs").getByTestId("panel-count")).toHaveText(waiting);
    // Each run of the group is a line under it with one action of its own.
    const groupRow = page.getByRole("row").filter({ has: group });
    await expect(groupRow.getByRole("link")).toHaveCount(0);
    const under = page.locator("tr[data-child-of]").filter({ has: page.getByTestId("checkpoint-label") });
    await expect(under).toHaveCount(n);
  });

  test("B-19: Priorities follows the scenario: none for a new company, many for a large one", async ({ browser }) => {
    for (const [name, check] of [
      ["empty", (n: number) => expect(n).toBe(0)],
      ["large", (n: number) => expect(n).toBeGreaterThan(30)],
    ] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await scenario(page, name);
      await login(page, "approver@example.com");
      await page.goto("/priorities");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      check(await page.locator('tr[data-testid^="priority-row-"]').count());
      await page.close();
    }
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("B-16: the PRD review line takes the full width on a phone, Open review below it", async ({ page }) => {
    await scenario(page, "run-review");
    await login(page);
    await page.goto(`/runs/${RUN_REVIEW_RUN}`);
    const panel = page.getByTestId("checkpoint-prd_review").filter({ visible: true });
    const text = panel.getByTestId("run-review-summary");
    await expect(text).toHaveText("Waiting for review of v2 · 0/3 sections reviewed");
    const line = await text.boundingBox();
    const button = await panel.getByRole("link", { name: "Open review" }).boundingBox();
    const box = await panel.boundingBox();
    // One or two lines, never a word per line; the button on its own line below.
    expect(line!.height).toBeLessThan(60);
    expect(line!.width).toBeGreaterThan(box!.width * 0.75);
    expect(button!.y).toBeGreaterThanOrEqual(line!.y + line!.height - 1);
  });
});
