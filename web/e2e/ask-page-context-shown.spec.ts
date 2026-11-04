import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * ask-page-context review: a page without a provider of its own sends its shown text, and a
 * table there used to come as its cells' text in the page's layout (a row on one line on a
 * desktop, a cell a line on a phone, no column names). It now sends each row as one line of
 * its columns' names and values, the same on both. protects=on PRDs, "This page" sends
 * "Document: <title> · Status: <status>" for a listed row, desktop and phone, and the reply
 * (the mock reads the view, as the API's context does) names the listed documents;
 * fails_when=the rows come without their columns' names, or the reply has none of what the
 * page lists; no_claim=Oracle's wording.
 */

const QUESTION = "Which of the documents listed here are still drafts?";

async function firstRow(page: Page) {
  await login(page);
  await page.goto("/documents");
  const row = page.getByTestId("document-row").first();
  await expect(row).toBeVisible();
  const title = (await row.locator("td").first().innerText()).split("\n")[0].trim();
  expect(title).not.toBe("");
  return title;
}

async function askThisPage(page: Page, panel: Locator, title: string) {
  await expect(panel.getByRole("button", { name: "This page" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("hop-about")).toHaveText("New chat about PRDs");
  await panel.getByRole("textbox", { name: "Ask Oracle" }).fill(QUESTION);
  const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname.endsWith("/v1/discussions"));
  await panel.getByRole("button", { name: "Send" }).click();
  const lines: string[] = (await sent).postDataJSON().subject.view.lines;
  const line = lines.find((l) => l.startsWith(`Document: ${title} · `));
  expect(line, lines.join("\n")).toBeTruthy();
  expect(line).toMatch(/ · Status: \S/);
  const thread = panel.getByTestId("discussion-thread");
  await expect(thread).toContainText(`On PRDs I can see ${title}`, { timeout: 15_000 });
  await expect(thread).not.toContainText("Document:");
}

test("desktop: This page on PRDs sends each listed row with its columns and answers with them", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 820 });
  const title = await firstRow(page);
  await page.getByTestId("hop-strip").click();
  await askThisPage(page, page.getByTestId("hop-panel").filter({ visible: true }), title);
});

test("phone: This page on PRDs sends each listed row with its columns and answers with them", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = await firstRow(page);
  await page.getByTestId("phone-ask").click();
  const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
  await expect(sheet).toBeVisible();
  await askThisPage(page, sheet, title);
});
