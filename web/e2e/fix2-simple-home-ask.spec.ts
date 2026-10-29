import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, signOut } from "./helpers";

/*
 * QA fixes for Simple's Ask panel (qa-simple-home-6, 16-23), through the UI on desktop:
 * beside the page on a wide window, titled by its first question, "You" on one's own lines,
 * no space left where a citation marker was, New chat keeping General, the switch naming a
 * reopened chat's page, focus back to the opener on close, closed for the next person and on
 * a new visit, one wording naming the document, and a viewer's plain hint.
 */

const VIEWER = "viewer@example.com";
const APPROVER = "approver@example.com";

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

async function openAsk(page: Page): Promise<Locator> {
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

async function say(panel: Locator, text: string) {
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator('[data-testid="chat-message"][data-author="person"]').filter({ hasText: text })).not.toHaveCount(0);
}

test.describe("simple-chat", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("qa-simple-home-16: after the first question the chat is titled by it and one's own line says You", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple");
    const panel = await openAsk(page);
    await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Home");
    const q = "What is Weekly alert digest about and when does it run?";
    await say(panel, q);
    const about = panel.getByTestId("ask-about");
    await expect(about).toHaveText(q);
    await expect(about).toHaveAttribute("title", q);
    await expect(about).toHaveCSS("text-overflow", "ellipsis");
    const mine = panel.locator('[data-testid="chat-message"][data-author="person"]').first();
    await expect(mine.getByTestId("chat-who")).toHaveText(/^You · /);
    await expect(panel.getByTestId("chat-who").filter({ hasText: /^Admin/ })).toHaveCount(0);
  });

  test("qa-simple-home-17: a citation leaves no space before the punctuation after it", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple");
    const panel = await openAsk(page);
    await say(panel, "Which goal is most at risk this quarter?");
    const answer = panel.getByTestId("ask-answer").last();
    await expect(answer).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
    const body = answer.getByTestId("chat-message-body");
    await expect(body).not.toHaveText(/\s[.,;:!?]/);
    await expect(body).not.toContainText("[c:");
    // The marker is a small raised number against the word before it.
    await expect(answer.getByTestId("answer-cite").first()).toBeVisible();
    const gap = await body.evaluate((el) => {
      const sup = el.querySelector("[data-testid=answer-cite]");
      const before = sup?.previousSibling?.textContent ?? "";
      return /\s$/.test(before);
    });
    expect(gap).toBe(false);
  });

  test("qa-simple-home-18: New chat on General stays on General", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple");
    const panel = await openAsk(page);
    const about = panel.getByRole("group", { name: "About" });
    await about.getByRole("button", { name: "General", exact: true }).click();
    await say(panel, "who owns Weekly alert digest?");
    await panel.getByRole("button", { name: "New chat" }).click();
    await expect(panel.getByTestId("chat-message")).toHaveCount(0);
    await expect(about.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByTestId("ask-about")).toHaveText("New chat about General");
  });

  test("qa-simple-home-19: a Home chat reopened on Roadmap names Home on the switch", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple");
    let panel = await openAsk(page);
    await say(panel, "who owns Weekly alert digest?");
    await panel.getByRole("button", { name: "Close Ask Oracle" }).click();
    await page.goto("/simple/roadmap");
    panel = await openAsk(page);
    const about = panel.getByRole("group", { name: "About" });
    await expect(about.getByRole("button", { name: "This page" })).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Recent chats" }).click();
    await panel.getByTestId("ask-recent-row").filter({ hasText: "Home ·" }).first().click();
    await expect(about.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(about.getByRole("button", { name: "This page" })).toHaveCount(0);
    // A new chat is about this page again.
    await panel.getByRole("button", { name: "New chat" }).click();
    await expect(about.getByRole("button", { name: "This page" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Roadmap");
  });

  test("qa-simple-home-20: closing the panel gives focus back to Ask Oracle", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple");
    const panel = await openAsk(page);
    await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toBeFocused();
    await panel.getByRole("button", { name: "Close Ask Oracle" }).click();
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName)).toBe("simple-ask");
    // Escape closes it the same way.
    await openAsk(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
    await expect(page.getByTestId("simple-ask").filter({ visible: true }).first()).toBeFocused();
  });

  test("qa-simple-home-21: the panel starts closed on a new visit and for the next person signing in", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple");
    await openAsk(page);
    await page.reload();
    await expect(page.getByTestId("home-greeting")).toBeVisible();
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
    await openAsk(page);
    await signOut(page);
    await page.getByLabel("Email").fill(VIEWER);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("simple-ask").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
  });

  test("qa-simple-home-22: one wording, naming the page or the document", async ({ page }) => {
    await signIn(page, ADMIN.email, "/simple/roadmap");
    let panel = await openAsk(page);
    const box = panel.getByRole("textbox", { name: "Message Oracle" });
    await expect(box).toHaveAttribute("placeholder", "Ask about the roadmap, or ask for a change…");
    await expect(panel.getByTestId("hop-empty")).toHaveText("Nothing yetAsk about the roadmap, or ask for a change.");
    await panel.getByRole("button", { name: "Close Ask Oracle" }).click();

    await page.goto("/simple/prds/guided-setup");
    const h1 = page.getByRole("main").getByRole("heading", { level: 1 }).filter({ visible: true }).first();
    await expect(h1).not.toHaveText("One-pager");
    const title = (await h1.textContent())!.trim();
    panel = await openAsk(page);
    await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", `Ask about ${title}, or ask for a change…`);
    await expect(panel.getByTestId("hop-empty")).toHaveText(`Nothing yetAsk about ${title}, or ask for a change.`);
    await expect(panel.getByTestId("ask-about")).toHaveText(`New chat about ${title}`);
    await expect(panel.getByText("One-pager", { exact: false })).toHaveCount(0);
  });

  test("qa-simple-home-23: a viewer reads a plain hint about asking for comment access", async ({ page }) => {
    await signIn(page, VIEWER, "/simple");
    const panel = await openAsk(page);
    await expect(panel.getByTestId("chat-hint")).toHaveText("You can ask questions. To suggest a change, ask an owner for comment access.");
    await expect(panel.getByText(/commenter or above/)).toHaveCount(0);
    await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask about Home…");
  });
});

test.describe("simple-home", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-home"), MOCK_SCENARIO_KEY);
  });

  test("qa-simple-home-6: on a 1440 px window the open panel sits beside Home, which narrows; a phone-sized window keeps it over the page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, APPROVER, "/simple");
    await expect(page.getByTestId("home-greeting")).toBeVisible();
    const panel = await openAsk(page);
    const left = (await panel.boundingBox())!.x;
    expect(left).toBeLessThan(1440);
    const walk = page.getByRole("button", { name: "Walk me through it" });
    const decide = page.getByTestId("home-decision").first().getByRole("button", { name: /^Decide/ }).first();
    for (const b of [walk, decide]) {
      await b.scrollIntoViewIfNeeded();
      await expect(b).toBeVisible();
      const r = (await b.boundingBox())!;
      expect(r.x + r.width).toBeLessThanOrEqual(left);
      // Nothing of the panel over it: a click there reaches the button.
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid=hop-panel]") === null, [r.x + r.width - 2, r.y + r.height / 2]);
      expect(hit).toBe(true);
    }
    // No sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

    // A narrower window keeps the panel over the page.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.getByTestId("simple-ask-room")).toBeHidden();
    const main = (await page.locator("main").boundingBox())!;
    expect(main.x + main.width).toBeGreaterThan((await panel.boundingBox())!.x);
  });
});
