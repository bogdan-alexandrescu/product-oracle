import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * ask-reply-discussion-read (lib/stream openStream): when Oracle's reply in Ask is done, the shared reads of its
 * discussion are dropped, so the chat's read of the discussion after it (SimpleAsk's loadAsk, on the reply's end)
 * fetches the messages again and shows the reply as complete. The mock writes its reply in about 1.2 s, under the
 * 2 s a read's answer is shared, so the read before the reply (the reply still pending) would otherwise be taken.
 *
 * fails_when = openStream no longer drops its discussion's shared reads when the reply is done: the chat keeps
 * the answer read before the reply, its reply never shows as complete and its messages are not fetched again.
 */

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

test("a reply done in Ask has the chat read its discussion again and show the reply", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill("what is Weekly alert digest about?");
  await panel.getByRole("button", { name: "Send" }).click();

  // The reply's stream, and the discussion it is in.
  await expect.poll(async () => (await calls(page)).findIndex((c) => c.endsWith("/stream")), { timeout: 15_000 }).toBeGreaterThan(-1);
  const all = await calls(page);
  const streamed = all.findIndex((c) => c.endsWith("/stream"));
  const discussion = /^GET (\/v1\/discussions\/[^/]+)\/messages\/[^/]+\/stream$/.exec(all[streamed])![1];
  const messages = `GET ${discussion}/messages?limit=200`;
  expect(all.slice(0, streamed)).toContain(messages);

  const reply = panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
  await expect(reply).toHaveAttribute("data-status", "complete");
  await expect(reply).toContainText("Weekly alert digest");
  expect((await calls(page)).slice(streamed + 1)).toContain(messages);
});
