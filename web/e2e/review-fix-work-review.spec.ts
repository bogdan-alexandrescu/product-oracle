import { expect, test, type Page } from "./test";

import { MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { datesInWords, showValue } from "../app/runs/[id]/review/[checkpoint]/_items-lib";
import { login } from "./helpers";

/*
 * fix-work review findings, driven through the UI on the mock API (the dates check is a unit
 * check: no browser):
 * - the Interviews tab's Finished column reads "just now", never "now ago";
 * - the Roadmap items review's tally and its Approve line count the same thing, items: an item
 *   with two blocking reasons is one blocking problem in both;
 * - dates in words only where they are dates: a key such as launch-2026-11-30 stays as written.
 */

const bar = (page: Page) => page.getByTestId("decision-bar");

/** The fixture's customer answers every question (the short one gets its follow-up) and sends them. */
async function finishInterview(page: Page) {
  await page.goto(`/i/${MOCK_INTERVIEW_TOKEN}`);
  await page.getByRole("button", { name: "Start" }).click();
  const answer = async (text: string) => {
    await page.getByTestId("interview-input").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("msg-customer").filter({ hasText: text })).toBeVisible();
    await expect(page.getByTestId("interview-typing")).toHaveCount(0);
  };
  await answer("Last Tuesday our accountant spent the whole morning paying twelve suppliers one by one.");
  await answer("We use bank transfers.");
  await answer("Each Friday I export the invoices and type every transfer into the bank site by hand.");
  await page.getByRole("button", { name: "Skip this question" }).click();
  await expect(page.getByTestId("interview-progress")).toHaveText("4 of 4");
  await answer("In September a typo sent a payment to the wrong supplier and it took two weeks to recover.");
  await page.getByRole("button", { name: "Send my answers" }).click();
  await expect(page.getByTestId("interview-thanks")).toBeVisible();
}

test("fix-work review: an interview finished a moment ago reads 'just now', not 'now ago'", async ({ page }) => {
  await finishInterview(page);
  await login(page, "commenter@example.com");
  await page.goto("/requests/interviews");
  const row = page.getByTestId("interview-row").filter({ hasText: "Ana Lima" });
  await expect(row.getByTestId("interview-status")).toHaveText("Finished");
  await expect(row.getByTestId("interview-finished")).toHaveText("just now");
});

/**
 * The seeded roadmap review run with a second blocking reason on Usage export: three items
 * block (Slack alerts, Budget caps, Usage export) on four blocking reasons.
 */
async function seedTwoReasonsOnOneItem(page: Page): Promise<string> {
  const run = JSON.parse(JSON.stringify(ROADMAP_REVIEW_RUN.run)) as typeof ROADMAP_REVIEW_RUN.run;
  const second = {
    item: "usage-export",
    item_title: "Usage export",
    code: "horizon_breaks_dependency",
    severity: "blocking" as const,
    label: "Depends on a later item",
    text: "Needs Anomaly detection, which is in Later. An item cannot ship before what it depends on.",
    data: { dependency: "anomaly-detection", dependency_horizon: "later" },
    fixes: [{ label: "Move to Later", action: { kind: "edit" as const, item: "usage-export", field: "horizon", value: "later" } }],
  };
  // The review reads the segment's check, the gate the checkpoint's: both carry the reason.
  const [items] = run.segments;
  const payload = run.checkpoints[0].payload as { items_check?: typeof items.items_check };
  for (const check of [items.items_check, payload.items_check]) {
    if (!check) continue;
    const at = check.reasons.findIndex((r) => r.item === "usage-export");
    check.reasons.splice(at + 1, 0, second);
    check.blocking += 1;
  }
  return page.evaluate(
    (seed) => {
      type Db = { runs: { runs: { id: string }[]; artifacts: Record<string, string> } };
      const write = (globalThis as { __poMockWrite?: (change: (db: Db) => string) => Promise<string> }).__poMockWrite;
      if (!write) throw new Error("The mock API is not loaded: sign in before seeding");
      return write((db) => {
        db.runs.runs = db.runs.runs.filter((r) => r.id !== seed.run.id);
        db.runs.runs.push(seed.run);
        Object.assign(db.runs.artifacts, seed.artifacts);
        return seed.run.id;
      });
    },
    { run, artifacts: ROADMAP_REVIEW_RUN.artifacts },
  );
}

test("fix-work review: the tally and the Approve line count blocking items alike when an item has two blocking reasons", async ({ page }) => {
  await login(page);
  await seedTwoReasonsOnOneItem(page);
  await page.goto(`/runs/${ROADMAP_REVIEW_RUN.run.id}/review/${ROADMAP_REVIEW_RUN.run.checkpoints[0].id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  const usage = page.locator('[data-testid="roadmap-item-row"][data-key="usage-export"]');
  await expect(usage.getByTestId("reason-chip")).toHaveCount(2);
  await expect(bar(page).getByTestId("tally-second")).toContainText("3 blocking problems left");
  await expect(bar(page).getByTestId("approve-blocked")).toHaveText("3 blocking problems left");
  await expect(bar(page).getByRole("button", { name: /^Approve/ })).toHaveAttribute("title", "3 blocking problems left");
});

test.describe("fix-work review: dates in words only where they are dates", () => {
  test("a reason's sentence: its dates in words, a date inside a key as written", () => {
    expect(datesInWords("No verified estimate, capacity or commitment supports 2026-11-30.")).toBe("No verified estimate, capacity or commitment supports Nov 30, 2026.");
    expect(datesInWords("Depends on launch-2026-11-30, which is in Later.")).toBe("Depends on launch-2026-11-30, which is in Later.");
    expect(datesInWords("See docs/2026-11-30/notes and v1.2026-11-30")).toBe("See docs/2026-11-30/notes and v1.2026-11-30");
    expect(datesInWords("Planned for 2026-11-30 (was 2026-12-15)")).toBe("Planned for Nov 30, 2026 (was Dec 15, 2026)");
  });

  test("a changed field's value: a date in words, a key as written", () => {
    expect(showValue("milestone_date", "2026-11-30")).toBe("Nov 30, 2026");
    expect(showValue("milestone.date", null)).toBe("none");
    expect(showValue("depends_on", ["launch-2026-11-30"])).toBe("launch-2026-11-30");
    expect(showValue("prd_section", "release-2026-11-30")).toBe("release-2026-11-30");
    expect(showValue("title", "launch-2026-11-30")).toBe("launch-2026-11-30");
    expect(showValue("outcome", "Ships 2026-11-30 to every team")).toBe("Ships Nov 30, 2026 to every team");
    expect(showValue("horizon", "later")).toBe("Later");
  });
});
