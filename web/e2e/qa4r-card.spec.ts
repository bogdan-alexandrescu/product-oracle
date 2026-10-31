import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap's item card and its Talk to Oracle (qa4-simple-roadmap-13, 40,
 * 41), driven as a person does against the mock's "roadmap-talk" scenario (invented items:
 * Weekly alert digest, which starts before Alert rules engine ends and ends after its Beta
 * milestone; Adaptive pacing).
 */

const DESKTOP = { viewport: { width: 1512, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, opts: { scenario?: string; theme?: "light" | "dark"; url?: string } = {}) {
  const { scenario = "", theme = "light", url = "/simple/roadmap" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey, t]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, t);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1512) <= 640;

async function openCard(page: Page, key: string): Promise<Locator> {
  if (!isPhone(page)) {
    const body = page.locator(`g[data-testid="bar"][data-item="${key}"]`).locator("rect[data-body], rect[data-slice-body]").first();
    await expect(body).toBeVisible();
    await body.click();
  } else await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  return card;
}

async function openTalk(page: Page, card: Locator): Promise<Locator> {
  if (isPhone(page)) await card.getByRole("tab", { name: "Talk to Oracle" }).click();
  else await card.getByRole("button", { name: "Talk to Oracle" }).click();
  const talk = card.getByTestId("item-talk");
  await expect(talk).toBeVisible();
  return talk;
}

async function details(page: Page, card: Locator) {
  if (isPhone(page)) await card.getByRole("tab", { name: "Details" }).click();
}

async function say(talk: Locator, text: string) {
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await talk.getByRole("button", { name: "Send" }).click();
}

for (const [where, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(size);

    test(`qa4-13: after a cut from the card's talk, the card shows it cut and drops the old flags (${where})`, async ({ page }) => {
      await open(page, { scenario: "roadmap-talk" });
      const card = await openCard(page, "alert-digest");
      // Before: a broken link and a missed milestone, with their fixes.
      await expect(card.getByTestId("card-flags")).toContainText("which it depends on");
      await expect(card.getByTestId("card-flags")).toContainText("after its milestone");
      await expect(card.getByTestId("card-flags").getByTestId("fixes").first()).toBeVisible();
      const talk = await openTalk(page, card);
      await say(talk, "cut it");
      const cut = talk.getByTestId("chat-card").filter({ hasText: "Cut Weekly alert digest" });
      await expect(cut).toBeVisible();
      await cut.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(cut).toHaveAttribute("data-status", "applied");
      await details(page, card);
      // The open card reads again: cut, below the line, with no stale flags or fixes.
      await expect(card.getByTestId("card-status")).toHaveText("Cut");
      await expect(card.getByTestId("item-cut")).toHaveText("Cut: it sits below the line, out of the plan");
      await expect(card.getByTestId("card-flags")).toHaveCount(0);
      await expect(card.getByTestId("fixes")).toHaveCount(0);
    });

    test(`qa4-40: the empty talk shows its whole placeholder and a few example asks (${where})`, async ({ page }) => {
      await open(page, { scenario: "roadmap-talk" });
      const card = await openCard(page, "adaptive-pacing");
      const talk = await openTalk(page, card);
      const box = talk.getByRole("textbox", { name: "Message Oracle" });
      await expect(box).toHaveAttribute("placeholder", "Ask about Adaptive pacing, or ask for a change…");
      // The placeholder, laid out at the box's own width and font, fits inside the box.
      const fits = await box.evaluate((el) => {
        const t = el as HTMLTextAreaElement;
        const cs = getComputedStyle(t);
        const pad = (a: string, b: string) => parseFloat(a) + parseFloat(b);
        const probe = document.createElement("div");
        probe.textContent = t.placeholder;
        Object.assign(probe.style, {
          position: "absolute",
          visibility: "hidden",
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          font: cs.font,
          letterSpacing: cs.letterSpacing,
          lineHeight: cs.lineHeight,
          width: `${t.clientWidth - pad(cs.paddingLeft, cs.paddingRight)}px`,
        });
        document.body.appendChild(probe);
        const need = probe.getBoundingClientRect().height;
        probe.remove();
        return { need, room: t.clientHeight - pad(cs.paddingTop, cs.paddingBottom) };
      });
      expect(fits.need).toBeLessThanOrEqual(fits.room + 1);
      // Example asks, and a click sends one.
      const starters = talk.getByTestId("talk-starters").getByRole("button");
      await expect(starters).toHaveText(["What is it for?", "When is it?", "Move it two weeks later"]);
      await starters.first().click();
      const lines = talk.getByTestId("chat-message");
      await expect(lines.first().getByTestId("chat-message-body")).toHaveText("What is it for?");
      await expect(lines.last()).toHaveAttribute("data-kind", "answer");
      await expect(talk.getByTestId("talk-starters")).toHaveCount(0);
    });

    test(`qa4-41: a move card lists only the flags the move brings, and its preview shows (${where})`, async ({ page }) => {
      await open(page, { scenario: "roadmap-talk" });
      const card = await openCard(page, "alert-digest");
      // The item already ends after its milestone; moving it later does not change that.
      await expect(card.getByTestId("card-flags")).toContainText("after its milestone");
      const talk = await openTalk(page, card);
      await say(talk, "move it two weeks later");
      const move = talk.getByTestId("chat-card").filter({ hasText: "Move Weekly alert digest" });
      await expect(move).toBeVisible();
      await expect(move.getByTestId("chat-card-change")).toContainText("After:");
      await expect(move.getByTestId("chat-card-flag")).toHaveCount(0);
      await expect(move.getByTestId("chat-card-fix")).toHaveCount(0);
      // Preview: what it shows on the roadmap, in the card, in sight.
      await move.getByRole("button", { name: "Preview", exact: true }).click();
      const preview = move.getByTestId("chat-card-preview");
      await expect(preview).toContainText(/^On the roadmap: Weekly alert digest moves to [A-Z][a-z]{2} \d+/);
      await preview.scrollIntoViewIfNeeded();
      await expect(preview).toBeInViewport();
      await move.getByRole("button", { name: "Hide preview" }).click();
      await expect(preview).toHaveCount(0);
    });
  });
}
