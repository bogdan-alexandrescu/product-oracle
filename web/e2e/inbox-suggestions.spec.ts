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
 * Card inbox-simple-approval: protects = a roadmap version sent for review waits in its required
 * reviewer's Inbox, reached from Simple's rail whose count equals "N waiting": the roadmap by
 * name, the version, who sent it and when (month first); Open goes to the roadmap, where Approve
 * takes the row away and the counts drop at once, without publishing it; the decider (the owner)
 * has it in their Inbox until they approve it too, which publishes it; fails_when = no row for
 * either, the counts differ or wait for a reload, the reviewer's approval publishes it, or
 * Approve is not there. Desktop and phone.
 *
 * Card inbox-send-counts-at-once: protects = the owner, who decides the roadmap, sends a version
 * for review and the rail's Inbox count (on a phone, the Roadmap tab's) goes up by one at once;
 * fails_when = it stays until a reload.
 *
 * Card roadmap-toast-clear: protects = the "Sent for review" message covers no bar of the
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

/** Simple's rail (More on a phone) to the Inbox, by a click; returns the count it showed. */
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
  await expect(count).toBeVisible();
  const n = Number((await count.textContent())!.trim());
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

/**
 * The count of what waits in the Inbox as shown now, read without leaving the page (or
 * closing what is open): the rail's Inbox count; on a phone, the tab bar's More count (Oracle's
 * suggestions wait there) or Roadmap count (a proposal); 0 when none shows.
 */
async function inboxCount(page: Page, phone: boolean, tab: "more" | "roadmap" = "more"): Promise<number> {
  const t = await page.getByTestId(phone ? `simple-tab-${tab}-count` : "simple-nav-inbox-count").allTextContents();
  return t.length ? Number(t[0].trim()) : 0;
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
      await expect.poll(() => inboxCount(page, phone)).toBeGreaterThan(0);
      const n0 = await inboxCount(page, phone);
      await tap(pop.getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
      await expect.poll(() => inboxCount(page, phone)).toBe(n0 - 1);

      // A goal's suggested feature, accepted on its card.
      await openFromInbox("Open the suggestions for Keep alerts quiet");
      const card = page.getByTestId("goal-suggestion").first();
      await expect(card).toBeVisible();
      await expect.poll(() => inboxCount(page, phone)).toBeGreaterThan(0);
      const n1 = await inboxCount(page, phone);
      await tap(card.getByRole("button", { name: "Accept" }));
      await expect(page.getByText(/^Added .+ as a draft$/)).toBeVisible();
      await expect.poll(() => inboxCount(page, phone)).toBe(n1 - 1);

      // A teammate's proposal, accepted in Needs a decision.
      await openFromInbox("Open Weekly alert digest on its roadmap");
      const proposal = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Weekly alert digest" }).first();
      await expect(proposal).toBeVisible();
      // card: inbox-ask-not-in-tray: a feature ask on no roadmap is decided in its Inbox row only: no roadmap's tray lists it.
      await expect(page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Bulk export" })).toHaveCount(0);
      await expect.poll(() => inboxCount(page, phone, "roadmap")).toBeGreaterThan(0);
      const n2 = await inboxCount(page, phone, "roadmap");
      await tap(proposal.getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
      await expect.poll(() => inboxCount(page, phone, "roadmap")).toBe(n2 - 1);
    });

    // card: inbox-simple-approval
    test(`a version sent for review waits on its required reviewer, who approves it from the Inbox (${where})`, async ({ page }) => {
      test.setTimeout(120_000);
      await login(page);
      // The owner changes the Alerts roadmap and sends it for review (on a desktop, by the keyboard).
      const size = page.viewportSize()!;
      // Read once first: Oracle's dates and goal suggestions, made as it is first read, are in the counts.
      await readRoadmap(page);
      await readRoadmap(page);
      // On a phone, the More tab's count (the Inbox beyond what the tabs count waits there).
      if (phone) await expect.poll(() => shownCount(page, true)).toBeGreaterThan(0);
      const phoneBefore = phone ? await shownCount(page, true) : 0;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId("filter-roadmap").selectOption({ label: "Alerts roadmap" });
      const bar = page.locator('[data-testid="timeline-row"][data-item="alert-export"] [data-testid="timeline-bar"]').first();
      await expect(bar).toBeVisible();
      await expect.poll(() => shownCount(page, false)).toBeGreaterThan(0);
      const railBefore = await shownCount(page, false);
      await bar.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await page.getByTestId("draft-banner").getByRole("button", { name: "Send for review" }).click();
      const sent = page.getByRole("status").filter({ hasText: "Sent for review" });
      await expect(sent).toBeVisible();
      // card: inbox-send-counts-at-once: the owner decides the roadmap: the version now waits on them too, and the rail counts it at once.
      await expect.poll(() => shownCount(page, false)).toBe(railBefore + 1);
      // card: roadmap-toast-clear: the toast covers no bar of the chart.
      const box = (await sent.boundingBox())!;
      const bars = await page.getByTestId("timeline-bar").evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
      );
      const covered = bars.filter((b) => b.x < box.x + box.width && box.x < b.x + b.width && b.y < box.y + box.height && box.y < b.y + b.height);
      expect(covered).toEqual([]);
      await page.setViewportSize(size);
      if (phone) await expect.poll(() => shownCount(page, true)).toBe(phoneBefore + 1);

      await switchTo(page, "approver@example.com");
      const railCount = await openInboxFromRail(page, phone);
      const row = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
      await expect(row).toHaveCount(1);
      // An approval, not a proposal: listed under Roadmap approvals.
      await expect(page.getByTestId("inbox-roadmap-approvals").getByTestId("simple-approval-context")).toHaveCount(1);
      await expect(page.getByTestId("inbox-proposals").getByTestId("simple-approval-context")).toHaveCount(0);
      await expect(row).toContainText(/Alerts roadmap version \d+/);
      await expect(row.getByTestId("simple-approval-context")).toContainText(/^Sent for review by \S.* on /);
      await expect(row.getByTestId("simple-approval-context")).toContainText(MONTH_FIRST);
      // The rail's count is the page's "N waiting", the approval among them.
      expect(await waiting(page)).toBe(railCount);
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
      await expect.poll(() => shownCount(page, phone)).toBeGreaterThan(0);
      const shown = await shownCount(page, phone);
      // The reviewer's approval alone does not publish it: the decider's is still to come.
      await tap(approval.getByRole("button", { name: "Approve" }));
      await expect(page.getByText("Approved: it waits for the other approvals")).toBeVisible();
      // The counts drop at once, on the page where it was approved.
      await expect.poll(() => shownCount(page, phone)).toBe(shown - 1);

      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      await expect(page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") })).toHaveCount(0);
      await page.goto("/home");
      await expect(page.getByTestId("home-needs")).toBeVisible();
      await expect.poll(() => homeCounts(page)).toEqual({ approvals: before.approvals - 1, proposals: before.proposals });

      // The decider (the owner, who sent it) has it waiting in their Inbox too.
      await switchTo(page, ADMIN.email);
      const ownerCount = await openInboxFromRail(page, phone);
      const mine = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(/Alerts roadmap version \d+/);
      expect(await waiting(page)).toBe(ownerCount);
      await tap(mine.getByRole("link", { name: /^Open Alerts roadmap version \d+ to approve it$/ }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?roadmap=.*approve=/);
      const decide = page.getByTestId("draft-approval");
      await expect(decide).toContainText(/Alerts roadmap version \d+ is waiting for your approval/);
      await expect.poll(() => shownCount(page, phone)).toBeGreaterThan(0);
      const ownerShown = await shownCount(page, phone);
      await tap(decide.getByRole("button", { name: "Approve" }));
      await expect(page.getByText("Approved: Alerts roadmap is published")).toBeVisible();
      await expect.poll(() => shownCount(page, phone)).toBe(ownerShown - 1);

      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      await expect(page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") })).toHaveCount(0);
      await expect.poll(() => waiting(page).catch(() => 0)).toBe(ownerCount - 1);
    });
  });
}
