import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Simple's Definition of Done, item 4 (docs/simple-dod-actions-plan.md): the roadmap's actions
 * no spec drove yet, on a desktop (1440x900) and a phone (390x844). Driven against the mock's
 * default scenario: Weekly alert digest (alert-digest) and Mobile alert push (alert-mobile)
 * depend on Alert rules engine (alert-rules) and the digest starts before the rules end (a red
 * link); Alert SSO (alert-sso) carries Oracle's date suggestion.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const URL = "/simple/roadmap";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 640;
const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`).first();
const body = (page: Page, key: string): Locator => bar(page, key).locator("rect[data-body]");
const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();

/** The roadmap, signed in as `email` (the owner when none). `gantt`: its Gantt (a phone's bars). */
async function open(page: Page, email?: string, gantt = false, scenario?: string) {
  if (scenario) await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  if (gantt) await page.getByTestId("format-gantt").click();
  if (gantt || !isPhone(page)) await expect(bar(page, "alert-rules")).toBeVisible();
  else await expect(page.getByTestId("phone-lane").first()).toBeVisible();
}

/** Signs out, from the rail's account menu or a phone's. */
async function signOutHere(page: Page) {
  await page.getByTestId(isPhone(page) ? "phone-user-menu" : "user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Moves a bar by `dx` pixels: the mouse on a desktop, a long press then a drag on a phone. */
async function dragBar(page: Page, key: string, dx: number) {
  await body(page, key).scrollIntoViewIfNeeded();
  const box = (await body(page, key).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (!isPhone(page)) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.mouse.up();
    return;
  }
  const ev = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1, clientY: y };
  await bar(page, key).dispatchEvent("pointerdown", { ...ev, clientX: x });
  await page.waitForTimeout(650);
  const svg = page.getByTestId("chart-svg");
  for (let n = 1; n <= 8; n++) await svg.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 8 });
  await svg.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + dx });
}

/** The "Needs a decision" tray, opened. */
async function tray(page: Page): Promise<Locator> {
  await page.getByTestId("needs-decision").click();
  const t = page.getByTestId("decision-tray");
  await expect(t).toBeVisible();
  return t;
}

/** An item's card: its bar on a desktop (focused, Enter), its lane row on a phone's lanes. */
async function openCard(page: Page, key: string): Promise<Locator> {
  if (!isPhone(page)) {
    await bar(page, key).focus();
    await page.keyboard.press("Enter");
  } else {
    await page.locator(`[data-testid="phone-lane"][data-items~="${key}"]`).click();
    await page.locator(`[data-testid="lane-row"][data-item="${key}"]`).first().click();
  }
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  return card;
}

/** Talk to Oracle in an item's card (a phone's sheet has it as a tab). */
async function talk(page: Page, key: string): Promise<Locator> {
  const card = await openCard(page, key);
  if (isPhone(page)) await card.getByRole("tab", { name: "Talk to Oracle" }).click();
  else await card.getByRole("button", { name: "Talk to Oracle" }).click();
  return card.getByTestId("item-talk");
}

/** Whether an item reads as cut: its bar on a desktop, its lane row struck through on a phone. */
async function expectCut(page: Page, key: string, cut: boolean) {
  if (!isPhone(page)) {
    if (cut) await expect(bar(page, key)).toHaveAttribute("data-kind", "cut");
    else await expect(bar(page, key)).not.toHaveAttribute("data-kind", "cut");
    return;
  }
  // The lane that holds it, opened (a cut moves it to "Below the line"): its row in the lane's list.
  const name = page.locator(`[data-testid="lane-row"][data-item="${key}"]`).first().locator("span.min-w-0");
  await expect(async () => {
    if (!(await name.count())) await page.locator(`[data-testid="phone-lane"][data-items~="${key}"]`).click();
    await expect(name).toBeVisible({ timeout: 1000 });
  }).toPass();
  if (cut) await expect(name).toHaveClass(/line-through/);
  else await expect(name).not.toHaveClass(/line-through/);
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    /*
     * Card dod-roadmap-decline: protects = the decider declines a commenter's proposed move in
     * the "Needs a decision" tray: the toast says Declined, the proposal leaves the tray and the
     * bar keeps its published dates; fails_when = Decline does nothing, applies the move or the
     * proposal stays waiting; no_claim = who decides (simple-deciders.spec).
     */
    test(`a commenter's move is declined by the owner: nothing moves (${where})`, async ({ page }) => {
      await open(page, "commenter@example.com", isPhone(page));
      const before = await bar(page, "alert-export").getAttribute("data-start");
      await dragBar(page, "alert-export", 90);
      await expect(toast(page, /proposed: it waits for .+ in Needs a decision/)).toBeVisible();
      await signOutHere(page);

      await open(page, undefined, isPhone(page));
      const t = await tray(page);
      const proposal = t.getByTestId("tray-proposal").filter({ hasText: "Alert history export" });
      await expect(proposal).toHaveCount(1);
      await proposal.getByRole("button", { name: "Decline" }).click();
      await expect(toast(page, "Declined")).toBeVisible();
      await expect(t.getByTestId("tray-proposal").filter({ hasText: "Alert history export" })).toHaveCount(0);
      await t.getByRole("button", { name: "Close" }).click();
      await expect(bar(page, "alert-export")).toHaveAttribute("data-start", before!);
      await expect(page.getByTestId("draft-banner")).toHaveCount(0);
    });

    /*
     * Card dod-roadmap-undo-steps: protects = Undo in the working draft takes back one change at
     * a time, the last first: two moves, one Undo leaves the first, a second Undo leaves none;
     * fails_when = Undo takes back both at once, the wrong one, or nothing; no_claim = undoing
     * another person's change (the banner only offers your own).
     */
    test(`undo goes back one change at a time in the working draft (${where})`, async ({ page }) => {
      await open(page, undefined, isPhone(page));
      const exportStart = await bar(page, "alert-export").getAttribute("data-start");
      const mobileStart = await bar(page, "alert-mobile").getAttribute("data-start");
      await dragBar(page, "alert-export", 90);
      await expect(toast(page, /Moved 'Alert history export'/)).toBeVisible();
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await dragBar(page, "alert-mobile", 90);
      await expect(toast(page, /Moved 'Mobile alert push'/)).toBeVisible();
      await expect(page.getByTestId("draft-count")).toHaveText("2");
      const banner = page.getByTestId("draft-banner");
      const movedExport = await bar(page, "alert-export").getAttribute("data-start");
      expect(movedExport).not.toBe(exportStart);
      await expect(bar(page, "alert-mobile")).not.toHaveAttribute("data-start", mobileStart!);

      // One Undo: the last move (Mobile alert push) goes back, the first stays.
      await banner.getByRole("button", { name: "Undo" }).click();
      await expect(bar(page, "alert-mobile")).toHaveAttribute("data-start", mobileStart!);
      await expect(bar(page, "alert-export")).toHaveAttribute("data-start", movedExport!);
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await banner.getByRole("button", { name: "See changes" }).click();
      await expect(banner.getByTestId("draft-changes").getByRole("listitem")).toHaveCount(1);
      // Each row names what it changed, so a person sees which change Undo takes back next.
      await expect(banner.getByTestId("draft-changes").getByRole("listitem").first()).toContainText("Move the dates: Alert history export");

      // A second Undo: the first move goes back too.
      await banner.getByRole("button", { name: "Undo" }).click();
      await expect(bar(page, "alert-export")).toHaveAttribute("data-start", exportStart!);
    });

    /*
     * Card dod-roadmap-cut-keep: protects = "Cut it, keep the dependents" cuts the item alone, in
     * the working draft, and Undo brings it back; fails_when = the button cuts the dependents too,
     * writes nothing, or Undo leaves it cut; no_claim = the cut with its dependents
     * (fix5-cut-dependents.spec).
     */
    test(`cut it, keep the dependents: the item alone is cut, with Undo (${where})`, async ({ page }) => {
      await open(page, undefined, false, "roadmap-talk");
      const box = await talk(page, "alert-rules");
      await box.getByRole("textbox", { name: "Message Oracle" }).fill("cut it");
      await box.getByRole("button", { name: "Send" }).click();
      const cut = box.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" });
      await cut.getByRole("button", { name: "Cut it, keep the dependents" }).click();
      await expect(cut).toHaveAttribute("data-status", "applied");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("floating-card")).toHaveCount(0);
      await expectCut(page, "alert-rules", true);
      await expectCut(page, "alert-digest", false);
      await expectCut(page, "alert-mobile", false);
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await page.getByTestId("draft-banner").getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("draft-count")).toHaveText("0");
      await expectCut(page, "alert-rules", false);
    });

    /*
     * Card dod-roadmap-move-dependency: protects = the broken link's "Move the dependency" fix
     * moves the item depended on (Alert rules engine) so the link is no longer broken, in the
     * working draft; fails_when = the fix writes nothing, moves the dependent instead, or the link
     * stays broken; no_claim = the date arithmetic (the API's tests).
     */
    test(`a broken link's fix: move the dependency (${where})`, async ({ page }) => {
      await open(page);
      const t = await tray(page);
      const row = t.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" }).first();
      await row.getByRole("button", { name: "Move the dependency" }).click();
      await expect(toast(page, /Moved 'Alert rules engine'/)).toBeVisible();
      await expect(t.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" })).toHaveCount(0);
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      if (!isPhone(page)) {
        await t.getByRole("button", { name: "Close" }).click();
        await expect(page.locator('[data-testid="dep-arrow"][data-from="alert-rules"][data-to="alert-digest"]')).not.toHaveAttribute("data-state", "red");
      }
    });

    /*
     * Card dod-roadmap-fixes-tray: protects = from the tray (a phone draws no callouts) the owner
     * accepts a broken link as a risk with a one-line note, undoes it, then moves the dependents:
     * the link leaves the broken list each time; fails_when = a fix writes nothing or the note is
     * not asked for; no_claim = the callouts on the desktop chart (simple-roadmap.spec).
     */
    test(`a broken link's fixes from the tray: accept as risk with a note, move the dependents (${where})`, async ({ page }) => {
      await open(page);
      const t = await tray(page);
      const row = () => t.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" }).first();
      // The digest's red link to the rules engine (its first flag).
      await row().getByRole("button", { name: "Accept as risk" }).first().click();
      await row().getByLabel("Why it is an accepted risk").fill("The digest can ship on the old rules");
      await row().getByRole("button", { name: "Save the risk" }).click();
      await expect(toast(page, "Accepted as a risk")).toBeVisible();
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      // The tray covers the draft's banner: closed for its Undo, then opened again.
      await t.getByRole("button", { name: "Close" }).click();
      await page.getByTestId("draft-banner").getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("draft-count")).toHaveText("0");
      await tray(page);
      await row().getByRole("button", { name: "Move the dependents" }).first().click();
      await expect(toast(page, /Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();
      await expect(t.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" })).toHaveCount(0);
    });

    /*
     * Card dod-roadmap-fix-proposer: protects = an approver or a commenter, who do not decide the
     * roadmap, propose a broken link's fix from the item's card ("Propose: move the dependency"):
     * it waits for the decider and nothing applies; fails_when = their fix applies or is refused;
     * no_claim = the callout's "Move the dependents" (simple-roadmap.spec).
     */
    for (const role of ["approver", "commenter"] as const)
      test(`${role === "approver" ? "an approver" : "a commenter"} proposes a broken link's fix (${where})`, async ({ page }) => {
        await open(page, `${role}@example.com`);
        // No "Needs a decision" tray for those who propose: the digest's own card offers the fixes.
        const card = await openCard(page, "alert-digest");
        await card.getByRole("button", { name: "Propose: move the dependency" }).first().click();
        await expect(toast(page, /proposed: it waits for .+ in Needs a decision/)).toBeVisible();
        await expect(page.getByTestId("draft-banner")).toHaveCount(0);
      });

    /*
     * Card dod-roadmap-approver-drag: protects = an approver's drag of a bar (the Gantt's compact
     * chart on a phone, a long press) is a proposal: the bar keeps its published dates; fails_when
     * = an approver's drag applies; no_claim = the owner's drag (simple-roadmap.spec).
     */
    test(`an approver's drag is a proposal (${where})`, async ({ page }) => {
      await open(page, "approver@example.com", isPhone(page));
      const before = await bar(page, "alert-export").getAttribute("data-start");
      await dragBar(page, "alert-export", 90);
      await expect(toast(page, /proposed: it waits for .+ in Needs a decision/)).toBeVisible();
      await expect(bar(page, "alert-export")).toHaveAttribute("data-start", before!);
      await expect(page.getByTestId("draft-banner")).toHaveCount(0);
    });

    /*
     * Card dod-roadmap-date-edit: protects = Oracle's proposed date opens Accept · Edit dates; Edit
     * saves other dates into the working draft; fails_when = Edit dates is missing or its dates
     * are not written; no_claim = how Oracle suggests dates.
     */
    test(`an Oracle-proposed date is edited before it is taken (${where})`, async ({ page }) => {
      await open(page, undefined, isPhone(page));
      const outline = page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]').first();
      await outline.scrollIntoViewIfNeeded();
      await outline.click();
      const pop = page.getByTestId("suggestion-popover");
      await expect(pop).toContainText("Oracle suggests");
      await pop.getByRole("button", { name: "Edit dates" }).click();
      await pop.getByLabel("Start").fill("2026-12-01");
      await pop.getByLabel("End").fill("2027-01-15");
      await pop.getByRole("button", { name: "Save dates" }).click();
      await expect(bar(page, "alert-sso")).toHaveAttribute("data-start", "2026-12-01");
      await expect(bar(page, "alert-sso")).toHaveAttribute("data-end", "2027-01-15");
      await expect(page.getByTestId("draft-count")).toHaveText("1");
    });
  });
}

/*
 * Card dod-roadmap-gantt-drag: protects = on a desktop the Gantt's bars move with the mouse,
 * applied in the working draft with Undo; fails_when = a Gantt drag does nothing; no_claim = the
 * phone's long press (simple-roadmap.spec).
 */
test.describe("desktop Gantt", () => {
  test.use(DESKTOP);
  test("an owner drags a Gantt bar with the mouse: applied, with Undo", async ({ page }) => {
    await open(page, undefined, true);
    const before = await bar(page, "alert-export").getAttribute("data-start");
    await dragBar(page, "alert-export", 90);
    await expect(toast(page, /Moved 'Alert history export' to .* in your working draft/)).toBeVisible();
    await expect(bar(page, "alert-export")).not.toHaveAttribute("data-start", before!);
    await page.getByTestId("draft-banner").getByRole("button", { name: "Undo" }).click();
    await expect(bar(page, "alert-export")).toHaveAttribute("data-start", before!);
  });
});

const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

/*
 * Card dod-roadmap-commenter-add: protects = a commenter's title dropped on a quarter is a
 * proposed addition (it waits for the owner; no draft bar appears); fails_when = a commenter's
 * add applies or is refused; no_claim = the owner's add (simple-additions.spec).
 */
test.describe("desktop, a commenter adds", () => {
  test.use(DESKTOP);
  test("a commenter drops a title on a quarter: a proposed addition", async ({ page }) => {
    await open(page, "commenter@example.com");
    await page.getByLabel("Add an item").fill("Quiet hours setting");
    await page.getByTestId("quick-add-roadmap").selectOption({ label: "Alerts roadmap" });
    const chip = page.getByTestId("quick-add-chip");
    await expect(chip).toHaveAttribute("aria-disabled", "false");
    await page.evaluate(() => window.scrollTo(0, 0));
    const from = (await chip.boundingBox())!;
    const to = (await page.locator('[data-testid="quarter-drop"][data-add-where="quarter:2027-Q1"]').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, Math.min(to.y + 20, 888), { steps: 12 });
    await page.mouse.up();
    await expect(toast(page, /^Proposed Quiet hours setting .*: it waits for the roadmap's owner in Needs a decision/)).toBeVisible();
    await expect(bar(page, "quiet-hours-setting")).toHaveCount(0);
  });
});

test.describe("phone, proposals", () => {
  test.use(PHONE);

  /*
   * Card dod-roadmap-approver-add-phone: protects = on a phone an approver's add from the sheet
   * is a proposal waiting for the owner; fails_when = it applies or the sheet offers Add;
   * no_claim = the commenter's (simple-additions.spec).
   */
  test("an approver adds from the sheet on a phone: a proposal", async ({ page }) => {
    await open(page, "approver@example.com");
    await page.getByTestId("quick-add-open").click();
    const sheet = page.getByRole("dialog", { name: "Add an item" });
    await sheet.getByLabel("Title").fill("Pause alerts on holidays");
    await sheet.getByLabel("Roadmap").selectOption({ label: "Alerts roadmap" });
    await sheet.getByLabel("Where").selectOption({ label: "Keep alerts quiet" });
    await expect(sheet.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Propose", exact: true }).click();
    await expect(toast(page, "Proposed Pause alerts on holidays (Keep alerts quiet): it waits for the roadmap's owner in Needs a decision")).toBeVisible();
    await expect(page.locator('[data-item="pause-alerts-on-holidays"]')).toHaveCount(0);
  });

  /*
   * Card dod-roadmap-commenter-board-phone: protects = on a phone a commenter's long press moves
   * a board card to another horizon as a proposal: the card stays in its column, marked
   * proposed; fails_when = it applies or nothing happens; no_claim = the desktop
   * (simple-roadmap-formats.spec).
   */
  test("a commenter's long press on a board card is a proposal", async ({ page }) => {
    await open(page, "commenter@example.com");
    await page.getByTestId("format-board").click();
    const c = boardCard(page, "alert-export");
    await c.scrollIntoViewIfNeeded();
    const from = (await c.boundingBox())!;
    const header = page.locator('[data-horizon-column="now"]').locator("header");
    await header.scrollIntoViewIfNeeded();
    const target = (await header.boundingBox())!;
    const x = from.x + from.width / 2;
    const y = (await c.boundingBox())!.y + from.height / 2;
    const ev = { pointerId: 11, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
    await c.dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
    await expect(c).toHaveAttribute("data-picked", "true");
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height / 2;
    for (let n = 1; n <= 8; n++) await c.dispatchEvent("pointermove", { ...ev, clientX: x + ((tx - x) * n) / 8, clientY: y + ((ty - y) * n) / 8 });
    await c.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: tx, clientY: ty });
    await expect(toast(page, /^Moved 'Alert history export' to Now proposed: it waits for .+ in Needs a decision$/)).toBeVisible();
    await expect(page.locator('[data-horizon-column="next"]').locator('[data-item="alert-export"]')).toBeVisible();
    await expect(c.getByTestId("board-pending")).toContainText("Proposed by Commenter: move to Now");
  });
});
