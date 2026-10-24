import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// #254: a PRD whose sections still hold only the template's text is never published (approved)
// nor built into a roadmap; Publish names how many sections are not reviewed before it asks.

async function newPrd(page: Page, title: string) {
  await login(page);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page.getByTestId("recommended-template")).toBeVisible();
  const box = page.getByRole("textbox", { name: "Title" });
  await box.fill(title);
  await expect(box).toHaveValue(title);
  await page.getByRole("button", { name: "Start from an empty skeleton instead" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

/** Stamps an approval as one given before Approve refused template-only versions. */
async function approvedBeforeTheFix(page: Page, slug: string) {
  await page.evaluate((s) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === s);
    const v = db.versions.find((x: { document_id: string; number: number }) => x.document_id === doc.id && x.number === 1);
    v.approved_at = new Date().toISOString();
    doc.status = "approved";
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, slug);
}

test("a template-only PRD: Publish names every section unreviewed, then refuses: nothing is written yet", async ({ page }) => {
  await newPrd(page, "Lantern trial PRD");
  await page.goto("/documents/lantern-trial-prd/publish");
  const publish = page.getByTestId("publish-button");
  await expect(publish).toBeEnabled();
  await publish.click();
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  const unreviewed = dialog.getByTestId("unreviewed-sections");
  await expect(unreviewed).toHaveText(/^(\d+) of \1 sections are not reviewed$/);

  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  const refusal = dialog.getByTestId("publish-refusal");
  await expect(refusal).toContainText("Nothing is written yet");
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(publish).toHaveText("Publish v1");
});

test("a PRD with a few sections reviewed: Publish names how many are not", async ({ page }) => {
  await login(page);
  await page.goto("/documents/visit-reminders/v/1");
  const total = await page.getByTestId("stat-reviewed").innerText();
  const [reviewed, all] = total.match(/(\d+)\s*\/\s*(\d+)/)!.slice(1).map(Number);
  await page.goto("/documents/visit-reminders/publish");
  await page.getByTestId("publish-button").click();
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  expect(reviewed).toBeLessThan(all);
  await expect(dialog.getByTestId("unreviewed-sections")).toHaveText(`${all - reviewed} of ${all} sections ${all - reviewed === 1 ? "is" : "are"} not reviewed`);
});

test("Build roadmap refuses a template-only PRD approved before the refusal", async ({ page }) => {
  await newPrd(page, "Lantern trial PRD");
  await approvedBeforeTheFix(page, "lantern-trial-prd");
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Lantern trial PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog).toContainText("Nothing is written yet");
  await expect(dialog.getByRole("button", { name: "Start run" })).toBeDisabled();
});
