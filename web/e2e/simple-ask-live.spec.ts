import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { disconnectAll, login } from "./helpers";

/*
 * Simple Ask live (#710 in Simple): a question in Simple's Ask Oracle panel (General) reads
 * the asker's own Fireflies connection at the moment they ask, as Ask's discussions do. The
 * mock's Fireflies connection answers a total of 4,321 meetings (invented); the reply carries
 * the read as the live chip "<source> · <call> · read <time>", in the Company time zone.
 *
 * Card simple-ask-live: protects=a Simple Ask panel question from a person with a Fireflies
 * connection is answered from a live read, with its live chip and no raw "[l:1]";
 * fails_when=the reply answers from stored data, shows no chip, or shows a raw token;
 * no_claim=the API's tokens, budget and audience rule (api/tests/test_simple_ask_live.py).
 */

const LABEL = "Fireflies Archive";
const QUESTION = "How many Fireflies meetings can you read right now?";
// MOCK_NOW is 12:00 UTC, 5:00 AM in the Company time zone (America/Los_Angeles, PDT); the clock runs on.
const READ_AT = /read 5:\d\d AM PDT/;

/** Connects Fireflies in Settings > Connections with a key and a label (the seeded account disconnected first). */
async function connectFireflies(page: Page) {
  await page.goto("/settings/connections");
  await disconnectAll(page, "fireflies");
  const card = page.getByTestId("connection-card-fireflies");
  await card.getByRole("button", { name: "Paste a token" }).click();
  await card.getByLabel("Token", { exact: true }).fill("ff-example-key-1234");
  await card.getByLabel("Label (optional)").fill(LABEL);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card).toContainText(LABEL);
}

async function openAsk(page: Page): Promise<Locator> {
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("Simple's Ask Oracle reads Fireflies live and shows the live chip on its reply", async ({ page }) => {
  await login(page);
  await connectFireflies(page);
  await page.goto("/simple");
  const panel = await openAsk(page);
  await panel.getByRole("group", { name: "About" }).getByRole("button", { name: "General", exact: true }).click();
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(QUESTION);
  await panel.getByRole("button", { name: "Send" }).click();

  const reply = panel.locator('[data-testid="chat-message"][data-author="oracle"]').last();
  await expect(reply.getByTestId("chat-message-body")).toContainText("4,321");
  await expect(reply.getByTestId("chat-message-body")).not.toContainText("[l:");
  const chip = reply.getByTestId("live-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText(`${LABEL} · list_meetings · `);
  await expect(chip).toContainText(READ_AT);
  await expect(chip.locator("a")).toHaveCount(0);
});
