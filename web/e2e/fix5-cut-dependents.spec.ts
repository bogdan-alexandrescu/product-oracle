import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix5-cut-dependents (qa-simple-roadmap-24, the owner's pick of 2026-10-30): a cut card on an
 * item others depend on offers "Cut it, keep the dependents" and "Cut it and its dependents".
 * The second cuts the item and everything that waits on it as one change: one row in the
 * draft's change list naming every item it cut, undone as one by Undo. Driven through the
 * item card's talk on the mock ("roadmap-talk": Alert rules engine, which Weekly alert digest
 * and Mobile alert push depend on). Desktop 1440x900 and phone 390x844.
 *
 * protects: the second button shows only on a cut with dependents, cuts them all in one change
 *   (one change-list row naming each), one Undo brings them all back; a commenter proposes it
 *   (a viewer's is disabled with the reason: simple-ask-changes.spec.ts)
 * fails_when: the button is missing or shown on an item no one depends on, the dependents stay,
 *   the cut is several rows or the undo leaves one cut
 * no_claim: the API's own rules (api/tests/test_simple_cut_dependents_api.py)
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const BOTH = "Cut it and its dependents";
const KEEP = "Cut it, keep the dependents";

async function open(page: Page, email?: string) {
  await page.context().addInitScript(
    ([key, themeKey]) => {
      localStorage.setItem(key, "roadmap-talk");
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, THEME_KEY] as const,
  );
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 640;

async function openTalk(page: Page, key: string): Promise<Locator> {
  if (!phone(page)) {
    const body = page.locator(`g[data-testid="bar"][data-item="${key}"]`).locator("rect[data-body], rect[data-slice-body]").first();
    await expect(body).toBeVisible();
    await body.click();
  } else await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  if (phone(page)) {
    // A phone's sheet: the Talk to Oracle tab.
    await card.getByRole("tab", { name: "Talk to Oracle" }).click();
    await expect(card.getByRole("tab", { name: "Talk to Oracle" })).toHaveAttribute("aria-selected", "true");
  } else {
    await card.getByRole("button", { name: "Talk to Oracle" }).click();
    await expect(card).toHaveAttribute("data-talk", "true");
  }
  return card.getByTestId("item-talk");
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await box.getByRole("button", { name: "Send" }).click();
}

const kind = (page: Page, key: string) => page.locator(`g[data-testid="bar"][data-item="${key}"]`).first();

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test(`cut it and its dependents: one change, named in the change list, undone as one (${where})`, async ({ page }) => {
      await open(page);
      const talk = await openTalk(page, "alert-rules");
      await say(talk, "cut it");
      const cut = talk.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" });
      await expect(cut.getByRole("button", { name: KEEP })).toBeEnabled();
      const both = cut.getByRole("button", { name: BOTH, exact: true });
      await expect(both).toBeEnabled();
      // Neither long label is cut short (the row is a 2-column grid with them).
      for (const b of [both, cut.getByRole("button", { name: KEEP })]) expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await both.click();
      await expect(cut).toHaveAttribute("data-status", "applied");
      await expect(cut.getByTestId("chat-card-summary")).toContainText("Weekly alert digest");
      await expect(cut.getByTestId("chat-card-summary")).toContainText("Mobile alert push");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("floating-card")).toHaveCount(0);
      // The chart's bars (a phone lists its lanes instead: the change list below says it).
      if (!phone(page)) {
        for (const key of ["alert-rules", "alert-digest", "alert-mobile"]) await expect(kind(page, key)).toHaveAttribute("data-kind", "cut");
        await expect(kind(page, "alert-export")).not.toHaveAttribute("data-kind", "cut");
      }

      const banner = page.getByTestId("draft-banner");
      await expect(banner.getByTestId("draft-count")).toHaveText("1");
      await banner.getByRole("button", { name: "See changes" }).click();
      const rows = banner.getByTestId("draft-changes").getByRole("listitem");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("Cut Alert rules engine and its dependents");
      await expect(rows.first()).toContainText("Weekly alert digest");
      await expect(rows.first()).toContainText("Mobile alert push");

      await banner.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("draft-changes").getByText("Cut Alert rules engine and its dependents")).toHaveCount(0);
      if (!phone(page)) for (const key of ["alert-rules", "alert-digest", "alert-mobile"]) await expect(kind(page, key)).not.toHaveAttribute("data-kind", "cut");
    });

    test(`an item no one depends on has only its Apply (${where})`, async ({ page }) => {
      await open(page);
      const talk = await openTalk(page, "setup-import");
      await say(talk, "cut it");
      const cut = talk.getByTestId("chat-card").filter({ hasText: "Cut Sample data import" });
      await expect(cut.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
      await expect(cut.getByRole("button", { name: BOTH })).toHaveCount(0);
      await expect(cut.getByRole("button", { name: KEEP })).toHaveCount(0);
    });

    test(`a commenter proposes it (${where})`, async ({ page }) => {
      await open(page, "commenter@example.com");
      const talk = await openTalk(page, "alert-rules");
      await say(talk, "cut it");
      const cut = talk.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" });
      await cut.getByRole("button", { name: `Propose: ${BOTH.toLowerCase()}` }).click();
      await expect(cut).toHaveAttribute("data-status", "proposed");
      await page.keyboard.press("Escape");
      // A proposal writes nothing: no working draft, no cut bar.
      await expect(page.getByTestId("draft-banner")).toHaveCount(0);
      if (!phone(page)) await expect(kind(page, "alert-digest")).not.toHaveAttribute("data-kind", "cut");
    });
  });
}
