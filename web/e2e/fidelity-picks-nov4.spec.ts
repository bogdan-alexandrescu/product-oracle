import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ENG_CHECK_RUN, PRIORITY_DUPLICATE_RUN, PRIORITY_NO_GOAL_RUN, PRIORITY_ROWLESS_RUN, PRIORITY_RUN, PRIORITY_STALE_GOAL_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * Fidelity fixes on three of the owner's picks (re-confirmed Nov 4), on the mock layer, driven
 * as a person would at the frames' viewport (1440 x 900). Test cards:
 * - EC1 b / EC2 b (mk-engcheck): protects=Send back to architect is the quiet ghost text button
 *   beside Approve; Ask the architect is one quiet link on the last question's line (or after
 *   "None for this feature."), so the Approach starts right after the questions; on a desktop
 *   the list runs down to the decision bar's top edge and scrolls inside itself (the owner's
 *   Nov 5 decision), with no empty band between them, at 1440x900, 1512x945 and 1920x1080, as
 *   owner, approver and viewer; fails_when=an outlined Send back, a button under the questions,
 *   or a list that stops short of the bar (an empty band under it) or runs under it;
 *   no_claim=the decide call.
 * - RP1 a (mk-runplan): protects=a run row's panel shows Rank | Live and Confidence | Score two by
 *   two; the count chip reads "11 ranked"; Depends on carries no orange note; approving the order
 *   puts the new features on the baseline as proposed and on live Priorities; fails_when=three
 *   tiles on a line, "11 in the run's order", "Outside this PRD's scope", or the new features
 *   missing after approval.
 * - RP1 a, no feature without its goal (review of PR 1244, round 2): protects=a new feature
 *   whose goal is named with no contribution joins with its supports link, the contribution
 *   marked assumed until a person sets it; a new feature naming no goal blocks Approve order,
 *   named plainly; fails_when=the link is dropped ("Serves no goal"), the assumed mark is missing
 *   or stays after the person sets it, or Approve order is enabled for a feature with no goal.
 * - RP1 a, round 3: protects=a new feature naming a goal the baseline does not have blocks
 *   Approve order too; each blocking problem is said in full under the band and in the new
 *   feature's panel, with what to do (request changes: order problems are never waived), at
 *   1440 and 390; fails_when=the sentence sits only in a tooltip, the band says "waive", the
 *   info line promises the order adds the features, or the unknown goal is let through.
 * - RP1 a, round 4: protects=the band counts and says every blocking problem of the order once,
 *   one on no row (missing_feature) too, and a key ranked twice once; a goal key with no name
 *   reads "Unknown goal", the key only in its tooltip, and is not a goal of By goal; a new
 *   feature's panel reads each problem once; fails_when=a row-less problem is left out, a
 *   duplicate is said twice, the raw key shows, or the panel repeats the sentence.
 * (RP2 c, the Simple meeting's draft step, is tested with the Simple pages.)
 */

const DESKTOP = { width: 1440, height: 900 };
const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const box = async (l: Locator) => (await l.boundingBox())!;

test.describe("EC1 b and EC2 b: the Engineering check", () => {
  test.use({ viewport: DESKTOP });

  const pane = (page: Page) => page.getByTestId("brief-inspector");
  const bar = (page: Page) => page.getByTestId("decision-bar");
  const row = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);

  async function openCheck(page: Page, scenario: string, count: number) {
    await withScenario(page, scenario);
    await login(page, "commenter@example.com");
    await page.goto("/inbox");
    const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" }).filter({ visible: true });
    await inboxRow.getByRole("link", { name: "Review" }).first().click();
    await expect(page.getByTestId("brief-row")).toHaveCount(count);
  }

  test("Send back is quiet text beside Approve, Ask the architect sits on the last question's line, the Approach follows", async ({ page }) => {
    await openCheck(page, "eng-check-shop", 9);
    const sendBack = bar(page).getByRole("button", { name: "Send back to architect" });
    await expect(sendBack).toBeEnabled();
    await expect(sendBack).toHaveAttribute("data-variant", "ghost");
    const approve = bar(page).getByRole("button", { name: "Approve" });
    // Beside the Approve, on its line.
    expect(Math.abs((await box(sendBack)).y + (await box(sendBack)).height / 2 - ((await box(approve)).y + (await box(approve)).height / 2))).toBeLessThan(4);

    await row(page, "f.guided-setup").getByRole("button").first().click();
    const questions = pane(page).getByTestId("brief-question");
    await expect(questions).toHaveCount(2);
    const ask = pane(page).getByRole("button", { name: "Ask the architect" });
    await expect(ask).toHaveCount(1);
    // On the last question card, not below the questions.
    await expect(questions.last().getByRole("button", { name: "Ask the architect" })).toBeVisible();
    await expect(questions.first().getByRole("button", { name: "Ask the architect" })).toHaveCount(0);
    const last = await box(questions.last());
    const approach = await box(pane(page).getByText("Approach", { exact: true }));
    expect(approach.y - (last.y + last.height), "the Approach starts right after the questions").toBeLessThan(48);

    // The ability stays: it starts a note to the architect with the feature named.
    await ask.click();
    await expect(bar(page).getByRole("textbox", { name: "Note to the architect" })).toHaveValue(/^Guided setup: /);
  });

  test("a feature with no questions keeps Ask the architect on the 'None for this feature.' line", async ({ page }) => {
    await openCheck(page, "eng-check-shop", 9);
    for (const key of await page.getByTestId("brief-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-feature")!))) {
      await row(page, key).getByRole("button").first().click();
      if ((await pane(page).getByTestId("brief-question").count()) > 0) continue;
      const none = pane(page).getByText("None for this feature.");
      const ask = pane(page).getByRole("button", { name: "Ask the architect" });
      expect(Math.abs((await box(none)).y - (await box(ask)).y)).toBeLessThan(6);
      return;
    }
  });

  // The owner's Nov 5 decision: the list runs down to the bar and scrolls inside itself, short
  // or long, so no empty band ever opens between the list and the bar.
  for (const [role, email] of [["owner", "admin@example.com"], ["approver", "approver@example.com"], ["viewer", "viewer@example.com"]]) {
    for (const viewport of [DESKTOP, { width: 1512, height: 945 }, { width: 1920, height: 1080 }]) {
      test(`as ${role} at ${viewport.width}x${viewport.height} the list ends at the decision bar, no empty band under it`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await withScenario(page, "eng-check-shop");
        await login(page, email);
        await page.goto(`/runs/${ENG_CHECK_RUN}`);
        // The lead reads Review; one who does not decide it reads View.
        await page.getByTestId("review-screen-line").filter({ visible: true }).getByRole("link", { name: /^(Review|View)$/ }).click();
        await expect(page.getByTestId("brief-row")).toHaveCount(9);
        await expect(bar(page)).toBeVisible();
        // Both edges read in one frame, so a scroll still moving reads no gap the page never draws.
        const toBar = () =>
          page.evaluate(() => {
            const l = document.querySelector('[aria-label="Features"]')!.getBoundingClientRect();
            return Math.round(document.querySelector('[data-testid="decision-bar"]')!.getBoundingClientRect().top - l.bottom);
          });
        expect(await toBar(), "no empty band between the list and the bar").toBeLessThanOrEqual(1);
        expect(await toBar(), "the list never runs under the bar").toBeGreaterThanOrEqual(-1);
        await page.mouse.move(900, 400);
        // Wheeled on, as a person would, until the page's very end.
        await expect
          .poll(async () => {
            await page.mouse.wheel(0, 2000);
            return page.evaluate(() => Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight);
          })
          .toBe(true);
        await expect.poll(async () => Math.abs(await toBar()), { message: "the list still ends at the bar at the page's end" }).toBeLessThanOrEqual(1);
      });
    }
  }

  test("a longer list still scrolls on its own and stops above the decision bar", async ({ page }) => {
    await openCheck(page, "eng-check-shop-15", 15);
    const list = page.getByRole("region", { name: "Features" });
    const long = await box(list);
    const barBox = await box(bar(page));
    expect(long.y + long.height).toBeLessThanOrEqual(barBox.y + 1);
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });
});

test.describe("RP1 a: the run's priority order", () => {
  test.use({ viewport: DESKTOP });

  async function openOrder(page: Page) {
    await withScenario(page, "priority-order");
    await login(page, "approver@example.com");
    await page.goto(`/runs/${PRIORITY_RUN}`);
    await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
    await expect(page).toHaveURL(/\/priorities\?snapshot=/);
  }

  test("the panel's four figures sit two by two, the chip reads '11 ranked', Depends on has no extra note", async ({ page }) => {
    await openOrder(page);
    await expect(page.getByText("11 ranked", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByText("11 in the run's order")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Outside this PRD's scope");

    await page.getByTestId("priority-row-F-2").getByRole("button").first().click();
    const panel = page.getByTestId("priority-inspector");
    const tiles = panel.locator("dl").first().locator(":scope > div");
    await expect(tiles).toHaveCount(4);
    const [rank, live, conf, score] = await Promise.all([0, 1, 2, 3].map((i) => box(tiles.nth(i))));
    await expect(tiles.nth(0)).toContainText("Rank");
    await expect(tiles.nth(1)).toContainText("Live");
    await expect(tiles.nth(2)).toContainText("Confidence");
    await expect(tiles.nth(3)).toContainText("Score");
    expect(Math.abs(rank.y - live.y)).toBeLessThan(2);
    expect(Math.abs(conf.y - score.y)).toBeLessThan(2);
    expect(conf.y).toBeGreaterThan(rank.y + rank.height - 2);
    expect(Math.abs(rank.x - conf.x)).toBeLessThan(2);
  });

  test("Approve order puts the new features on the baseline as proposed and on live Priorities", async ({ page }) => {
    await openOrder(page);
    // Only a real move among the live features differs from live: the new features ranked
    // above Saved addresses at checkout do not move it (as the frame draws it).
    await expect(page.getByTestId("priority-row-F-4").getByTestId("problem-differs_from_live")).toBeVisible();
    await expect(page.getByTestId("priority-row-F-1").getByTestId("problem-differs_from_live")).toHaveCount(0);
    const band = page.getByTestId("snapshot-band");
    await band.getByRole("button", { name: "Approve order" }).click();
    await expect(band).toContainText("Saved for Saved addresses");

    await page.goto("/priorities");
    await expect(page.locator("main").getByText("Address book per account").first()).toBeVisible();
    await expect(page.locator("main").getByText("Import addresses from a spreadsheet, with a preview before saving").first()).toBeVisible();

    // The baseline: proposed, serving the goal the order scored it on; locked, as the
    // approver's own accepted create (the API's decide_proposal for a person).
    await page.goto("/baseline");
    const added = page.locator("main").getByRole("row", { name: /^N-\d+ Address book per account Locked Proposed/ }).filter({ visible: true });
    await expect(added).toHaveCount(1);
    await expect(added).not.toContainText("Serves no goal");
    await expect(page.locator("main").getByRole("row", { name: /^N-\d+ Address labels and notes Locked Proposed/ }).filter({ visible: true })).toHaveCount(1);

    // The goal it serves and what it needs come as Oracle's proposed links, for a person to confirm.
    const delivery = page.locator("main").getByRole("row", { name: /^N-\d+ Default delivery address Locked Proposed/ }).filter({ visible: true });
    await delivery.getByRole("button", { name: /Default delivery address$/ }).first().click();
    const supports = page.getByRole("list", { name: "Supports" });
    await expect(supports.getByRole("listitem")).toHaveCount(1);
    await expect(supports.getByRole("listitem")).toContainText("Raise activation");
    await expect(supports.getByRole("listitem")).toContainText("Proposed");
    const needs = page.getByRole("list", { name: "Depends on" });
    await expect(needs.getByRole("listitem")).toHaveCount(1);
    await expect(needs.getByRole("listitem")).toContainText("Address book per account");
    await expect(needs.getByRole("listitem")).toContainText("Proposed");

    // A goal named with no contribution: the link still comes, the contribution marked assumed
    // until a person sets it.
    await page.keyboard.press("Escape");
    const shared = page.locator("main").getByRole("row", { name: /^(N-\d+ )?Shared team addresses Locked Proposed/ }).filter({ visible: true });
    await expect(shared).not.toContainText("Serves no goal");
    await shared.getByRole("button", { name: /Shared team addresses$/ }).first().click();
    const link = page.getByRole("list", { name: "Supports" }).getByRole("listitem");
    await expect(link).toHaveCount(1);
    await expect(link).toContainText("Grow paid conversion");
    await expect(link).toContainText("Contribution assumed");
    await link.getByLabel("Contribution to Grow paid conversion").selectOption("2");
    await expect(link).not.toContainText("Contribution assumed");
  });

  test("a new feature that names no goal blocks Approve order, named plainly", async ({ page }) => {
    await openNoGoalOrder(page);
    const band = page.getByTestId("snapshot-band");
    await expect(band.getByRole("button", { name: "Approve order" })).toBeDisabled();
    await expect(band.getByTestId("cannot-approve")).toContainText("2 blocking problems");
    const chip = page.getByTestId("priority-row-N-7").getByTestId("problem-new_feature_no_goal");
    await expect(chip).toHaveText(/^Names no goal/);
    await expect(chip).toHaveAttribute("title", NO_GOAL);
    await expect(page.getByTestId("priority-row-N-8").getByTestId("problem-unknown_goal")).toHaveText(/^Unknown goal/);
    await expectBlockingSaid(page);

    // The new feature's panel names its problem in a plain sentence.
    await page.getByTestId("priority-row-N-7").getByRole("button", { name: /Gift notes at checkout/ }).click();
    const problems = page.getByTestId("priority-inspector").getByTestId("run-problems");
    await expect(problems).toBeVisible();
    await expect(problems.getByText(NO_GOAL, { exact: true })).toBeVisible();
    // Read once, for screen readers and sight alike: the chip carries no second copy.
    await expect(problems.getByText(NO_GOAL)).toHaveCount(1);
  });

  test("a goal key with no name reads Unknown goal, the key only in its tooltip", async ({ page }) => {
    await openNoGoalOrder(page);
    const row = page.getByTestId("priority-row-N-8");
    await expect(row).not.toContainText("g.no-such-goal");
    const goal = row.getByTestId("unknown-goal");
    await expect(goal).toHaveText("Unknown goal");
    await expect(goal).toHaveAttribute("title", /g\.no-such-goal/);
    await expect(page.getByTestId("snapshot-band")).not.toContainText("g.no-such-goal");
    await expect(page.locator("main")).not.toContainText("g.no-such-goal");
    // By goal lists the goals of the baseline only.
    await expect(page.getByRole("table", { name: "By goal" })).not.toContainText("Unknown goal");
    await row.getByRole("button", { name: /Gift wrap choice/ }).click();
    const panel = page.getByTestId("priority-inspector");
    await expect(panel.getByTestId("unknown-goal").first()).toHaveText("Unknown goal");
    await expect(panel).not.toContainText("g.no-such-goal");
    await expect(panel.getByText(UNKNOWN_GOAL)).toHaveCount(1);
  });

  test("a blocking problem on no row is counted and said on the band too", async ({ page }) => {
    await withScenario(page, "priority-order");
    await login(page, "approver@example.com");
    await page.goto(`/runs/${PRIORITY_ROWLESS_RUN}`);
    await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
    const band = page.getByTestId("snapshot-band");
    await expect(band.getByRole("button", { name: "Approve order" })).toBeDisabled();
    // Not only goal problems: the run fixes them, not only names the goal.
    await expect(band.getByTestId("cannot-approve")).toHaveText("2 blocking problems left. Order problems cannot be waived: request changes so the run fixes them.");
    const list = band.getByRole("list", { name: "Blocking problems" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByText(UNKNOWN_GOAL)).toBeVisible();
    await expect(list.getByText("Gift receipt by email is in the approved PRD scope and not ranked")).toBeVisible();
  });

  test("a goal rejected after the check refuses Approve order, named, and the band says it", async ({ page }) => {
    await withScenario(page, "priority-order");
    await login(page);
    // The order is clean; its new feature serves Cut early churn, still proposed.
    await page.goto(`/runs/${PRIORITY_STALE_GOAL_RUN}`);
    await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
    const band = page.getByTestId("snapshot-band");
    await expect(band.getByRole("button", { name: "Approve order" })).toBeEnabled();
    await expect(page.getByTestId("priority-row-N-10")).toContainText("Cut early churn");
    const order = page.url();

    // Then a person rejects that goal.
    await page.goto("/baseline");
    await page.getByRole("grid", { name: "Goals" }).getByRole("button", { name: "Cut early churn" }).click();
    const d = page.getByRole("dialog", { name: "Cut early churn" });
    await d.getByRole("button", { name: "Reject" }).click();
    await d.getByRole("form", { name: "Reject" }).getByRole("button", { name: "Reject" }).click();
    await expect(d.getByRole("status")).toContainText("Rejected");

    await page.goto(order);
    await band.getByRole("button", { name: "Approve order" }).click();
    await expect(band).toContainText(STALE_GOAL);
    await expect(band.getByTestId("cannot-approve")).toHaveText("1 blocking problem left. Order problems cannot be waived: request changes so the run names the goal.");
    await expect(band.getByRole("button", { name: "Approve order" })).toBeDisabled();
    await expect(band).toContainText("Proposed");
  });

  test("a feature ranked twice is one problem, said once", async ({ page }) => {
    await withScenario(page, "priority-order");
    await login(page, "approver@example.com");
    await page.goto(`/runs/${PRIORITY_DUPLICATE_RUN}`);
    await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
    const band = page.getByTestId("snapshot-band");
    await expect(band.getByTestId("cannot-approve")).toHaveText("1 blocking problem left. Order problems cannot be waived: request changes so the run fixes it.");
    const list = band.getByRole("list", { name: "Blocking problems" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list.getByRole("listitem")).toHaveText("Saved addresses at checkout is ranked 2 times");
  });
});

// Review of PR 1244, round 3: an order's blocking problems are said in full under the band,
// with what to do (order problems are never waived), at 1440 and on a phone.
const NO_GOAL = "Gift notes at checkout is new and names no goal it serves: the run must name one";
const STALE_GOAL = "Gift box sizes serves the goal Cut early churn, which was rejected after the order was checked: the run must name a goal of the Ground Truth";
// The goal's key is no name, and none is known: the sentence says a goal that was deleted, never the key.
const UNKNOWN_GOAL = "Gift wrap choice names a goal that was deleted: the run must name a goal of the Ground Truth";

async function openNoGoalOrder(page: Page) {
  await withScenario(page, "priority-order");
  await login(page, "approver@example.com");
  await page.goto(`/runs/${PRIORITY_NO_GOAL_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page.getByTestId("snapshot-band")).toBeVisible();
}

async function expectBlockingSaid(page: Page) {
  const band = page.getByTestId("snapshot-band");
  const said = band.getByTestId("cannot-approve");
  await expect(said).toHaveText("2 blocking problems left. Order problems cannot be waived: request changes so the run names the goal.");
  const list = band.getByRole("list", { name: "Blocking problems" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByText(NO_GOAL)).toBeVisible();
  await expect(list.getByText(UNKNOWN_GOAL)).toBeVisible();
  await expect(band).not.toContainText("waive them");
  // The info line no longer promises the order adds them: it cannot be approved as it is.
  const note = page.getByTestId("new-features-note");
  await expect(note).toContainText("This order ranks the 2 features Gift notes adds");
  await expect(note).not.toContainText("Approving the order");
}

test.describe("RP1 a: an order naming no goal, or an unknown one, on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("at 390 px each blocking problem is said in full under the band", async ({ page }) => {
    await openNoGoalOrder(page);
    await expect(page.getByTestId("snapshot-band").getByRole("button", { name: "Approve order" })).toBeDisabled();
    await expectBlockingSaid(page);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
});
