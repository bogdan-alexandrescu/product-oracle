import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * ask-reply-rail-reads (simple-call-budget): an Ask reply drops the shared reads (lib/api/shared-reads) only
 * when it changed something (its `changes` event), so the rail's counts read while the reply was written are
 * not read again after a reply that changes nothing; a reply that proposes a change still has them read again.
 * Oracle's reply is held 2.5 s (the mock's slow reads) so the rail reads its counts, on a move to Roadmap,
 * while the reply is on its way; the move to Priorities after it comes within the rail's 10 s.
 *
 * fails_when = after a reply that changes nothing, moving to Priorities reads the rail's counts again; or after
 * a reply that proposes a decision, it does not.
 */

const RAIL = ["GET /v1/simple/decisions/waiting", "GET /v1/simple/roadmap/waiting", "GET /v1/inbox/counts", "GET /v1/inbox/questions"];

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

async function railReadsAfterReply(page: Page, question: string): Promise<string[]> {
  await page.context().addInitScript(
    ([slowKey, msKey]) => {
      localStorage.setItem(slowKey, "/v1/discussions/*");
      localStorage.setItem(msKey, "2500");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
  );
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(question);
  await panel.getByRole("button", { name: "Send" }).click();

  // While the reply is on its way: a move to Roadmap, and the rail reads its counts.
  await expect.poll(async () => (await calls(page)).some((c) => c.endsWith("/stream")), { timeout: 15_000 }).toBe(true);
  const asked = (await calls(page)).length;
  await page.getByTestId("simple-nav-roadmap").first().click();
  await expect.poll(async () => (await calls(page)).slice(asked).filter((c) => RAIL.includes(c)).length).toBe(RAIL.length);

  const reply = panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
  await expect(reply).toHaveAttribute("data-status", "complete");
  const answered = (await calls(page)).length;
  await page.getByTestId("simple-nav-priorities").first().click();
  await expect(page).toHaveURL((u) => u.pathname === "/simple/priorities");
  await expect.poll(async () => (await calls(page)).slice(answered).some((c) => c.startsWith("GET /v1/simple/priorities"))).toBe(true);
  await page.waitForTimeout(1500);
  return (await calls(page)).slice(answered).filter((c) => RAIL.includes(c));
}

test("a reply that changes nothing leaves the rail's counts as read", async ({ page }) => {
  expect(await railReadsAfterReply(page, "what is Weekly alert digest about?")).toEqual([]);
});

test("a reply that proposes a change has the rail's counts read again", async ({ page }) => {
  expect(await railReadsAfterReply(page, "should we record a decision to ship Weekly alert digest first?")).toContain("GET /v1/simple/decisions/waiting");
});
