import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix4, the roadmap item card, its talk with Oracle and the Ask panel's change cards, driven
 * through the UI on the mock: the default scenario (Weekly alert digest, F-06, depends on Alert
 * rules engine and starts before it ends; D-7 is open on it) and "roadmap-talk" (Adaptive
 * pacing, F-16). Desktop 1440x900, phone 390x844; light and dark where colours change.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, opts: { email?: string; scenario?: string; theme?: "light" | "dark" } = {}) {
  const { scenario, theme = "light" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey, t]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, t);
    },
    [MOCK_SCENARIO_KEY, scenario ?? "", THEME_KEY, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await login(page, opts.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function openCard(page: Page, key: string): Promise<Locator> {
  await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  return card;
}

async function openTalk(card: Locator): Promise<Locator> {
  await card.getByRole("button", { name: "Talk to Oracle" }).click();
  await expect(card).toHaveAttribute("data-talk", "true");
  return card.getByTestId("item-talk");
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await box.getByRole("button", { name: "Send" }).click();
}

/** The WCAG contrast of two computed CSS colours ("rgb(…)" / "rgba(…)"). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test.describe("desktop 1440x900", () => {
  test.use(DESKTOP);

  test("qa-simple-roadmap-3 / 42: the card, its talk and its decisions show titles only, empty values capitalised", async ({ page }) => {
    await open(page);
    const card = await openCard(page, "alert-digest");
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Weekly alert digest");
    await expect(card.getByTestId("card-decisions")).toHaveText("Send the digest weekly or daily?");
    await expect(card.getByTestId("card-decisions").getByRole("link", { name: "Send the digest weekly or daily?" })).toBeVisible();
    await expect(card.getByTestId("card-reasons")).not.toContainText("(draft");
    await expect(card.getByTestId("card-reasons")).not.toContainText("F-06");
    await expect(card.getByTestId("card-needed")).toHaveText("No other items");
    await expect(card).not.toContainText(/\b[FD]-\d/);
    const talk = await openTalk(card);
    await expect(talk.getByRole("heading", { name: "Talk about Weekly alert digest", exact: true })).toBeVisible();
    await expect(talk.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask about Weekly alert digest, or ask for a change…");
    await expect(card).not.toContainText(/\b[FD]-\d/);

    await card.getByRole("button", { name: "Close" }).click();
    const rules = await openCard(page, "alert-rules");
    await expect(rules.getByText("No open decisions", { exact: true })).toBeVisible();
    await expect(rules.getByText("No proposals waiting", { exact: true })).toBeVisible();
  });

  test("qa-simple-roadmap-18: a commenter's fixes say they only propose", async ({ page }) => {
    await open(page, { email: "commenter@example.com" });
    const card = await openCard(page, "alert-digest");
    const fixes = card.getByTestId("card-flags").getByTestId("fixes");
    await expect(fixes.getByRole("button", { name: "Propose: move the dependents" })).toBeVisible();
    await expect(fixes.getByRole("button", { name: "Propose: move the dependency" })).toBeVisible();
    await expect(fixes.getByRole("button", { name: "Propose: accept as risk" })).toBeVisible();
    await expect(fixes.getByRole("button", { name: "Move the dependents", exact: true })).toHaveCount(0);
  });

  test("qa-simple-roadmap-18: the owner's fixes stay plain", async ({ page }) => {
    await open(page);
    const card = await openCard(page, "alert-digest");
    const fixes = card.getByTestId("card-flags").getByTestId("fixes");
    await expect(fixes.getByRole("button", { name: "Move the dependents", exact: true })).toBeVisible();
    await expect(fixes.getByRole("button", { name: /^Propose/ })).toHaveCount(0);
  });

  test("qa-simple-roadmap-16 / 25 / 20 / 27: a talk's waiting change is under Proposals on it; Change it… opens whole; Applied by you", async ({ page }) => {
    await open(page, { scenario: "roadmap-talk" });
    const card = await openCard(page, "adaptive-pacing");
    const talk = await openTalk(card);
    await say(talk, "move it two weeks later");
    const c = talk.getByTestId("chat-card");
    await expect(c).toHaveCount(1);

    // 16: the details' "Proposals on it" lists the change waiting in the talk.
    const waiting = card.getByTestId("card-talk-proposal");
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText("Move Adaptive pacing");
    await expect(card.getByText("No proposals waiting")).toHaveCount(0);

    // 25: "Change it…", on one row with the other actions.
    const change = c.getByRole("button", { name: "Change it…" });
    await expect(change).toBeVisible();
    await expect(c.getByRole("button", { name: "Correct", exact: true })).toHaveCount(0);
    const ys = await Promise.all(["Preview", "Apply", "Reject", "Change it…"].map(async (n) => (await c.getByRole("button", { name: n, exact: true }).boundingBox())!.y));
    for (const y of ys) expect(Math.abs(y - ys[0])).toBeLessThan(2);

    // 20: the opened form scrolls into view, its Start field and the Apply under it both visible.
    await change.click();
    await expect(c.getByTestId("chat-card-correct")).toBeVisible();
    const thread = (await talk.getByTestId("item-talk-thread").boundingBox())!;
    await expect
      .poll(async () => {
        const apply = (await c.getByRole("button", { name: "Apply", exact: true }).boundingBox())!;
        return apply.y + apply.height <= thread.y + thread.height + 1;
      })
      .toBe(true);
    const start = (await c.getByTestId("chat-card-correct").getByLabel("Start").boundingBox())!;
    expect(start.y).toBeGreaterThanOrEqual(thread.y - 1);

    // 27: the reader's own change says "you", and its Undo says what it undoes.
    await c.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(c).toHaveAttribute("data-status", "applied");
    await expect(c.getByTestId("chat-card-outcome")).toContainText("Applied by you");
    await expect(c.getByRole("button", { name: "Undo this change" })).toBeVisible();
    await expect(waiting).toHaveCount(0);
  });

  test("qa-simple-roadmap-24: a cut offers no dependency moves, its Apply says the dependents stay", async ({ page }) => {
    await open(page, { scenario: "roadmap-talk" });
    const card = await openCard(page, "alert-rules");
    const talk = await openTalk(card);
    await say(talk, "cut it");
    const cut = talk.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" });
    await expect(cut).toBeVisible();
    await expect(cut.getByTestId("chat-card-flag").first()).toBeVisible();
    await expect(cut.getByTestId("chat-card-fix")).toHaveCount(0);
    await expect(cut.getByRole("button", { name: "Cut it, keep the dependents" })).toBeVisible();
  });

  test("qa-simple-roadmap-26 / 50: the Ask panel's move card has Before → After, warnings styled, a tidy title and curly quotes", async ({ page }) => {
    await open(page);
    await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await expect(panel.getByTestId("ask-chat")).toBeVisible();
    await say(panel, "  move Weekly alert digest to Q2 ");
    await expect(panel.getByTestId("ask-about")).toHaveText("Move Weekly alert digest to Q2");
    const c = panel.getByTestId("chat-card").filter({ hasText: "Move Weekly alert digest" });
    await expect(c).toBeVisible();
    await expect(c.getByTestId("chat-card-change")).toContainText("Before:");
    await expect(c.getByTestId("chat-card-change")).toContainText("→ After:");
    const flag = c.getByTestId("chat-card-flag").first();
    await expect(flag).toBeVisible();
    await expect(flag).not.toContainText("'");
    await expect(flag).toContainText("“");
    // A warning, not plain text: the red callout's tinted background.
    expect(await flag.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("qa-simple-roadmap-39: the widened card keeps the flow row and its action", async ({ page }) => {
    await open(page, { scenario: "roadmap-talk" });
    const card = await openCard(page, "adaptive-pacing");
    const flow = card.getByTestId("card-flow");
    await expect(flow.getByRole("button", { name: "Ask Oracle to draw it" })).toBeVisible();
    await openTalk(card);
    await expect(flow.getByRole("button", { name: "Ask Oracle to draw it" })).toBeVisible();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`qa-simple-roadmap-40 / 41: an opaque talk header; an empty box's Send reads disabled and legible; one focus ring (${theme})`, async ({ page }) => {
      await open(page, { scenario: "roadmap-talk", theme });
      const card = await openCard(page, "adaptive-pacing");
      const talk = await openTalk(card);
      const head = talk.getByTestId("item-talk-title").locator("xpath=..");
      const style = await head.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderBottomWidth };
      });
      expect(style.bg).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.border).toBe("1px");

      const send = talk.getByRole("button", { name: "Send" });
      await expect(send).toBeDisabled();
      const s = await send.evaluate((el) => {
        const c = getComputedStyle(el);
        return { opacity: c.opacity, color: c.color, bg: c.backgroundColor };
      });
      expect(s.opacity).toBe("1");
      expect(contrast(s.color, s.bg)).toBeGreaterThanOrEqual(4.5);
      // Not the accent of an enabled Send.
      await talk.getByRole("textbox", { name: "Message Oracle" }).fill("hello");
      const on = await send.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(on).not.toBe(s.bg);

      const box = talk.getByRole("textbox", { name: "Message Oracle" });
      await box.focus();
      await page.keyboard.press("End");
      expect(await box.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe("-1px");
    });
  }
});

test.describe("phone 390x844", () => {
  test.use(PHONE);

  test("qa-simple-roadmap-43: the item's sheet spans the screen", async ({ page }) => {
    await open(page);
    const card = await openCard(page, "alert-digest");
    const box = (await card.boundingBox())!;
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.x)).toBe(0);
    // One scroll area: the sheet itself does not scroll, its Details panel does.
    expect(await card.evaluate((el) => getComputedStyle(el).overflowY)).toBe("hidden");
  });
});
