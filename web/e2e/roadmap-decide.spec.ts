import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * roadmap-decide (the owner's Nov 4 rule: a person always sees what is happening to a roadmap
 * shared with them, every change it needs can be made in the UI, and acting on a prompt removes
 * or updates it at once, everywhere), driven through the UI against the mock:
 *
 * - acting on a broken link drops the page's strip, Needs a decision, Home's tile and the side
 *   menu's Roadmap count together; the panel no longer apologises that the counts differ;
 * - a cut item others depend on offers Bring it back and Remove the dependency, each into the
 *   working draft with Undo, and is never listed as starting before what it depends on ends;
 * - every line of the draft's change list names its item;
 * - the draft banner says what happens next and who acts, with that person's button (Approve);
 * - a change asked of a PRD is its owner's to Approve / Decline on the chip and in Proposals.
 *
 * fails_when: a count stays, a prompt stays after acting, a fix is missing, a line has no
 * item, or the owner has no action; no_claim: the API's own rules
 * (api/tests/test_simple_roadmap_decide.py).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page, scenario?: string) {
  if (scenario)
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const strip = (page: Page) => page.getByTestId("conflicts");
const tray = (page: Page) => page.getByTestId("decision-tray");
const badge = (page: Page) => page.getByTestId("simple-nav-roadmap-count").first();

/** The strip's own count ("⚠ 2 broken links"; 0 for "No broken links"). */
async function stripCount(page: Page): Promise<number> {
  const words = (await strip(page).innerText()).split("\n")[0];
  if (/No broken links/.test(words)) return 0;
  return Number(/(\d+) broken link/.exec(words)?.[1] ?? NaN);
}

async function trayLinks(page: Page): Promise<number> {
  await page.getByTestId("needs-decision").click();
  const tile = tray(page).getByTestId("tray-counter").filter({ hasText: "Broken links" });
  const n = Number(await tile.locator("b").innerText());
  await tray(page).getByRole("button", { name: "Close" }).click();
  return n;
}

/** The side menu's Roadmap count says how many broken links it holds. */
async function badgeLinks(page: Page): Promise<number> {
  const words = (await badge(page).getAttribute("aria-label")) ?? "";
  return Number(/(\d+) broken link/.exec(words)?.[1] ?? NaN);
}

async function homeLinks(page: Page): Promise<number> {
  await page.goto("/simple");
  const tile = page.getByTestId("home-summary-broken-links");
  await expect(tile).not.toContainText("–");
  return Number(await tile.locator(".simple-number").innerText());
}

test.use(DESKTOP);

test("acting on a broken link drops the strip, Needs a decision, Home and the side menu together", async ({ page }) => {
  await open(page);
  const before = await stripCount(page);
  expect(before).toBeGreaterThan(0);
  expect(await trayLinks(page)).toBe(before);
  await expect.poll(() => badgeLinks(page)).toBe(before);
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-scope")).not.toContainText("can differ");
  await tray(page).getByRole("button", { name: "Close" }).click();
  expect(await homeLinks(page)).toBe(before);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect(page.getByText(/Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();
  // The prompt leaves at once, without a reload; every count drops with it.
  await expect(strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]')).toHaveCount(0);
  await expect.poll(() => stripCount(page)).toBe(before - 1);
  expect(await trayLinks(page)).toBe(before - 1);
  await expect.poll(() => badgeLinks(page)).toBe(before - 1);
  expect(await homeLinks(page)).toBe(before - 1);
});

test("the draft's change list names the item on every line, and the banner says who acts next", async ({ page }) => {
  await open(page);
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  const banner = page.getByTestId("draft-banner");
  await expect(banner.getByTestId("draft-next")).toContainText("Next: you send it for review");
  await expect(banner).not.toContainText("no approved version yet");
  await banner.getByRole("button", { name: "See changes" }).click();
  const rows = banner.getByTestId("draft-changes").locator("li");
  await expect(rows.first()).toContainText("Move the dependents: Weekly alert digest");
  for (const row of await rows.all()) await expect(row).toContainText(/: \S/);
  await banner.getByRole("button", { name: "Send for review" }).click();
  await expect(banner.getByTestId("draft-next")).toContainText("Sent for review: it waits for your approval");
  await banner.getByTestId("draft-approve").click();
  await expect(page.getByText(/Approved: .* is published/)).toBeVisible();
});

async function cutKeepingDependents(page: Page, key: string) {
  await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await card.getByRole("button", { name: "Talk to Oracle" }).click();
  const talk = card.getByTestId("item-talk");
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill("cut it");
  await talk.getByRole("button", { name: "Send" }).click();
  await talk.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" }).getByRole("button", { name: "Cut it, keep the dependents" }).click();
  await card.getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
}

test("a cut item others depend on: Bring it back, or Remove the dependency, each with Undo", async ({ page }) => {
  await open(page, "roadmap-talk");
  await cutKeepingDependents(page, "alert-rules");
  const cut: Locator = strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]');
  await expect(cut).toContainText("Cut, but");
  await expect(cut.getByRole("button", { name: "Bring it back" })).toBeVisible();
  // A cut item is never listed as starting before what it depends on ends.
  await expect(strip(page)).not.toContainText("‘Alert rules engine’ starts");
  const removes = cut.getByRole("button", { name: /^Remove the dependency/ });
  const n = await removes.count();
  expect(n).toBeGreaterThan(0);
  await removes.first().click();
  await expect(page.getByText(/Removed '.*'s dependency on 'Alert rules engine'/)).toBeVisible();
  if (n === 1) await expect(cut).toHaveCount(0);
  else await expect(cut.getByRole("button", { name: /^Remove the dependency/ })).toHaveCount(n - 1);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(cut.getByRole("button", { name: /^Remove the dependency/ })).toHaveCount(n);
  await cut.getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByText("Brought back 'Alert rules engine'", { exact: false })).toBeVisible();
  await expect(cut).toHaveCount(0);
});

test("a change asked of a PRD is its owner's to approve: on the chip and under Proposals", async ({ page }) => {
  await open(page, "simple-prd-milestones");
  await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
  const prd = page.getByTestId("ms-prd-card");
  await prd.getByLabel("Date").fill("2027-01-05");
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  const chip = page.getByTestId("ms-asked");
  await expect(chip).toHaveText("Asked the PRD: move M2 Digest for all teams to Jan 5 · waits for Nora Vance");
  // The company's owner decides it: listed under Needs a decision > Proposals.
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-proposal").filter({ hasText: "PRD milestone ‘Digest for all teams’" })).toBeVisible();
  await tray(page).getByRole("button", { name: "Close" }).click();
  await chip.click();
  const decide = page.getByTestId("ms-asked-decide");
  await expect(decide.getByRole("button", { name: "Decline" })).toBeVisible();
  await decide.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved: M2 Digest for all teams moves to Jan 5 in the PRD")).toBeVisible();
  await expect(chip).toHaveCount(0);
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-proposal").filter({ hasText: "PRD milestone" })).toHaveCount(0);
});

test("milestone labels and the PRD ask keep to their header row: none covers another or a bar, at every zoom", async ({ page }) => {
  await open(page, "simple-prd-milestones");
  await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
  const prd = page.getByTestId("ms-prd-card");
  await prd.getByLabel("Date").fill("2027-01-05");
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-asked")).toBeVisible();
  for (const zoom of ["6m", "1y", "all"]) {
    await page.getByTestId(`zoom-${zoom}`).click();
    await expect(page.getByTestId(`zoom-${zoom}`)).toHaveAttribute("aria-pressed", "true");
    const hits = await page.evaluate(() => {
      const box = (e: Element) => e.getBoundingClientRect();
      const meet = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const labels = [...document.querySelectorAll("[data-ms-label]")].filter((e) => (e as HTMLElement).style.visibility !== "hidden");
      const bars = [...document.querySelectorAll('[data-testid="timeline-bar"]')];
      const out: string[] = [];
      labels.forEach((a, n) => {
        const ra = box(a);
        if (ra.height > 24) out.push(`${a.textContent} wraps`);
        for (const b of labels.slice(n + 1)) if (meet(ra, box(b))) out.push(`${a.textContent} / ${b.textContent}`);
        for (const b of bars) if (meet(ra, box(b))) out.push(`${a.textContent} / ${b.getAttribute("aria-label")}`);
      });
      return out;
    });
    expect(hits, zoom).toEqual([]);
  }
});
