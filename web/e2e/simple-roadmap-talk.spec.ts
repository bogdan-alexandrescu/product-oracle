import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * roadmap-talk: the roadmap item card's "Talk to Oracle" widens the card in place (a phone's
 * sheet gets two tabs, Details and Talk to Oracle) with the item's own talk (one thread per
 * item and person, "it" means the item); Oracle answers with its source and restates each
 * change as an action card with Before → After, Apply, Reject and Correct. The "roadmap-talk"
 * mock scenario (the mock's today: 22 Oct 2026) with its invented F-16 Adaptive pacing
 * (16 Nov – 27 Nov, on M1 Launch prep), F-17 Sign-up work and F-18 Reliability work; the
 * mock's reader is deterministic. Desktop (1366x820) and phone (390x844), light and dark.
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

const bar = (page: Page, key: string) => page.locator(`[data-testid="bar"][data-item="${key}"]`);

/** Opens the item's card from its bar, then its talk (a phone: the Talk to Oracle tab). */
async function openTalk(page: Page, key: string, phone: boolean): Promise<{ card: Locator; talk: Locator }> {
  await expect(bar(page, key)).toBeVisible();
  await bar(page, key).click();
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  if (phone) {
    await expect(card.getByRole("tablist")).toBeVisible();
    await tap(card.getByRole("tab", { name: "Talk to Oracle" }));
    await expect(card.getByRole("tab", { name: "Talk to Oracle" })).toHaveAttribute("aria-selected", "true");
  } else {
    await tap(card.getByRole("button", { name: "Talk to Oracle" }));
    await expect(card).toHaveAttribute("data-talk", "true");
    // Widened in place: the details stay on the left.
    await expect(card.getByTestId("card-dates")).toBeVisible();
    expect((await card.boundingBox())!.width).toBeGreaterThan(700);
  }
  const talk = card.getByTestId("item-talk");
  await expect(talk.getByRole("heading", { name: "Talk about F-16 Adaptive pacing" })).toBeVisible();
  await expect(talk.getByRole("button", { name: phone ? "Back to the details" : "Hide the talk" })).toBeVisible();
  await expect(talk.getByTestId("chat-note")).toHaveText("Just you and Oracle · kept with this item");
  return { card, talk };
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

/** Opens Ask Oracle (the rail's button; the header's Ask on a phone): the visible panel. */
async function openAsk(page: Page, phone: boolean) {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

const last = (box: Locator) => box.getByTestId("chat-message").last();
const card = (box: Locator, summary: string) => box.getByTestId("chat-card").filter({ hasText: summary });

for (const [phone, dark] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  const where = `${phone ? "phone" : "desktop"}, ${dark ? "dark" : "light"}`;
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript(
        ([key, themeKey, theme]) => {
          localStorage.setItem(key, "roadmap-talk");
          localStorage.setItem(themeKey, theme);
        },
        [MOCK_SCENARIO_KEY, THEME_KEY, dark ? "dark" : "light"] as const,
      );
      if (dark) await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1366, height: 820 });
    });

    /**
     * Card roadmap-talk-question: protects = the card's "Talk to Oracle" opens the item's own
     * talk beside the details (a phone: its tab), headed with the item's code and title, and
     * a question there gets Oracle's answer with its source under it; fails_when = the talk
     * does not open in the card, the heading or the line under the box differ, the answer
     * has no source, or the phone's tabs are missing; no_claim = the answer's wording.
     */
    test(`a question in the card's talk is answered with its source (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const { talk } = await openTalk(page, "adaptive-pacing", phone);
      await say(talk, "What is it for?");
      const answer = last(talk);
      await expect(answer).toHaveAttribute("data-kind", "answer");
      await expect(answer.getByTestId("chat-message-body")).toContainText("Adaptive pacing runs 16 Nov – 27 Nov");
      await expect(answer.getByTestId("chat-message-source")).toHaveText("From the PRD · F-16 Adaptive pacing");
      await expect(talk.getByTestId("chat-card")).toHaveCount(0);
      // A question about its days is read from the roadmap, and says so.
      await say(talk, "When is it?");
      await expect(last(talk).getByTestId("chat-message-source")).toHaveText("From the roadmap · F-16 Adaptive pacing");
    });

    /**
     * Card roadmap-talk-move: protects = "move it two weeks later" in the item's talk is
     * restated ("I understood: move F-16 Adaptive pacing two weeks later, to 30 Nov – 11 Dec,
     * 2026.") with one card showing Before → After and its red reason; Apply applies it, the
     * item's bar flashes on the timeline and the card's dates change; fails_when = no
     * restatement, no Before/After, Apply does not change the dates or the bar does not
     * flash; no_claim = the flash's look (a CSS pulse).
     */
    test(`a move is restated and applied from the card's talk (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const { card: floating, talk } = await openTalk(page, "adaptive-pacing", phone);
      await say(talk, "move it two weeks later");
      await expect(last(talk).getByTestId("chat-message-body")).toHaveText("I understood: move F-16 Adaptive pacing two weeks later, to 30 Nov – 11 Dec.");
      const c = talk.getByTestId("chat-card");
      await expect(c).toHaveCount(1);
      await expect(c.getByTestId("chat-card-summary")).toHaveText("Move F-16 Adaptive pacing two weeks later, to 30 Nov – 11 Dec");
      await expect(c.getByTestId("chat-card-change")).toHaveText("Before: 16 Nov – 27 Nov → After: 30 Nov – 11 Dec");
      await expect(c.getByTestId("chat-card-flag").first()).toContainText("M1 Launch prep");
      await expect(c.getByRole("button", { name: "Reject" })).toBeVisible();
      await expect(c.getByRole("button", { name: "Correct" })).toBeVisible();
      await tap(c.getByRole("button", { name: "Apply" }));
      await expect(c).toHaveAttribute("data-status", "applied");
      await expect(bar(page, "adaptive-pacing")).toHaveAttribute("data-flash", "true");
      await expect(bar(page, "adaptive-pacing")).toHaveAttribute("data-start", "2026-11-30");
      await expect(bar(page, "adaptive-pacing")).not.toHaveAttribute("data-flash", "true", { timeout: 6000 });
      if (phone) await tap(floating.getByRole("tab", { name: "Details" }));
      await expect(floating.getByTestId("card-dates")).toContainText("Nov 30");
    });

    /**
     * Card roadmap-talk-two-actions: protects = on the roadmap's Ask panel, "push the
     * reliability work after the sign-up work and add a dashboard item to M2 under Growth"
     * is read as two cards ("I understood two changes:" with Apply all); Correct opens the
     * Dashboard card's labelled fields prefilled with Oracle's reading, the changed dates
     * apply and its restatement updates; Reject on the other card changes nothing;
     * fails_when = one card, no Correct fields, Apply ignores the corrected values or Reject
     * applies; no_claim = the reader's model (the mock's reader is keyword rules).
     */
    test(`two changes on the Ask panel: one corrected and applied, one rejected (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      await expect(bar(page, "reliability-work")).toHaveAttribute("data-start", "2026-10-31");
      const panel = await openAsk(page, phone);
      await say(panel, "push the reliability work after the sign-up work and add a dashboard item to M2 under Growth");
      await expect(panel.getByTestId("chat-message-body").filter({ hasText: "I understood two changes:" })).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByRole("button", { name: "Apply all" })).toBeVisible();
      const move = card(panel, "Reliability work");
      const add = card(panel, "Add Dashboard");
      await expect(move.getByTestId("chat-card-summary")).toHaveText("Move F-18 Reliability work after Sign-up work, to 11 Nov – 1 Dec");
      await expect(add.getByTestId("chat-card-summary")).toHaveText("Add Dashboard under Growth to M2 Scale volume, 5 Dec – 18 Dec");

      await tap(add.getByRole("button", { name: "Correct" }));
      const fields = add.getByTestId("chat-card-correct");
      await expect(fields.getByLabel("Title")).toHaveValue("Dashboard");
      await expect(fields.getByLabel("Goal")).toHaveValue("Growth");
      await expect(fields.getByLabel("Milestone")).toHaveValue("M2 Scale volume");
      await expect(fields.getByLabel("Start")).toHaveValue("2026-12-05");
      await expect(fields.getByLabel("End")).toHaveAttribute("type", "date");
      await fields.getByLabel("Start").fill("2026-12-07");
      await fields.getByLabel("End").fill("2026-12-16");
      await tap(add.getByRole("button", { name: "Apply" }));
      await expect(add.getByTestId("chat-card-summary")).toHaveText("Add Dashboard under Growth to M2 Scale volume, 7 Dec – 16 Dec");
      await expect(add).toHaveAttribute("data-status", "applied");

      await tap(move.getByRole("button", { name: "Reject" }));
      await expect(move).toHaveAttribute("data-status", "discarded");
      await expect(move.getByTestId("chat-card-outcome")).toContainText("Rejected: nothing changed");
      await expect(bar(page, "reliability-work")).toHaveAttribute("data-start", "2026-10-31");
      await expect(bar(page, "dashboard")).toHaveAttribute("data-start", "2026-12-07");
    });

    /**
     * Card roadmap-talk-correct-restates: protects = Correct in the item's talk changes the
     * "I understood:" line to the corrected dates, which apply; fails_when = the line keeps
     * Oracle's reading while other dates apply; no_claim = the card's layout.
     */
    test(`Correct in the card's talk restates the corrected move (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const { talk } = await openTalk(page, "adaptive-pacing", phone);
      await say(talk, "move it two weeks later");
      const c = talk.getByTestId("chat-card");
      await expect(c).toHaveCount(1);
      await tap(c.getByRole("button", { name: "Correct" }));
      const fields = c.getByTestId("chat-card-correct");
      await fields.getByLabel("Start").fill("2026-12-07");
      await fields.getByLabel("End").fill("2026-12-16");
      await tap(c.getByRole("button", { name: "Apply" }));
      await expect(c).toHaveAttribute("data-status", "applied");
      await expect(last(talk).getByTestId("chat-message-body")).toHaveText("I understood: move F-16 Adaptive pacing to 7 Dec – 16 Dec.");
      await expect(bar(page, "adaptive-pacing")).toHaveAttribute("data-start", "2026-12-07");
    });

    /**
     * Card roadmap-talk-split-cut: protects = a split's new slices are named "…: slice 2" as
     * the API names them, and a cut card says Reject like every roadmap card; fails_when =
     * the slice is named otherwise or the cut card says Discard; no_claim = the slices' dates.
     */
    test(`a split names its slices and a cut card says Reject (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const { talk } = await openTalk(page, "adaptive-pacing", phone);
      await say(talk, "split it into two slices");
      await expect(card(talk, "Adaptive pacing: slice 2")).toHaveCount(1);
      await say(talk, "cut it");
      const cut = card(talk, "Cut F-16");
      await expect(cut.getByRole("button", { name: "Reject" })).toBeVisible();
      await expect(cut.getByRole("button", { name: "Discard" })).toHaveCount(0);
    });

    /**
     * Card roadmap-talk-apply-all: protects = Apply all on the roadmap's two-action line
     * applies both cards, with the values typed into an open Correct form, and both bars
     * move and flash (the new item's too); fails_when = the timeline keeps the old bars
     * until a reload, nothing flashes, or Apply all ignores the corrected values;
     * no_claim = the flash's look.
     */
    test(`Apply all applies both changes and flashes their bars (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      await expect(bar(page, "reliability-work")).toHaveAttribute("data-start", "2026-10-31");
      const panel = await openAsk(page, phone);
      await say(panel, "push the reliability work after the sign-up work and add a dashboard item to M2 under Growth");
      await expect(panel.getByTestId("chat-message-body").filter({ hasText: "I understood two changes:" })).toBeVisible({ timeout: 10_000 });
      const add = card(panel, "Add Dashboard");
      await tap(add.getByRole("button", { name: "Correct" }));
      const fields = add.getByTestId("chat-card-correct");
      await fields.getByLabel("Start").fill("2026-12-07");
      await fields.getByLabel("End").fill("2026-12-16");
      await tap(panel.getByRole("button", { name: "Apply all" }));
      await expect(card(panel, "Reliability work")).toHaveAttribute("data-status", "applied");
      await expect(card(panel, "Add Dashboard")).toHaveAttribute("data-status", "applied");
      await expect(bar(page, "reliability-work")).toHaveAttribute("data-start", "2026-11-11");
      await expect(bar(page, "reliability-work")).toHaveAttribute("data-flash", "true");
      await expect(bar(page, "dashboard")).toHaveAttribute("data-start", "2026-12-07");
      await expect(bar(page, "dashboard")).toHaveAttribute("data-flash", "true");
    });

    /**
     * Card roadmap-talk-wide-edge: protects = the widened talk card opened from the bar
     * nearest the right edge stays inside the roadmap (it moves left), not at the narrow
     * card's offset; fails_when = its right edge runs past the roadmap; no_claim = a phone
     * (a bottom sheet there).
     */
    test(`the talk card opened near the right edge stays inside the roadmap (${where})`, async ({ page }) => {
      test.skip(phone, "a phone's card is a bottom sheet");
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const bars = page.locator('[data-testid="bar"]');
      await expect(bars.first()).toBeVisible();
      const rights = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
      await bars.nth(rights.indexOf(Math.max(...rights))).click();
      const floating = page.getByTestId("floating-card");
      await tap(floating.getByRole("button", { name: "Talk to Oracle" }));
      await expect(floating).toHaveAttribute("data-talk", "true");
      await expect(floating.getByTestId("item-talk")).toBeVisible();
      const over = await floating.evaluate((el) => el.getBoundingClientRect().right - (el as HTMLElement).offsetParent!.getBoundingClientRect().right);
      expect(over).toBeLessThanOrEqual(0);
      expect((await floating.boundingBox())!.width).toBeGreaterThan(800);
    });

    /**
     * Card roadmap-talk-viewer: protects = a viewer may talk with Oracle about an item but a
     * change gets a plain note and no action card; fails_when = a viewer is shown a card or
     * an Apply button; no_claim = the note's exact words.
     */
    test(`a viewer gets no cards in the card's talk (${where})`, async ({ page }) => {
      await signIn(page, EMAILS.viewer, "/simple/roadmap");
      const { talk } = await openTalk(page, "adaptive-pacing", phone);
      await say(talk, "move it two weeks later");
      await expect(last(talk)).toHaveAttribute("data-kind", "note");
      await expect(last(talk).getByTestId("chat-message-body")).toContainText("Viewers ask questions here");
      await expect(talk.getByTestId("chat-card")).toHaveCount(0);
      await expect(talk.getByRole("button", { name: "Apply" })).toHaveCount(0);
    });
  });
}
