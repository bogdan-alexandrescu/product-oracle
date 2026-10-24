import { expect, test, type Page } from "./test";

import { login, openSection } from "./helpers";

/*
 * G7 Head-of-product panel through the UI, on the mock layer: the 44 px "Ask" strip on the
 * right edge, ⌘J / Ctrl+J and Esc, the 400 px docked panel, what it is about, a private panel
 * chat with Oracle's streamed reply, Share as discussion, the phone sheet, where it never
 * shows, and its remembered state.
 *
 * Cards: Layout: protects=docked on every screen with no sideways scroll, desktop and phone;
 * fails_when=the strip is missing, overlaps content or scrolls; no_claim=visual taste.
 * Privacy of panel chats: protects=only you, until shared; fails_when=the chat offers Make
 * open or Share as discussion leaves it open; no_claim=G1 access internals (API tests).
 * Changes card: protects=AUD-1, the panel never changes a locked section; fails_when=Stage is
 * enabled on a locked section, or shown to a commenter; no_claim=staging itself (G3, G4).
 */

const DOC = "/documents/checkout-redesign/v/2";
const DOC_HOME = "/documents/checkout-redesign";
const LOCKED_DOC = "/documents/usage-alerts/v/1";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const ANSWER_START = "Yes, if caps";

const panel = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });
const strip = (page: Page) => page.getByTestId("hop-strip");

async function noSidewaysScroll(page: Page, where?: string) {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, where).toBeLessThanOrEqual(inner);
}

async function contrast(page: Page): Promise<number> {
  return page.getByTestId("hop-panel").evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const style = getComputedStyle(el);
    const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

// Layout card: criteria 1 and 14.
test("every screen shows the Ask strip; ⌘J opens the 400 px panel and Esc closes it, with no sideways scroll", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  const runHref = () => page.locator('a[href^="/runs/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!).find((h) => /^\/runs\/[0-9a-f-]{36}$/.test(h)));
  await expect.poll(runHref).toBeTruthy();
  const run = await runHref();
  for (const path of ["/home", "/documents", "/runs", "/inbox", "/priorities", DOC, `${DOC_HOME}/diff`, `${DOC_HOME}/publish`, run!]) {
    await page.goto(path);
    await expect(strip(page)).toBeVisible();
    expect((await strip(page).boundingBox())!.width).toBe(44);
    await noSidewaysScroll(page, path);
  }
  await page.keyboard.press("ControlOrMeta+j");
  await expect(panel(page)).toBeVisible();
  expect((await page.getByTestId("hop-dock").boundingBox())!.width).toBe(400);
  await noSidewaysScroll(page);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(strip(page)).toBeVisible();
  await strip(page).click();
  await expect(panel(page)).toBeVisible();
  await page.goto("/home");
  await expect(panel(page)).toBeVisible();
  await noSidewaysScroll(page);
});

// Criterion 2: the panel is about the open section; General switches it.
test("the panel is about the open section, or General", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(DOC);
  await openSection(page, "problem");
  await strip(page).click();
  await expect(panel(page).getByTestId("hop-about")).toHaveText(/^About: Checkout redesign PRD · .*Problem$/);
  await expect(panel(page).getByRole("textbox", { name: "Ask Oracle" })).toHaveAttribute("placeholder", /^Ask about Checkout redesign PRD · .*Problem…$/);
  await expect(panel(page).getByTestId("hop-visibility")).toHaveText(/Just you and Oracle/);
  await expect(panel(page).getByTestId("hop-empty")).toHaveText("Ask why something is ranked, what to cut, or what is missing.");
  await panel(page).getByRole("button", { name: "General" }).click();
  await expect(panel(page).getByTestId("hop-about")).toHaveText("About: General");
  await panel(page).getByRole("button", { name: "This page" }).click();
  await expect(panel(page).getByTestId("hop-about")).toHaveText(/Problem$/);
});

// Criterion 2 on the document's diff and publish pages: the panel is about the document, and a new chat keeps it.
test("the diff and publish pages are about their document, and a chat started there is too", async ({ page }) => {
  await login(page);
  await page.goto(`${DOC_HOME}/diff`);
  await strip(page).click();
  await expect(panel(page).getByTestId("hop-about")).toHaveText("About: Checkout redesign PRD");
  // The panel stays open (remembered) on the publish page.
  await page.goto(`${DOC_HOME}/publish`);
  await expect(panel(page).getByTestId("hop-about")).toHaveText("About: Checkout redesign PRD");
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill("What is left before we publish?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(panel(page).getByTestId("discussion-thread")).toBeVisible();
  await expect(panel(page).getByTestId("hop-about")).toHaveText("About: Checkout redesign PRD");
});

// Criterion 6: a section_edit Oracle proposes on a locked section cannot be staged.
test("a change Oracle proposes on a locked section shows Stage disabled with the locked reason", async ({ page }) => {
  await login(page, APPROVER);
  await page.goto(LOCKED_DOC);
  await openSection(page, "behaviour");
  await strip(page).click();
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill("Rewrite this section to name the alert threshold.");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(panel(page).getByTestId("oracle-reply").last()).toContainText(ANSWER_START);
  const card = panel(page).getByTestId("hop-changes");
  await expect(card).toBeVisible();
  const change = card.getByTestId("hop-change");
  await expect(change).toHaveCount(1);
  await expect(change).toContainText("Change behaviour");
  await expect(change).toContainText("Proposed");
  const stage = change.getByRole("button", { name: "Stage" });
  await expect(stage).toBeDisabled();
  await expect(stage).toHaveAttribute("title", "Section 1. Behaviour is approved and locked");
  await expect(change.getByTestId("hop-change-blocked")).toHaveText("Section 1. Behaviour is approved and locked");
});

// Criterion 6, c6 and the owner's rule: a commenter never stages, so Stage is hidden for them.
test("a commenter sees the proposed change without a Stage button", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(LOCKED_DOC);
  await openSection(page, "behaviour");
  await strip(page).click();
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill("Rewrite this section to name the alert threshold.");
  await panel(page).getByRole("button", { name: "Send" }).click();
  const change = panel(page).getByTestId("hop-change");
  await expect(change).toContainText("Change behaviour");
  await expect(change.getByRole("button", { name: "Stage" })).toHaveCount(0);
});

// Privacy card: criteria 3 and 5.
test("a panel chat is private, Oracle's reply streams in, and Share as discussion opens an open one", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(DOC);
  await openSection(page, "problem");
  await strip(page).click();
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill("Why is this ranked third?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  const thread = panel(page).getByTestId("discussion-thread");
  await expect(thread).toBeVisible();
  await expect(thread.getByTestId("discussion-visibility")).toHaveText("Private");
  await expect(thread.getByTestId("discussion-people")).toHaveText("1 person");
  await expect(thread.getByTestId("oracle-reply").last()).toContainText(ANSWER_START);
  await expect(panel(page).getByTestId("hop-about")).toHaveText(/Problem$/);
  // ⋯ has no Make open on a panel chat.
  await thread.getByRole("button", { name: "Discussion actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Write summary" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Make open" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await panel(page).getByRole("button", { name: "Share as discussion" }).click();
  const form = panel(page).getByTestId("hop-share-form");
  await expect(form.getByRole("textbox", { name: "First message" })).toHaveValue(new RegExp(`^${ANSWER_START}`));
  await form.getByRole("textbox", { name: "First message" }).fill("Name the drop-off measure before we ship.");
  await form.getByRole("button", { name: "Post" }).click();
  await expect(panel(page).getByTestId("hop-shared")).toBeVisible();
  const shared = panel(page).getByTestId("discussion-thread");
  await expect(shared.getByTestId("discussion-visibility")).toHaveText("Open");
  await expect(shared.getByTestId("discussion-message").first()).toContainText("Name the drop-off measure before we ship.");

  // The chat itself is still private, under Recent.
  await panel(page).getByRole("button", { name: "New chat" }).click();
  const recent = panel(page).getByRole("region", { name: "Recent" });
  await recent.getByTestId("hop-chat-row").first().click();
  await expect(panel(page).getByTestId("discussion-visibility")).toHaveText("Private");
});

// Layout card: criterion 8.
test("on a phone the header's Ask opens a full-height sheet and the tab bar stays reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, COMMENTER);
  await expect(strip(page)).toBeHidden();
  await page.getByTestId("phone-ask").click();
  const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
  await expect(sheet).toBeVisible();
  expect((await sheet.boundingBox())!.height).toBeGreaterThanOrEqual(840);
  await expect(sheet.getByRole("textbox", { name: "Ask Oracle" })).toBeInViewport();
  await sheet.getByRole("button", { name: "Close Ask Oracle" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByTestId("tab-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  await noSidewaysScroll(page);
});

// Criterion 9.
test("the panel never shows on sign-in, consent or present mode", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
  await login(page);
  await expect(strip(page)).toBeVisible();
  for (const path of ["/oauth/consent", `${DOC}/present`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(strip(page)).toHaveCount(0);
  }
});

// Criterion 10: the open state is remembered, and storage that throws reads as closed.
test("reloading keeps the panel open; with throwing storage the app renders with it closed", async ({ page, context }) => {
  await login(page);
  await strip(page).click();
  await expect(panel(page)).toBeVisible();
  await page.reload();
  await expect(panel(page)).toBeVisible();

  const other = await context.newPage();
  await other.addInitScript(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === "oracle.hop-panel.open") throw new Error("storage refused");
      return get.call(this, key);
    };
  });
  await other.goto("/home");
  await expect(other.getByTestId("hop-strip")).toBeVisible();
  await expect(other.getByTestId("hop-panel")).toHaveCount(0);
});

// Criterion 11: the open panel's contrast in light and dark themes.
test("the open panel reads at AA contrast in light and dark", async ({ page }) => {
  await login(page);
  await strip(page).click();
  await expect(panel(page)).toBeVisible();
  expect(await contrast(page)).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  expect(await contrast(page)).toBeGreaterThanOrEqual(4.5);
  const font = await panel(page).getByTestId("hop-empty").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(font).toBeGreaterThanOrEqual(15);
});
