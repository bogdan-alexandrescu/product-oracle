import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, sectionAction } from "./helpers";

/*
 * #406 through the UI, on the mock layer ("discussion-replies" scenario): in a discussion on
 * checkout-redesign v2's Problem, the commenter asks about a fact stated only in another
 * section (Success metrics: when the experiment stops early). The mock reads the version's
 * text as the API does (the section first, then the rest) and streams an answer quoting it,
 * its citation marker split across two pieces.
 *
 * Card (E2E): protects=the streamed reply cites the document, and no raw `[c:` marker is
 * ever on screen while it streams; fails_when=Oracle answers without the document or a
 * marker shows mid-stream; no_claim=the real model (the API's context is covered by
 * api/tests/test_discussion_document_context.py).
 */

const DOC = "/documents/checkout-redesign/v/2";
const COMMENTER = "commenter@example.com";
const QUESTION = "When does the experiment stop early?";

const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const reply = (page: Page) => thread(page).getByTestId("oracle-reply").last();

test("asked about the document, Oracle's streamed reply cites it and never shows a raw marker", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "discussion-replies"), MOCK_SCENARIO_KEY);
  await login(page, COMMENTER);
  await page.goto(DOC);
  const s = await openSection(page, "problem");
  await sectionAction(s, "2. Problem", "Discuss this section");
  await page.getByTestId("start-discussion").filter({ visible: true }).getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page)).toBeVisible();
  await thread(page).getByRole("textbox", { name: "Message" }).fill(QUESTION);
  await thread(page).getByRole("button", { name: "Send" }).click();

  // What a reader sees at each paint, sampled until the reply ends.
  const seen: { status: string | null; text: string; chip: boolean }[] = [];
  await expect
    .poll(
      async () => {
        const sample = await reply(page).evaluate((el) => ({
          status: el.getAttribute("data-status"),
          text: el.querySelector('[data-testid="oracle-reply-text"]')?.textContent ?? "",
          chip: !!el.querySelector('[data-testid^="cite-"]'),
        }));
        seen.push(sample);
        return sample.status;
      },
      { intervals: [20], timeout: 10_000 },
    )
    .toBe("complete");

  const streaming = seen.filter((x) => x.status === "streaming" && x.text);
  expect(streaming.length).toBeGreaterThan(1);
  expect(seen.filter((x) => /\[c(:|$)|\[$/.test(x.text))).toEqual([]);
  // The chip comes while it still streams, not only at the end.
  expect(streaming.some((x) => x.chip)).toBe(true);

  await expect(reply(page).getByTestId("oracle-reply-text")).toContainText("refund-rate guardrail is breached for two consecutive weeks");
  const chip = reply(page).getByRole("button", { name: /^Citation \d+: .*Success metrics/ });
  await expect(chip).toBeVisible();
});
