import { expect, test, type Locator, type Page } from "./test";

import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * QA fixes on Simple's shell and Ask panel (qa-simple-home-18 to 25 and 29), driven through the
 * UI against the mock (invented data). Desktop = 1440x900, phone = 390x844.
 *
 * Card fix4-simple-shell-ask: protects = on a phone Tab reaches the header and the page before
 * the tab bar; the phone's More sheet has Detailed's title, close button, handle and dimmed
 * backdrop and fits its links; the chosen mode reads as chosen in dark; a member with no name
 * shows their email once, broken only after the "@"; an unsent draft stays with its page's chat;
 * a General chat says "New general chat"; the rail's Ask Oracle says it is open; Recent chats is
 * a 44 px target on a phone; a long word wraps in its bubble; fails_when = any of those regresses;
 * no_claim = the real API.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWER = "viewer@example.com";

async function setUp(page: Page, size: { width: number; height: number }, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(([themeKey, theme]) => localStorage.setItem(themeKey, theme), [THEME_KEY, scheme] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(size);
}

async function signIn(page: Page, email: string = ADMIN.email) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

async function openAsk(page: Page): Promise<Locator> {
  await page.getByTestId("simple-ask").click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

const box = async (l: Locator) => (await l.boundingBox())!;

test("qa-simple-home-18: on a phone Tab goes skip link, header and page, then the tab bar", async ({ page }) => {
  await setUp(page, PHONE);
  await signIn(page);
  const bar = page.getByTestId("simple-tab-bar");
  await expect(bar).toBeVisible();
  // The tab bar comes after the page in the document, still fixed at the bottom of the screen.
  expect(await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const tabs = document.querySelector('[data-testid="simple-tab-bar"]')!;
    return !!(main.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING) && !main.contains(tabs);
  })).toBe(true);
  const b = await box(bar);
  expect(Math.abs(b.y + b.height - PHONE.height)).toBeLessThanOrEqual(1);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("skip-link")).toBeFocused();
  await page.keyboard.press("Tab");
  // Next is the header's logo in the page's frame, not the tab bar's Home.
  expect(await page.evaluate(() => !!document.activeElement?.closest("#main"))).toBe(true);
  await expect(page.getByTestId("simple-tab-home")).not.toBeFocused();
});

test("qa-simple-home-19: the phone's More sheet has a title, close button, handle and dimmed backdrop, sized to its links", async ({ page }) => {
  await setUp(page, PHONE);
  await signIn(page);
  await page.getByTestId("simple-tab-more").click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "More" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close More" })).toBeVisible();
  await expect(sheet.getByTestId("sheet-handle")).toBeVisible();
  const scrim = page.getByTestId("simple-more-sheet").getByTestId("sheet-scrim");
  await expect(scrim).toBeVisible();
  expect(await scrim.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/^rgba\(0, 0, 0, 0\)$|transparent/);

  // Sized to its content: the two links share the row and the sheet ends just under them.
  const s = await box(sheet);
  const links = sheet.getByRole("link");
  await expect(links).toHaveCount(2);
  const last = await box(links.nth(1));
  expect(s.y + s.height - (last.y + last.height)).toBeLessThanOrEqual(16);
  expect(s.x + s.width - (last.x + last.width)).toBeLessThanOrEqual(16);

  await sheet.getByRole("button", { name: "Close More" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("simple-tab-more")).toHaveAttribute("aria-expanded", "false");
});

test("qa-simple-home-20: in dark the chosen mode is a lighter, outlined pill on its track (desktop, dark)", async ({ page }) => {
  await setUp(page, DESKTOP, "dark");
  await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const sw = page.getByTestId("mode-switch");
  const on = sw.locator('[aria-checked="true"]');
  await expect(on).toHaveText("Simple");
  const lum = (l: Locator) =>
    l.evaluate((el) => {
      const [r, g, b] = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)!.map(Number);
      const c = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
    });
  const pill = await lum(on);
  const track = await lum(sw);
  expect(pill).toBeGreaterThan(track);
  expect((pill + 0.05) / (track + 0.05)).toBeGreaterThanOrEqual(1.5);
  expect(await on.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
});

test("qa-simple-home-21: a member with no name shows their email once, broken only after the @ (desktop)", async ({ page }) => {
  await setUp(page, DESKTOP);
  await signIn(page, VIEWER);
  const person = page.getByTestId("simple-person");
  const name = page.getByTestId("simple-person-name");
  await expect(name).toHaveText(VIEWER);
  // Said once: the avatar says it; the line beside it is not read a second time.
  const said = await person.ariaSnapshot();
  expect(said.split(VIEWER).length - 1).toBe(1);
  // "example.com" stays on one line (never "viewer@example.co" / "m").
  const lines = await name.evaluate((el) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent!.indexOf("example.com");
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + "example.com".length);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    }
    return -1;
  });
  expect(lines).toBe(1);
  expect(await name.evaluate((el) => getComputedStyle(el).overflowWrap)).not.toBe("anywhere");
});

test("qa-simple-home-22: an unsent draft stays with its page's chat (desktop)", async ({ page }) => {
  await setUp(page, DESKTOP);
  await signIn(page);
  const panel = await openAsk(page);
  const textbox = panel.getByRole("textbox", { name: "Message Oracle" });
  await textbox.fill("a draft about home");
  await page.getByTestId("simple-nav-roadmap").click();
  await expect(page).toHaveURL(/\/simple\/roadmap$/);
  await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Roadmap");
  await expect(textbox).toHaveValue("");
  await textbox.fill("a draft about the roadmap");
  await page.getByTestId("simple-nav-home").click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Home");
  await expect(textbox).toHaveValue("a draft about home");
  await page.getByTestId("simple-nav-roadmap").click();
  await expect(textbox).toHaveValue("a draft about the roadmap");
});

test("qa-simple-home-23: a General chat says New general chat (desktop)", async ({ page }) => {
  await setUp(page, DESKTOP);
  await signIn(page);
  const panel = await openAsk(page);
  await panel.getByRole("group", { name: "About" }).getByRole("button", { name: "General", exact: true }).click();
  await expect(panel.getByTestId("ask-about")).toHaveText("New general chat");
});

test("qa-simple-home-24: the rail's Ask Oracle says it is open, which panel it controls, and looks pressed (desktop)", async ({ page }) => {
  await setUp(page, DESKTOP);
  await signIn(page);
  const ask = page.getByTestId("simple-ask");
  await expect(ask).toHaveAttribute("aria-expanded", "false");
  const controls = await ask.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  const closedBg = await ask.evaluate((el) => getComputedStyle(el).backgroundColor);
  await ask.click();
  await expect(ask).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`[id="${controls}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  await page.mouse.move(700, 450);
  await expect.poll(() => ask.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(closedBg);
  // Pressed again, it closes the panel.
  await ask.click();
  await expect(ask).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("hop-panel")).toHaveCount(0);
});

for (const phone of [false, true]) {
  test(`qa-simple-home-25: Recent chats is a big enough tap target (${phone ? "phone" : "desktop"})`, async ({ page }) => {
    await setUp(page, phone ? PHONE : DESKTOP);
    await signIn(page);
    await page.getByTestId(phone ? "phone-ask" : "simple-ask").click();
    const recent = page.getByTestId("hop-panel").filter({ visible: true }).getByTestId("ask-recent");
    await expect(recent).toBeVisible();
    const r = await box(recent);
    expect(r.height).toBeGreaterThanOrEqual(phone ? 44 : 24);
  });

  test(`qa-simple-home-29: a long unbroken word wraps in its bubble, the chat never scrolls sideways (${phone ? "phone" : "desktop"})`, async ({ page }) => {
    await setUp(page, phone ? PHONE : DESKTOP);
    await signIn(page);
    await page.getByTestId(phone ? "phone-ask" : "simple-ask").click();
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    const word = "a".repeat(300);
    await panel.getByRole("textbox", { name: "Message Oracle" }).fill(word);
    await panel.getByRole("button", { name: "Send" }).click();
    const mine = panel.locator('[data-testid="chat-message"][data-author="person"]').filter({ hasText: word });
    await expect(mine.first()).toBeVisible();
    const thread = panel.getByTestId("ask-chat-thread");
    const fits = (l: Locator) => l.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(await fits(thread)).toBe(true);
    expect(await thread.evaluate((el) => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth)).toBe(true);
    const bubble = await box(mine.first().getByTestId("chat-message-body"));
    const t = await box(thread);
    expect(bubble.x + bubble.width).toBeLessThanOrEqual(t.x + t.width + 1);
  });
}
