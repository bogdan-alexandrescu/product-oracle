import { expect, test, type Page } from "./test";

import { V2_IDS } from "../lib/api/mock/v2";

import { fakeGoogle } from "./google-fake";
import { login } from "./helpers";

/*
 * The ad-fix-detailed review's minors, driven through the UI on the mock: a long Drive list
 * on a source row collapses to "and N more" as Slack and GitHub lists do (PICKS_SHOWN), and an
 * "I don't know" question's Change answer sits after its answers (qa-work-28), not in its card.
 */

const PHONE = { width: 390, height: 844 };
const DOCS = Array.from({ length: 7 }, (_, i) => ({ id: `1DocLongListExample${i + 1}`, name: `Doc ${i + 1}` }));
const UNSURE = "Which metric shows repeat checkout got faster?";

async function addDriveSource(page: Page) {
  await fakeGoogle(page, DOCS);
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByLabel("Name").fill("Long Drive list");
  await form.getByRole("button", { name: "Choose from Drive" }).click();
  await expect(form.getByRole("list", { name: "Picked files and folders" }).getByRole("listitem")).toHaveCount(7);
  await form.getByRole("button", { name: "Add source" }).click();
  return page.getByRole("listitem", { name: "Long Drive list" });
}

for (const size of [null, PHONE] as const) {
  const tag = size ? " (phone)" : "";

  test(`a long Drive list on a source row reads its first five names and "and N more"${tag}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    const row = await addDriveSource(page);
    await expect(row.getByTestId("source-picks")).toHaveText("Doc 1, Doc 2, Doc 3, Doc 4, Doc 5 and 2 more");
    // The title still names every file.
    await expect(row.getByTestId("source-picks")).toHaveAttribute("title", DOCS.map((d) => d.name).join(", "));
  });

  test(`qa-work-28: an I don't know question's Change answer sits after its answers${tag}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    await page.addInitScript(() => localStorage.setItem("po-interview-follow-up", "off"));
    await login(page);
    await page.goto(`/intakes/${V2_IDS.intake}`);
    const q = page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: UNSURE });
    const change = q.getByRole("button", { name: "Change answer" });
    await expect(change).toBeVisible();
    // Not in the question's card: below the "I don't know" bubble.
    await expect(q.getByRole("article", { name: UNSURE }).getByRole("button", { name: "Change answer" })).toHaveCount(0);
    const answer = (await q.getByTestId("answer").last().boundingBox())!;
    const button = (await change.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(answer.y + answer.height);
  });
}
