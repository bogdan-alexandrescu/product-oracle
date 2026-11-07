import { expect, test, type Page } from "./test";

import { CONSOLE_HELD_RUN, CONSOLE_HELD_RUN_ID } from "../lib/api/mock/runs";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSeeded, seedConsoleHeld, seedRun } from "./helpers";

/**
 * Run review stops, follow-ups: the Engineering check's staged chips name each change, and the
 * run page's Roadmap items stop rows carry their ref and say a refused Waive where it was
 * pressed. Driven through the UI over the mock API.
 *
 * Test cards (protects / fails_when / no_claim):
 * - staged-names: protects=each staged change reads "<feature>: <change>", three at most, then a
 *   count; fails_when=the bar reads "N changes staged" alone; no_claim=the run page's chips.
 * - stop-ref: protects=a Roadmap items stop row carries its ref (the gate's name for it);
 *   fails_when=no data-ref; no_claim=the gate rows (run-detail-gate-waive.spec.ts).
 * - stop-waive: protects=a stop row's Waive… asks for a reason there and stages the waiver;
 *   a refused one keeps its reason with the API's words under that row; fails_when=it posts
 *   with no reason or says the refusal only under the whole list; no_claim=the API's refusal.
 */

const REASON = "Section lands in the next PRD version";
const row = (page: Page, key: string) =>
  page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const inspector = (page: Page) => page.getByTestId("brief-inspector");
const decision = (page: Page) =>
  page.getByRole("group", { name: "Decide: Roadmap items" });
const stopRow = (page: Page, ref = "unknown_prd_section") =>
  page.locator(
    `[data-testid="item-reasons"][data-item="usage-export"] [data-testid="item-reason"][data-ref="${ref}"]`,
  );

/** The console-held run with Usage export outside the product strategy: a stop row the API offers Waive… on. */
const DRIFT_RUN = JSON.parse(
  JSON.stringify(CONSOLE_HELD_RUN),
) as typeof CONSOLE_HELD_RUN;
DRIFT_RUN.run.segments
  .find((s) => s.items_check)!
  .items_check!.reasons.push({
    item: "usage-export",
    item_title: "Usage export",
    code: "outside_strategy",
    severity: "confirm",
    label: "Outside the strategy",
    text: "Retention is under no focus choice of the product strategy.",
    data: { severity: "warning", choices: [], goals: ["retention"] },
    fixes: [
      {
        label: "Drop",
        action: {
          item: "usage-export",
          kind: "drop",
          field: null,
          value: null,
        },
      },
      {
        label: "Waive…",
        action: {
          item: "usage-export",
          kind: "waive",
          field: null,
          value: null,
        },
      },
    ],
  });
const drift = (page: Page) => stopRow(page, "outside_strategy");

async function verdict(page: Page, key: string, choice: string) {
  await row(page, key).getByRole("button").first().click();
  await inspector(page)
    .getByRole("group", { name: "Verdict" })
    .getByRole("button", { name: choice, exact: true })
    .click();
  await expect(row(page, key).getByTestId("brief-verdict")).toHaveText(choice);
}

test("the staged chips name each change by its feature, with a count only past three", async ({
  page,
}) => {
  await page.addInitScript(
    ([key, s]) => localStorage.setItem(key, s),
    [MOCK_SCENARIO_KEY, "eng-check"],
  );
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  await page
    .getByTestId("inbox-checkpoints")
    .locator("tr[data-row]")
    .filter({ hasText: "Engineering check" })
    .getByRole("link", { name: "Review" })
    .click();
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
  const bar = page.getByTestId("decision-bar");

  await verdict(page, "f.guided-setup", "Feasible");
  await inspector(page)
    .getByRole("textbox", { name: /^Answer: Does the payment sandbox/ })
    .fill("Yes, the sandbox takes test orders.");
  await inspector(page).getByRole("button", { name: "Answer" }).first().click();
  await inspector(page)
    .getByRole("group", { name: "Size" })
    .getByRole("button", { name: "XL" })
    .click();
  await expect(bar.getByTestId("staged-chip")).toHaveText([
    "Guided setup: Feasible",
    "Guided setup: Blocking question answered",
    "Guided setup: Size XL",
  ]);
  await expect(bar.getByTestId("staged-more")).toHaveCount(0);
  await expect(bar).not.toContainText("changes staged");

  await verdict(page, "f.saved-carts", "Feasible");
  await expect(bar.getByTestId("staged-chip")).toHaveCount(3);
  await expect(bar.getByTestId("staged-more")).toHaveText("1 more change");
  await expect(bar.getByTestId("staged-more")).toHaveAttribute(
    "title",
    "Saved carts: Feasible",
  );
});

test("a Roadmap items stop row carries its ref", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
  await expect(stopRow(page)).toHaveCount(1);
  await expect(stopRow(page)).toContainText("No PRD section");
});

test("a stop row's Waive… asks for a reason there and stages the waiver", async ({
  page,
}) => {
  await login(page);
  await openSeeded(
    page,
    (p) => seedRun(p, DRIFT_RUN),
    `/runs/${CONSOLE_HELD_RUN_ID}`,
  );
  await drift(page).getByRole("button", { name: "Waive…" }).click();
  await drift(page)
    .getByRole("textbox", { name: /^Reason to waive/ })
    .fill(REASON);
  await drift(page).getByRole("button", { name: "Waive", exact: true }).click();
  await expect(drift(page).getByRole("textbox")).toHaveCount(0);
  await expect(
    page
      .locator('[data-testid="item-reasons"][data-item="usage-export"]')
      .getByTestId("draft-action"),
  ).toContainText(/^Waive Outside the strategy on Usage export · Staged by /);
});

test("a refused Waive on a stop row keeps its reason and says why under that row", async ({
  page,
}) => {
  await login(page);
  await openSeeded(
    page,
    (p) => seedRun(p, DRIFT_RUN),
    `/runs/${CONSOLE_HELD_RUN_ID}`,
  );
  await drift(page).getByRole("button", { name: "Waive…" }).click();
  await drift(page).getByRole("textbox").fill(REASON);

  // Meanwhile, in a second tab, the stop is waived and the console approval confirmed.
  const other = await page.context().newPage();
  await other.goto(`/runs/${CONSOLE_HELD_RUN_ID}`);
  const gateRow = decision(other)
    .getByTestId("gate-reason")
    .filter({ hasText: "Usage export" });
  await gateRow.getByRole("button", { name: "Waive…" }).click();
  await gateRow.getByRole("textbox").fill(REASON);
  await gateRow.getByRole("button", { name: "Waive", exact: true }).click();
  await decision(other)
    .getByRole("button", { name: "Confirm approval" })
    .click();
  await expect(
    other
      .getByTestId("segment-roadmap_items")
      .getByTestId("checkpoint-roadmap_items"),
  ).toContainText("Approved");
  await other.close();

  await drift(page).getByRole("button", { name: "Waive", exact: true }).click();
  await expect(drift(page).getByRole("alert")).toHaveText(
    "this checkpoint is decided",
  );
  await expect(drift(page).getByRole("textbox")).toHaveValue(REASON);
});
