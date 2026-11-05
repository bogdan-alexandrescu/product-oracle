import { expect, test, type Locator, type Page } from "./test";

import { answerWords, noRawTokens } from "../lib/raw-tokens";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * chat-citations: Simple > Ask Oracle, General. Asked for the focus areas with their baseline
 * features, General answers from the baseline (the API's context holds the features with
 * their status and goals; api/tests/test_hop_panel.py) and draws every citation as a footnote:
 * a context citation `[c:n]` as a raised link, a meeting-notes read `[l:n]` as a raised
 * number after them, each set apart from the word before it; any other token ("[c:c4]",
 * "[s:12]") is never shown. The "simple-chat" mock scenario; desktop (1366x820) and phone (390x844).
 *
 * Card: protects=General's answer shows no raw citation token and its footnotes are separate
 * raised links, not run into the word; fails_when="[l:" or "[s:" or "[c:" shows, or a footnote
 * touches the word or the footnote before it; no_claim=the real model's wording.
 */

const QUESTION = "What are our focus areas, with their Ground Truth features?";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

test("the sanitizer takes out every raw token and keeps the footnotes", () => {
  expect(noRawTokens("Meetings say so [l:2].")).toBe("Meetings say so.");
  expect(noRawTokens("Still unknown [c:c4] here")).toBe("Still unknown here");
  expect(noRawTokens("Three areas [s:12], two goals")).toBe("Three areas, two goals");
  expect(noRawTokens("Kept [c:3] and [c:l.1]; a [link](/simple) too")).toBe("Kept [c:3] and [c:l.1]; a [link](/simple) too");
});

test("code keeps its words as written; a token still being written never shows", () => {
  // chat-citations review: only the answer's words lose their raw tokens, not code in it.
  expect(answerWords("Search for `[s:1]` in the notes [s:2].")).toBe("Search for `[s:1]` in the notes.");
  expect(answerWords("Run:\n```\nfind [id:42]\n```\nDone [l:1].")).toBe("Run:\n```\nfind [id:42]\n```\nDone [c:l.1].");
  // While the answer streams, a half-written token of any kind is held back until it is whole.
  expect(answerWords("Three areas [s:1", true)).toBe("Three areas ");
  expect(answerWords("Read so far [c:l.", true)).toBe("Read so far ");
  expect(answerWords("Read so far [l:", true)).toBe("Read so far ");
  expect(answerWords("Three areas [s:1", false)).toBe("Three areas [s:1");
});

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`A General answer draws its citations as footnotes, never raw tokens (${where})`, async ({ page }) => {
      await signIn(page, "/simple");
      await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
      const panel = page.getByTestId("hop-panel").filter({ visible: true });
      await expect(panel.getByTestId("ask-chat")).toBeVisible();
      await tap(panel.getByRole("button", { name: "General", exact: true }));
      await panel.getByRole("textbox", { name: "Message Oracle" }).fill(QUESTION);
      await tap(panel.getByRole("button", { name: "Send" }));

      const reply = panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
      await expect(reply).toHaveAttribute("data-status", "complete");
      await expect(reply.getByTestId("answer-title")).toHaveText("Focus areas");
      const body = reply.getByTestId("chat-message-body");
      await expect(body).toContainText("The last planning call named the same three");
      await expect(body).toContainText("(confirmed)");
      for (const raw of ["[l:", "[c:", "[s:", "c4]"]) await expect(body).not.toContainText(raw);

      // Context citations are raised links to the baseline; the read is a raised number after them.
      const links = body.locator('sup a[data-testid="answer-cite"]');
      expect(await links.count()).toBeGreaterThan(2);
      await expect(links.first()).toHaveAttribute("href", /^\/ground-truth#/);
      const read = body.locator('sup span[data-testid="answer-cite"]');
      await expect(read).toHaveCount(1);
      await expect(read).toHaveAttribute("aria-label", /^Source \d+: Meeting notes · read /);
      const last = Number(await links.last().getAttribute("data-n"));
      expect(Number(await read.getAttribute("data-n"))).toBeGreaterThan(last);

      // "unknown¹" with a gap, not "unknown1": the footnote sits apart from the word before it.
      const line = body.locator("p").filter({ hasText: "still unknown" });
      const sup = line.locator("sup").first();
      const gap = await sup.evaluate((el) => {
        const r = document.createRange();
        const word = el.previousSibling!;
        r.setStart(word, (word.textContent ?? "").length - 1);
        r.setEnd(word, (word.textContent ?? "").length);
        return el.getBoundingClientRect().left - r.getBoundingClientRect().right;
      });
      expect(gap).toBeGreaterThanOrEqual(2);
    });
  });
}
