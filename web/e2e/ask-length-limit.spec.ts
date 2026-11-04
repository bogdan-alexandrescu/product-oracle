import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * ask-length-limit: Ask Oracle on a PRD's one-pager takes a long change request (up to 4,000
 * characters; 1,622 was refused with "Something went wrong"), shows a quiet count once a
 * message passes 3,000, and a longer one is refused in words with the limit, the text kept.
 * On a desktop window and on a phone.
 */

const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

const LINE = "Move Weekly alert digest to next quarter and tell the owners why it slipped. ";
const words = (n: number) => LINE.repeat(Math.ceil(n / LINE.length)).slice(0, n);

async function openAsk(page: Page, phone: boolean): Promise<Locator> {
  // A phone opens Ask Oracle from its tab bar; a desktop from the header.
  await page.getByTestId(phone ? "phone-ask" : "simple-ask").click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

for (const size of SIZES) {
  test.describe(`ask-length-limit on ${size.name}`, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      await page.setViewportSize({ width: size.width, height: size.height });
      await login(page);
      await page.goto("/simple/one-pagers/guided-setup");
    });

    test("a 1,622-character change request is sent, with no count under 3,000", async ({ page }) => {
      const panel = await openAsk(page, size.name === "phone");
      const box = panel.getByRole("textbox", { name: "Message Oracle" });
      const text = words(1622);
      await box.fill(text);
      await expect(panel.getByTestId("chat-count")).toHaveCount(0);
      await panel.getByRole("button", { name: "Send" }).click();
      await expect(panel.locator('[data-testid="chat-message"][data-author="person"]')).toHaveCount(1);
      await expect(panel.locator('[data-testid="chat-message"][data-author="oracle"]').first()).toBeVisible();
      await expect(panel.getByText("Something went wrong")).toHaveCount(0);
      await expect(box).toHaveValue("");
    });

    test("past 3,000 characters a quiet count shows; past 4,000 Send says so with the limit and keeps the text", async ({ page }) => {
      const panel = await openAsk(page, size.name === "phone");
      const box = panel.getByRole("textbox", { name: "Message Oracle" });
      await box.fill(words(3000));
      await expect(panel.getByTestId("chat-count")).toHaveCount(0);
      await box.fill(words(3210));
      const count = panel.getByTestId("chat-count");
      await expect(count).toHaveText("3,210 of 4,000 characters");
      await expect(count).toBeInViewport();

      const long = words(4050);
      await box.fill(long);
      await expect(count).toHaveText("4,050 of 4,000 characters");
      await panel.getByRole("button", { name: "Send" }).click();
      await expect(panel.getByRole("alert")).toHaveText("This message is 4,050 characters; Oracle takes up to 4,000. Shorten it and send again.");
      await expect(box).toHaveValue(long);
      await expect(panel.locator('[data-testid="chat-message"][data-author="person"]')).toHaveCount(0);

      // Shortened to the limit, it goes.
      await box.fill(words(4000));
      await expect(panel.getByRole("alert")).toHaveCount(0);
      await panel.getByRole("button", { name: "Send" }).click();
      await expect(panel.locator('[data-testid="chat-message"][data-author="person"]')).toHaveCount(1);
      await expect(box).toHaveValue("");
    });

    test("a change Oracle cannot make yet is said so, with where to make it, not 'did not understand'", async ({ page }) => {
      const panel = await openAsk(page, size.name === "phone");
      await panel.getByRole("textbox", { name: "Message Oracle" }).fill("cut Weekly alert digest; raise our capacity to 12 engineer-weeks; make it nicer");
      await panel.getByRole("button", { name: "Send" }).click();
      const reply = panel.locator('[data-testid="chat-message"][data-author="oracle"]').last();
      await expect(reply.getByTestId("chat-message-body")).toContainText("I can't change capacity from a chat yet (“raise our capacity to 12 engineer-weeks”); change it on Priorities.");
      await expect(reply.getByTestId("chat-message-body")).toContainText("I did not understand: “make it nicer”.");
      await expect(reply.getByTestId("chat-message-body")).not.toContainText("I did not understand: “raise");
      const link = reply.getByRole("link", { name: "Change it on Priorities" });
      await expect(link).toHaveAttribute("href", "/simple/priorities");
      await link.click();
      await expect(page).toHaveURL(/\/simple\/priorities$/);
    });
  });
}
