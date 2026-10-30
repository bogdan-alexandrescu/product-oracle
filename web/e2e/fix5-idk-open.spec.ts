import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * fix5-idk-open (owner 2026-10-29, qa-work-2 "Open"): on a brief, a question answered "I don't
 * know" still counts as open until someone gives a real answer. Driven through the UI on the
 * mock: a new company's first brief, its questions asked of the author.
 */

const PHONE = { width: 390, height: 844 };

async function newBrief(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix5-idk-open")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix5-idk-open", "1");
      }
      localStorage.setItem(key, value);
      localStorage.setItem("po-interview-follow-up", "off");
    },
    [MOCK_SCENARIO_KEY, "empty"],
  );
  await login(page);
  await page.goto("/documents/new?kind=prd");
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype their address at every checkout.");
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  const thread = page.getByTestId("intake-thread");
  await expect(thread.getByTestId("question").first()).toBeVisible();
  const asked = await thread.getByTestId("question").count();
  expect(asked).toBeGreaterThan(1);
  return asked;
}

const question = (page: Page, n: number) => page.getByTestId("intake-thread").getByTestId("question").nth(n);

async function reply(page: Page, n: number, how: "real" | "unsure", button = "Answer") {
  const q = question(page, n);
  await q.getByRole("button", { name: button, exact: true }).click();
  const form = q.getByTestId("answer-question");
  if (how === "real") {
    await form.getByRole("textbox", { name: "Your answer" }).fill("Signed-in buyers on the web shop");
    await form.getByRole("button", { name: "Send answer" }).click();
  } else {
    await form.getByRole("button", { name: "I don't know" }).click();
  }
  await expect(form).toHaveCount(0);
}

for (const size of [null, PHONE] as const) {
  test(`an I don't know answer leaves its question open; a real answer closes it${size ? " (phone)" : ""}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    const asked = await newBrief(page);
    const counts = async (open: number, answered: number) => {
      if (size) {
        await expect(page.getByTestId("intake-readiness-counts")).toHaveText(new RegExp(`^${open} open · ${answered} answered · `));
      } else {
        const inspector = page.getByTestId("intake-inspector").filter({ visible: true });
        await expect(inspector.getByTestId("stat-open")).toContainText(String(open));
        await expect(inspector.getByTestId("stat-answered")).toContainText(String(answered));
      }
    };
    await counts(asked, 0);

    // "I don't know": the answer shows, the question still counts open.
    await reply(page, 0, "unsure");
    await expect(question(page, 0).getByTestId("answer")).toContainText("I don't know");
    await counts(asked, 0);
    await expect(page.getByTestId("intake-status")).toHaveText("Waiting for answers");

    // A real answer on another question closes that one.
    await reply(page, 1, "real");
    await counts(asked - 1, 1);

    // A real answer after the "I don't know" closes it too; the "I don't know" stays shown.
    await reply(page, 0, "real", "Change answer");
    await counts(asked - 2, 2);
    await expect(question(page, 0).getByTestId("answer")).toHaveCount(2);
    await expect(question(page, 0).getByTestId("answer").first()).toContainText("I don't know");
  });
}

test("the I don't know note says the question is still open (phone)", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await newBrief(page);
  await reply(page, 0, "unsure");
  await expect(page.getByTestId("intake-readiness")).toContainText("1 still open after “I don't know”");
  await expect(page.getByTestId("intake-readiness")).not.toContainText("answered “I don't know”");
});

for (const size of [null, PHONE] as const) {
  test(`after your own I don't know, the question offers a real answer but not I don't know again${size ? " (phone)" : ""}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    await newBrief(page);
    await reply(page, 0, "unsure");
    await question(page, 0).getByRole("button", { name: "Change answer", exact: true }).click();
    const form = question(page, 0).getByTestId("answer-question");
    await expect(form.getByRole("button", { name: "Send answer" })).toBeVisible();
    await expect(form.getByRole("button", { name: "I don't know" })).toHaveCount(0);
    // Another question still offers it.
    await form.getByRole("button", { name: "Cancel" }).click();
    await question(page, 1).getByRole("button", { name: "Answer", exact: true }).click();
    await expect(question(page, 1).getByTestId("answer-question").getByRole("button", { name: "I don't know" })).toBeVisible();
  });
}
