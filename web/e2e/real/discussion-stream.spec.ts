import { createServer, type Server } from "node:http";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { openSection } from "../helpers";
import { FAKE_CLAUDE_PORT, oracle, stackState } from "./stack";

/*
 * G2 Live replies on the real stack (criterion 14): the company has only a fallback API key,
 * set by the owner on Settings > Claude accounts, and the API's ORACLE_ANTHROPIC_API_URL
 * (playwright.real.config.ts) points at the fake Messages API this spec starts. It streams
 * 5 text deltas 300 ms apart.
 *
 * Card (E2E real): protects=the reply's first delta reaches the page before done, through
 * Next's /v1 proxy; fails_when=the proxy buffers the stream so the text shows only at the
 * end; no_claim=the real Claude API (a fake one answers), the reply rules (pytest).
 */
const DOC = "e2e-discussion";
const KEY = "sk-ant-api03-e2e-fake-key";
const DELTAS = ["Returning buyers ", "abandon at ", "the shipping step, ", "so one page ", "should help."];
const ANSWER = DELTAS.join("");

let server: Server;
const asked: { key: string | undefined; stream: boolean }[] = [];

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      asked.push({ key: req.headers["x-api-key"] as string | undefined, stream: JSON.parse(body || "{}").stream === true });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(sse("message_start", { message: { model: "claude-fake", usage: { input_tokens: 100, output_tokens: 1 } } }));
      res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      for (const text of DELTAS) {
        await new Promise((r) => setTimeout(r, 300));
        res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
      }
      res.write(sse("content_block_stop", { index: 0 }));
      res.write(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }));
      res.end(sse("message_stop", {}));
    });
  });
  await new Promise<void>((r) => server.listen(FAKE_CLAUDE_PORT, "127.0.0.1", r));
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function login(page: Page) {
  const { email, password } = stackState();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("Oracle's reply streams onto the page through Next's proxy before it is done", async ({ page }) => {
  expect(await oracle("push", path.join(__dirname, "fixtures", "discussion_draft.md"))).toContain(`Imported ${DOC} version 1`);
  await login(page);

  // The owner gives the company its only Claude credential: a fallback API key.
  await page.goto("/settings/claude-accounts");
  const fallback = page.getByRole("group", { name: "Fallback credential" });
  await fallback.getByRole("button", { name: "Set a fallback" }).click();
  const form = page.getByRole("form", { name: "Set the fallback credential" });
  await form.getByLabel("Setup-token or API key").fill(KEY);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("fallback-status")).not.toContainText("None set.");

  // Alone in a discussion on Problem, the owner asks; Oracle replies as it writes.
  await page.goto(`/documents/${DOC}/v/1`);
  const problem = await openSection(page, "problem");
  await problem.getByRole("button", { name: /^Actions for .*Problem$/ }).click();
  await problem.getByRole("menuitem", { name: "Discuss this section" }).click();
  await page.getByTestId("start-discussion").filter({ visible: true }).getByRole("button", { name: "Start discussion" }).click();
  const thread = page.getByTestId("discussion-thread").filter({ visible: true });
  await expect(thread).toBeVisible();
  await thread.getByRole("textbox", { name: "Message" }).fill("Why do returning buyers leave?");
  await thread.getByRole("button", { name: "Send" }).click();

  const reply = thread.getByTestId("oracle-reply").last();
  const text = reply.getByTestId("oracle-reply-text");
  const length = async () => ((await text.textContent()) ?? "").replace("Oracle is thinking…", "").length;
  await expect.poll(length, { intervals: [25], timeout: 20_000 }).toBeGreaterThan(0);
  const early = await length();
  // The first delta is on the page while the reply still streams (the rest is >= 1.2 s away).
  await expect(reply).toHaveAttribute("data-status", "streaming");
  expect(early).toBeLessThan(ANSWER.length);
  await expect.poll(length, { intervals: [25] }).toBeGreaterThan(early);
  await expect(reply).toHaveAttribute("data-status", "complete");
  await expect(text).toHaveText(ANSWER);
  expect(asked).toEqual([{ key: KEY, stream: true }]);
});
