import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * inbox-meeting-proposals fix: everything in Simple waiting on me has its own Inbox row that
 * opens where it is decided. In the mock's "inbox-reviewer" scenario approver@example.com is a
 * required reviewer of the Alerts roadmap, and commenter@example.com's feature ask Bulk export,
 * on no roadmap, waits on the owners, as does commenter@example.com's (Theo Brandt's) new name for
 * Weekly alert digest on the Alerts roadmap.
 *
 * Card inbox-date-suggestion: protects = Oracle's open dates for an item the owner decides are a
 * row naming the item and the dates; Open shows Oracle's dates on the roadmap, and the item's
 * name opens its feature panel; fails_when = no row, or either opens nothing.
 *
 * Card inbox-goal-suggestion: protects = a feature Oracle suggests for Keep alerts quiet is a row
 * naming the feature and the goal; Open shows the goal's suggestions with it; fails_when = no
 * row, or Open does not show it.
 *
 * Card inbox-open-shows-it: protects = every Open in the Inbox's Proposals and suggestions
 * leads to a page that shows that item with its action (Accept); a feature ask on no roadmap,
 * which no other page shows until it is filed, has no Open and is decided in its row, and once
 * accepted it is in Requests; fails_when = an Open leads where the item or its action is not
 * shown, the feature ask has an Open, or after Accept Requests does not list it.
 *
 * Card inbox-feature-ask-words: protects = the waiting feature ask reads as proposed, never as
 * filed before it is; accepted, Requests names the teammate who asked (Asked by), the ask having
 * named no one; fails_when = the row says "Filed", or Requests shows no one under Asked by.
 *
 * Card inbox-counts-at-once: protects = accepting Oracle's dates (their popover), a goal's
 * suggested feature (its card) and a proposal (Needs a decision) on the roadmap takes one off
 * the rail's Inbox count (on a phone, the tab bar's More count, or Roadmap's for the proposal)
 * at once, with no navigation or reload;
 * fails_when = the count stays until a reload.
 *
 * Card inbox-simple-approval: protects = roadmap-decide's review order: the decider (the owner)
 * approves a changed roadmap first (Approve and publish), and the version then waits in its
 * required reviewer's Inbox, reached from Simple's rail whose count equals "N waiting" (on a
 * phone the approval is read on the Roadmap tab, More counting the rest): the roadmap by name,
 * the version, who sent it and when (month first); Open goes to the roadmap, where its one
 * Approve, the last approval, publishes it, takes the row away and the counts drop at once;
 * fails_when = no row, the counts differ or wait for a reload, the decider's approval publishes
 * it or leaves it in their own Inbox, or there is no Approve or a second one.
 *
 * Card inbox-send-counts-at-once: protects = the owner, who decides the roadmap, approves a
 * version and it waits on its reviewer, not on them: the rail's Inbox count (on a phone, the
 * Roadmap tab's) stays as it was; fails_when = it goes up.
 *
 * Card roadmap-toast-clear: protects = the decider's "Approved" message covers no bar of the
 * chart on a desktop; fails_when = it sits over a bar.
 *
 * Card inbox-ask-not-in-tray: protects = a feature ask on no roadmap sits in no roadmap's Needs a
 * decision (as its Inbox row has no Open); fails_when = the Alerts roadmap's tray lists it.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

async function waiting(page: Page): Promise<number> {
  const chip = page.getByText(/^\d+ waiting$/).first();
  await expect(chip).toBeVisible();
  return Number((await chip.textContent())!.split(" ")[0]);
}

/** Simple's rail (More on a phone) to the Inbox, by a click; returns the count it showed (0 when none). */
async function openInboxFromRail(page: Page, phone: boolean): Promise<number> {
  await page.goto("/simple");
  let link: Locator;
  let count: Locator;
  if (phone) {
    await tap(page.getByTestId("simple-tab-more"));
    const sheet = page.getByRole("dialog", { name: "More" });
    link = sheet.getByRole("link", { name: "Inbox", exact: true });
    count = sheet.getByTestId("simple-more-inbox-count");
  } else {
    const rail = page.getByTestId("simple-nav");
    link = rail.getByRole("link", { name: "Inbox", exact: true });
    count = rail.getByTestId("simple-nav-inbox-count");
  }
  if (!phone) await expect(count).toBeVisible();
  // On a phone the More count is what the tabs do not count already (it may be none).
  const t = await count.allTextContents();
  const n = t.length ? Number(t[0].trim()) : 0;
  await tap(link);
  await expect(page).toHaveURL(/\/inbox$/);
  return n;
}

/**
 * The count Simple's rail shows for the Inbox (on a phone, the More tab's, where an approval
 * counts: the Roadmap tab's count is the roadmap page's Needs a decision); 0 when none shows.
 */
async function shownCount(page: Page, phone: boolean): Promise<number> {
  const count = page.getByTestId(phone ? "simple-tab-more-count" : "simple-nav-inbox-count");
  // Read without waiting: the badge goes away as the count drops to 0.
  const t = await count.allTextContents();
  return t.length ? Number(t[0].trim()) : 0;
}

/** Where a version waiting for my approval counts: the rail's Inbox; on a phone, the Roadmap tab (its asks). */
const approvalCount = (page: Page, phone: boolean) => (phone ? inboxCount(page, true, "roadmap") : shownCount(page, false));

/**
 * The count of what waits in the Inbox as shown now, read without leaving the page (or
 * closing what is open): the rail's Inbox count; on a phone, the tab bar's More count (Oracle's
 * suggestions wait there) or Roadmap count (a proposal); 0 when none shows.
 */
async function inboxCount(page: Page, phone: boolean, tab: "more" | "roadmap" = "more"): Promise<number> {
  const t = await page.getByTestId(phone ? `simple-tab-${tab}-count` : "simple-nav-inbox-count").allTextContents();
  return t.length ? Number(t[0].trim()) : 0;
}

/** The badge `inboxCount` reads. */
const countBadge = (page: Page, phone: boolean, tab: "more" | "roadmap" = "more") => page.getByTestId(phone ? `simple-tab-${tab}-count` : "simple-nav-inbox-count");

/**
 * fix 2: the count once it holds still (a page's counts load, then may read again as it opens),
 * over 0: the count an action is measured from.
 */
async function settledCount(page: Page, phone: boolean, tab: "more" | "roadmap" = "more"): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const a = await inboxCount(page, phone, tab);
        const same = a === last;
        last = a;
        return a > 0 && same;
      },
      { intervals: [400], timeout: 20_000 },
    )
    .toBe(true);
  return last;
}

/** fix 2, minor 4: waits on the badge itself to read `n` (gone at 0), not on a poll of a few seconds. */
async function expectCount(page: Page, phone: boolean, n: number, tab: "more" | "roadmap" = "more") {
  const badge = countBadge(page, phone, tab);
  if (n === 0) await expect(badge).toHaveCount(0, { timeout: 20_000 });
  else await expect(badge.first()).toHaveText(new RegExp(`^\\s*${n}\\s*$`), { timeout: 20_000 });
}

/** Home's Needs you counts of Approvals and Proposals, as shown now (0 when not shown). */
async function homeCounts(page: Page): Promise<{ approvals: number; proposals: number }> {
  const needs = page.getByTestId("home-needs");
  const n = async (id: string) => {
    const t = await needs.getByTestId(id).allTextContents();
    return t.length ? Number(t[0].replace(/\D+/g, "")) : 0;
  };
  return { approvals: await n("home-count-approvals"), proposals: await n("home-count-proposals") };
}

/** The owner reads the roadmap (Oracle's dates and goal suggestions are made as it is first read). */
async function readRoadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const MONTH_FIRST = /[A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d{2} [AP]M/;

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "inbox-reviewer"), MOCK_SCENARIO_KEY);
});

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // card: inbox-date-suggestion
    test(`Oracle's dates wait in the Inbox; Open shows them on the roadmap and the name opens the feature panel (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await login(page);
      await readRoadmap(page);
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ has: page.getByTestId("date-suggestion-context") }).first();
      await expect(row).toBeVisible();
      await expect(row.getByTestId("date-suggestion-context")).toContainText(/Oracle suggests [A-Z][a-z]{2} \d{1,2}/);
      const name = (await row.getByTestId("feature-name").textContent())!.trim();
      await tap(row.getByRole("link", { name: `Open Oracle's dates for ${name}` }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?.*dates=/);
      await expect(page.getByTestId("suggestion-popover")).toBeVisible();
      await expect(page.getByTestId("suggestion-popover")).toContainText("Oracle suggests");

      // Seen once, the row waits under Seen.
      await page.goto("/inbox");
      await tap(page.getByRole("tab", { name: /^Seen/ }));
      const again = page.getByRole("row").filter({ has: page.getByTestId("date-suggestion-context") }).filter({ hasText: name }).first();
      await tap(again.getByTestId("feature-name"));
      await expect(page).toHaveURL(/\/simple\/roadmap\?.*item=/);
      await expect(page.getByRole("dialog").filter({ hasText: name }).last()).toBeVisible();
    });

    // card: inbox-goal-suggestion
    test(`a goal's suggested feature waits in the Inbox and Open shows the goal's suggestions (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await login(page);
      await readRoadmap(page);
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ hasText: "Oracle suggests it for the goal Keep alerts quiet" }).first();
      await expect(row).toBeVisible();
      await expect(row.getByTestId("goal-suggestion-context")).toContainText(MONTH_FIRST);
      const title = (await row.getByTestId("goal-suggestion-title").textContent())!.trim();
      await tap(row.getByRole("link", { name: "Open the suggestions for Keep alerts quiet" }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?.*suggestions=/);
      await expect(page.getByTestId("goal-suggestion").filter({ hasText: title }).first()).toBeVisible();
    });

    // card: inbox-open-shows-it
    test(`every Open in Proposals and suggestions shows the item with its action; the feature ask is decided in its row (${where})`, async ({ page }) => {
      test.setTimeout(180_000);
      await login(page);
      await readRoadmap(page);
      await page.goto("/inbox");
      const table = page.getByTestId("inbox-proposals");
      await expect(table).toBeVisible();

      // A feature ask on no roadmap: no Open (no page shows it before it is filed), Accept and Decline in its row.
      const ask = table.getByRole("row").filter({ hasText: "Bulk export" }).filter({ hasText: "asked for by" });
      await expect(ask).toHaveCount(1);
      // card: inbox-feature-ask-words: proposed, not filed yet.
      await expect(ask).toContainText("Proposed the feature ask “Bulk export”");
      await expect(ask).not.toContainText(/filed/i);
      await expect(ask.getByRole("link", { name: /^Open/ })).toHaveCount(0);
      await expect(ask.getByRole("button", { name: "Accept" })).toBeVisible();
      await expect(ask.getByRole("button", { name: "Decline" })).toBeVisible();

      // Every other row's Open, each followed by a click.
      const labels = (await table.getByRole("link", { name: /^Open / }).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).filter(Boolean);
      expect(labels.length).toBeGreaterThan(2);
      const kinds = new Set<string>();
      for (const label of labels) {
        await page.goto("/inbox");
        await expect(page.getByTestId("inbox-proposals").first()).toBeVisible();
        // A row once opened waits under Seen.
        const link = () => page.getByTestId("inbox-proposals").getByRole("link", { name: label, exact: true });
        if ((await link().count()) === 0) await tap(page.getByRole("tab", { name: /^Seen/ }));
        const row = page.getByTestId("inbox-proposals").getByRole("row").filter({ has: page.getByRole("link", { name: label, exact: true }) }).first();
        const goal = row.getByTestId("goal-suggestion-title");
        const title = (await goal.count()) ? (await goal.textContent())!.trim() : "";
        await tap(row.getByRole("link", { name: label, exact: true }));
        let m: RegExpMatchArray | null;
        if ((m = label.match(/^Open (.+) on its roadmap$/))) {
          kinds.add("roadmap");
          const there = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: m[1] }).first();
          await expect(there).toBeVisible();
          await expect(there.getByRole("button", { name: "Accept" })).toBeVisible();
        } else if ((m = label.match(/^Open Oracle's dates for (.+)$/))) {
          kinds.add("dates");
          const there = page.getByTestId("suggestion-popover");
          await expect(there).toContainText("Oracle suggests");
          await expect(there.getByRole("button", { name: "Accept" })).toBeVisible();
        } else if ((m = label.match(/^Open the suggestions for (.+)$/))) {
          kinds.add("goal");
          const there = page.locator(`[data-testid="goal-suggestion"][data-title="${title}"]`).first();
          await expect(there).toBeVisible();
          await expect(there.getByRole("button", { name: "Accept" })).toBeVisible();
        } else {
          throw new Error(`An Open the spec does not know: ${label}`);
        }
      }
      expect([...kinds]).toEqual(expect.arrayContaining(["roadmap", "dates", "goal"]));

      // Accepted in the Inbox, the ask is filed: Requests lists it.
      await page.goto("/inbox");
      await tap(page.getByTestId("inbox-proposals").getByRole("row").filter({ hasText: "Bulk export" }).getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Accepted: it is filed in Requests")).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: "Bulk export" }).filter({ hasText: "asked for by" })).toHaveCount(0);
      await page.goto("/requests");
      const filed = page.getByTestId("request-row").filter({ hasText: "Bulk export" }).first();
      await expect(filed).toBeVisible();
      // Asked by the teammate who asked for it (the ask named no one else).
      await expect(filed).toContainText("Theo Brandt");
    });

    // card: inbox-counts-at-once
    test(`accepting on the roadmap takes it off the Inbox count at once (${where})`, async ({ page }) => {
      test.setTimeout(150_000);
      await login(page);
      await readRoadmap(page);

      /** From the Inbox, by the row's Open: the item where it is decided. */
      const openFromInbox = async (name: string | RegExp) => {
        await page.goto("/inbox");
        await expect(page.getByTestId("inbox-proposals").first()).toBeVisible();
        const link = page.getByTestId("inbox-proposals").getByRole("link", { name }).first();
        if ((await link.count()) === 0) await tap(page.getByRole("tab", { name: /^Seen/ }));
        await tap(link);
      };

      // Oracle's dates, accepted in their popover.
      await openFromInbox(/^Open Oracle's dates for /);
      const pop = page.getByTestId("suggestion-popover");
      await expect(pop).toContainText("Oracle suggests");
      // A phone counts Oracle's dates once, on its Roadmap tab (its dates to confirm), not again under More.
      const n0 = await settledCount(page, phone, "roadmap");
      await tap(pop.getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
      await expectCount(page, phone, n0 - 1, "roadmap");

      // A goal's suggested feature, accepted on its card.
      await openFromInbox("Open the suggestions for Keep alerts quiet");
      const card = page.getByTestId("goal-suggestion").first();
      await expect(card).toBeVisible();
      const n1 = await settledCount(page, phone);
      await tap(card.getByRole("button", { name: "Accept" }));
      await expect(page.getByText(/^Added .+ as a draft$/)).toBeVisible();
      await expectCount(page, phone, n1 - 1);

      // A teammate's proposal, accepted in Needs a decision.
      await openFromInbox("Open Weekly alert digest on its roadmap");
      const proposal = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Weekly alert digest" }).first();
      await expect(proposal).toBeVisible();
      // card: inbox-ask-not-in-tray: a feature ask on no roadmap is decided in its Inbox row only: no roadmap's tray lists it.
      await expect(page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Bulk export" })).toHaveCount(0);
      const n2 = await settledCount(page, phone, "roadmap");
      await tap(proposal.getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
      await expectCount(page, phone, n2 - 1, "roadmap");
    });

    // card: inbox-simple-approval
    test(`a version the decider approved waits on its required reviewer, whose approval from the Inbox publishes it (${where})`, async ({ page }) => {
      test.setTimeout(120_000);
      await login(page);
      // The owner, who decides the Alerts roadmap, changes it and approves it (on a desktop, by the keyboard).
      const size = page.viewportSize()!;
      // Read once first: Oracle's dates and goal suggestions, made as it is first read, are in the counts.
      await readRoadmap(page);
      await readRoadmap(page);
      const phoneBefore = phone ? await inboxCount(page, true, "roadmap") : 0;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId("filter-roadmap").selectOption({ label: "Alerts roadmap" });
      const bar = page.locator('[data-testid="timeline-row"][data-item="alert-export"] [data-testid="timeline-bar"]').first();
      await expect(bar).toBeVisible();
      await expect.poll(() => shownCount(page, false)).toBeGreaterThan(0);
      const railBefore = await shownCount(page, false);
      await bar.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      // The decider approves first: no Send for review, and it is not published yet.
      await expect(page.getByTestId("draft-banner").getByRole("button", { name: "Send for review" })).toHaveCount(0);
      await page.getByTestId("draft-banner").getByRole("button", { name: "Approve and publish" }).click();
      const sent = page.getByRole("status").filter({ hasText: "Approved: Alerts roadmap waits for 1 more reviewer" });
      await expect(sent).toBeVisible();
      // card: inbox-send-counts-at-once: it waits on its reviewer, not on the owner who approved it.
      await expect(page.getByTestId("draft-banner").getByTestId("draft-approve")).toHaveCount(0);
      await expect.poll(() => shownCount(page, false)).toBe(railBefore);
      // card: roadmap-toast-clear: the toast covers no bar of the chart.
      const box = (await sent.boundingBox())!;
      const bars = await page.getByTestId("timeline-bar").evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
      );
      const covered = bars.filter((b) => b.x < box.x + box.width && box.x < b.x + b.width && b.y < box.y + box.height && box.y < b.y + b.height);
      expect(covered).toEqual([]);
      await page.setViewportSize(size);
      if (phone) await expect.poll(() => inboxCount(page, true, "roadmap")).toBe(phoneBefore);

      await switchTo(page, "approver@example.com");
      await page.goto("/simple");
      // On a phone the approval is read on the Roadmap tab (its Needs a decision's asks), not More.
      if (phone) await expect.poll(() => inboxCount(page, true, "roadmap")).toBeGreaterThan(0);
      const railCount = await openInboxFromRail(page, phone);
      const row = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
      await expect(row).toHaveCount(1);
      // An approval, not a proposal: listed under Roadmap approvals.
      await expect(page.getByTestId("inbox-roadmap-approvals").getByTestId("simple-approval-context")).toHaveCount(1);
      await expect(page.getByTestId("inbox-proposals").getByTestId("simple-approval-context")).toHaveCount(0);
      await expect(row).toContainText(/Alerts roadmap version \d+/);
      await expect(row.getByTestId("simple-approval-context")).toContainText(/^Sent for review by \S.* on /);
      await expect(row.getByTestId("simple-approval-context")).toContainText(MONTH_FIRST);
      // The rail's count is the page's "N waiting", the approval among them (a phone's More sums
      // other pages' counts and leaves the approval to the Roadmap tab, so it is read there below).
      const all = await waiting(page);
      if (!phone) expect(all).toBe(railCount);
      // Home counts it under Approvals, not Proposals.
      await page.goto("/home");
      await expect(page.getByTestId("home-needs").getByTestId("home-count-approvals")).toBeVisible();
      const before = await homeCounts(page);
      await page.goto("/inbox");
      await expect(row).toHaveCount(1);

      await tap(row.getByRole("link", { name: /^Open Alerts roadmap version \d+ to approve it$/ }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?roadmap=/);
      const approval = page.getByTestId("draft-approval");
      await expect(approval).toContainText(/Alerts roadmap version \d+ is waiting for your approval/);
      // One Approve, on the line that says what waits.
      await expect(page.getByTestId("draft-banner").getByRole("button", { name: "Approve", exact: true })).toHaveCount(1);
      await expect.poll(() => approvalCount(page, phone)).toBeGreaterThan(0);
      const shown = await approvalCount(page, phone);
      // The reviewer's is the last approval: it publishes the version.
      await tap(approval.getByRole("button", { name: "Approve" }));
      await expect(page.getByText("Approved: Alerts roadmap is published")).toBeVisible();
      // The counts drop at once, on the page where it was approved.
      await expect.poll(() => approvalCount(page, phone)).toBe(shown - 1);

      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      await expect(page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") })).toHaveCount(0);
      await page.goto("/home");
      await expect(page.getByTestId("home-needs")).toBeVisible();
      await expect.poll(() => homeCounts(page)).toEqual({ approvals: before.approvals - 1, proposals: before.proposals });

      // The decider approved it first: nothing of it waits in their Inbox.
      await switchTo(page, ADMIN.email);
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      await expect(page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") })).toHaveCount(0);
    });
  });
}
