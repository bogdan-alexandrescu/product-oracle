import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * inbox-meeting-proposals fix 3: a teammate's proposal on a PRD question or on a one-pager
 * line waits in the decider's Inbox, named by what it is on, and opens where it is decided.
 * The mock's Guided setup PRD: commenter@example.com (Theo Brandt) proposes, the owner (Avery
 * Stone) decides.
 *
 * Card inbox-question-proposal: protects = a commenter's proposed answer to Q6 is an Inbox row
 * named "Q6 Invite limit on the free plan", reached from Simple's rail (More on a phone) whose
 * count equals "N waiting"; Open lands on Q6 on Decisions with Decide; deciding it there removes
 * the row and the count drops by one; fails_when = no row, the row reads "An item", Open goes to
 * a roadmap, the question is not shown with Decide, or the row stays.
 *
 * Card inbox-one-pager-proposal: protects = a commenter's proposed wording for a one-pager line
 * is an Inbox row quoting the line; Open lands on that line of the one-pager with its proposal's
 * Accept; accepting removes the row and the count drops by one; fails_when = no row, Open goes
 * to a roadmap, or the row stays.
 *
 * Card more-counts-the-inbox: protects = on a phone, More's badge counts what waits in the Inbox
 * beyond the tabs' own counts (here the one-pager proposal); fails_when = More shows no count.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const DESKTOP = { width: 1440, height: 900 };

/** Signs in as `email` (at a desktop's width, where the account menu is), back at `size`. */
async function as(page: Page, email: string | undefined, size: { width: number; height: number }) {
  await page.setViewportSize(DESKTOP);
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

/** The owner reads the roadmap, Decisions and the one-pager first (Oracle's dates and goal suggestions are made as the roadmap is first read). */
async function readPages(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.goto("/simple/decisions");
  await expect(page.getByTestId("questions-mine")).toBeVisible();
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByTestId("one-pager")).toBeVisible();
}

const QUESTION = "Q6 Invite limit on the free plan";
const LINE = "Invite suggestions from the admin's";

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    const size = phone ? { width: 390, height: 844 } : DESKTOP;
    test.use({ viewport: size });

    // card: inbox-question-proposal
    test(`a proposed answer to a PRD question waits in the Inbox and opens on that question with Decide (${where})`, async ({ page }) => {
      test.setTimeout(120_000);
      await login(page, "commenter@example.com");
      await page.setViewportSize(DESKTOP);
      await page.goto("/simple/decisions");
      const asked = page.getByTestId("question-row").filter({ hasText: QUESTION });
      await tap(asked.getByRole("button", { name: "Propose as recommended" }));
      await expect(page.getByText("Sent to Avery Stone to decide")).toBeVisible();

      await as(page, undefined, size);
      await readPages(page);
      const n = await openInboxFromRail(page, phone);
      expect(await waiting(page)).toBe(n);
      const row = page.getByRole("row").filter({ hasText: QUESTION }).first();
      await expect(row).toBeVisible();
      await expect(row).not.toContainText("An item");
      await expect(row.getByTestId("meeting-proposal-context")).toContainText(`Decided ${QUESTION} · asked for by Theo Brandt on`);
      await tap(row.getByRole("link", { name: `Open ${QUESTION} in Decisions` }));
      await expect(page).toHaveURL(/\/simple\/decisions\?prd=[^&]+&question=/);
      const question = page.locator('[data-testid="question-row"][data-code="Q6"]');
      await expect(question).toHaveAttribute("data-linked", "true");
      await expect(question).toBeInViewport();
      await expect(question.getByTestId("question-pending")).toHaveText("Theo Brandt proposed: 5 invites");
      await tap(question.getByRole("button", { name: "Decide as recommended" }));
      await expect(page.getByText("Decided Q6: 5 invites")).toBeVisible();

      // Decided there, it leaves the Inbox and its count.
      const after = await openInboxFromRail(page, phone);
      expect(after).toBe(n - 1);
      expect(await waiting(page)).toBe(after);
      await expect(page.getByRole("row").filter({ hasText: QUESTION })).toHaveCount(0);
    });

    // card: inbox-one-pager-proposal, more-counts-the-inbox
    test(`a proposed one-pager wording waits in the Inbox and opens on that line with Accept (${where})`, async ({ page }) => {
      test.setTimeout(120_000);
      await login(page, "commenter@example.com");
      await page.setViewportSize(DESKTOP);
      await page.goto("/simple/one-pagers/guided-setup");
      await tap(page.getByRole("button", { name: `Propose wording for “${LINE}` }));
      await page.getByLabel("New wording for").fill("Invite suggestions from shared contacts");
      await page.getByRole("button", { name: "Propose", exact: true }).click();
      await expect(page.locator('[data-line="bets-2"]')).toHaveAttribute("data-state", "proposal");

      await as(page, undefined, size);
      await readPages(page);
      if (phone) {
        await page.goto("/simple");
        await expect(page.getByTestId("simple-tab-more-count")).toBeVisible();
      }
      const n = await openInboxFromRail(page, phone);
      expect(await waiting(page)).toBe(n);
      const row = page.getByRole("row").filter({ hasText: LINE }).first();
      await expect(row).toBeVisible();
      await expect(row).not.toContainText("An item");
      await tap(row.getByRole("link", { name: new RegExp(`^Open “${LINE}.*” on its one-pager$`) }));
      await expect(page).toHaveURL(/\/simple\/one-pagers\/[^?]+\?line=bets-2/);
      const line = page.locator('[data-line="bets-2"]');
      await expect(line).toBeInViewport();
      const note = page.getByRole("note").filter({ hasText: "proposed new wording for “Invite suggestions" }).filter({ visible: true });
      await tap(note.getByRole("button", { name: "Accept" }));
      await expect(line).toContainText("Invite suggestions from shared contacts");

      const after = await openInboxFromRail(page, phone);
      expect(after).toBe(n - 1);
      expect(await waiting(page)).toBe(after);
      await expect(page.getByRole("row").filter({ hasText: LINE })).toHaveCount(0);
    });
  });
}
