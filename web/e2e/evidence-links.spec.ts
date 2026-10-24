import { expect, test, type Page } from "./test";

import { login, openSection, sectionAction } from "./helpers";

const NOTION = "https://examplecorp.notion.site/Onboarding-research-summary-8c8f4dca142f44198555e626ba58742d";

async function openDrawer(page: Page, email: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  const d = page.getByRole("dialog", { name: "Guided setup" });
  await expect(d.getByTestId("evidence-chip")).toHaveCount(3);
  return d;
}

test("evidence links: a commenter previews a public Notion page, saves and refreshes it", async ({ page }) => {
  const d = await openDrawer(page, "commenter@example.com");
  // Commenters cannot edit the item, but they can add evidence from a public link.
  await expect(d.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await d.getByRole("button", { name: "Add evidence link" }).click();

  const form = d.getByRole("form", { name: "Add evidence link" });
  await form.getByLabel("Public link").fill(NOTION);
  await form.getByLabel("Note (optional)").fill("Interview data from September");
  await form.getByRole("button", { name: "Preview" }).click();

  // Before saving: the page's title, excerpt and confidence.
  const preview = form.getByTestId("link-preview");
  await expect(preview.getByTestId("link-preview-title")).toHaveText("Onboarding research summary");
  await expect(preview.getByTestId("link-preview-excerpt")).toContainText("We interviewed 24 new accounts");
  await expect(preview).toContainText("Notion");
  await expect(preview.getByTestId("confidence")).toHaveText(/^0\.\d\d$/);
  await expect(preview.getByTestId("link-preview-factors")).toContainText("Source 0.70");

  await form.getByRole("button", { name: "Save evidence" }).click();
  await expect(d.getByRole("status")).toContainText("Saved “Onboarding research summary” as evidence");
  await expect(d.getByTestId("evidence-chip")).toHaveCount(4);

  const row = d.getByTestId("evidence-row").filter({ hasText: "Onboarding research summary" });
  await row.getByTestId("evidence-chip").hover();
  const card = row.getByRole("tooltip");
  await expect(card).toContainText("Public link, visible to everyone");
  await expect(card).toContainText("Note: Interview data from September");
  await expect(card.getByRole("table", { name: "Confidence factors" })).toBeVisible();

  await row.getByRole("button", { name: "Refresh Onboarding research summary" }).click();
  await expect(d.getByRole("status").filter({ hasText: "Fetched" })).toHaveText(
    "Fetched “Onboarding research summary” again and rescored it.",
  );

  // The same link again: the preview says so and offers no save.
  await d.getByRole("button", { name: "Add evidence link" }).click();
  await form.getByLabel("Public link").fill(NOTION);
  await form.getByRole("button", { name: "Preview" }).click();
  await expect(form).toContainText("already cites this link");
  await expect(form.getByRole("button", { name: "Save evidence" })).toHaveCount(0);
});

test("evidence links: refused links explain why", async ({ page }) => {
  const d = await openDrawer(page, "commenter@example.com");
  await d.getByRole("button", { name: "Add evidence link" }).click();
  const form = d.getByRole("form", { name: "Add evidence link" });
  const tryLink = async (url: string, message: RegExp) => {
    await form.getByLabel("Public link").fill(url);
    await form.getByRole("button", { name: "Preview" }).click();
    await expect(form.getByRole("alert")).toHaveText(message);
    await expect(form.getByTestId("link-preview")).toHaveCount(0);
  };
  await tryLink("https://docs.google.com/document/d/1PrivateDocIdPrivateDocId/private", /^This link is not public/);
  await tryLink("http://research.example.com/activation", /Only https:\/\/ links/);
  await tryLink("https://192.168.1.20/wiki", /private, local or internal network address/);
  await tryLink("https://docs.google.com/spreadsheets/d/abc/edit", /Only Google Docs documents/);
  await expect(d.getByTestId("evidence-chip")).toHaveCount(3);
});

test("evidence links: a viewer gets no Add evidence link control", async ({ page }) => {
  const d = await openDrawer(page, "viewer@example.com");
  await expect(d.getByRole("button", { name: "Add evidence link" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: /^Refresh/ })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "goal-trace");
  await expect(page.getByRole("button", { name: /Actions for/ }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add evidence link/ }).filter({ visible: true })).toHaveCount(0);
});

test("evidence links: a commenter cites a Google Doc from a document section", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  const goalTrace = await openSection(page, "goal-trace");
  // The section's ⋯ menu holds Add evidence link (and Refine section, for approvers).
  await sectionAction(goalTrace, "1. Goal trace", "Add evidence link to 1. Goal trace");

  const form = goalTrace.getByRole("form", { name: "Add evidence link" });
  const target = form.getByLabel("Baseline item it supports");
  await target.selectOption({ label: "goal: Raise activation" });
  await form.getByLabel("Public link").fill("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012/edit?usp=sharing");
  await form.getByRole("button", { name: "Preview" }).click();
  await expect(form.getByTestId("link-preview-title")).toHaveText("Pricing page refresh");
  await expect(form.getByTestId("link-preview")).toContainText("Google Docs");
  await form.getByRole("button", { name: "Save evidence" }).click();
  await expect(goalTrace.getByRole("status")).toContainText("Saved “Pricing page refresh” as evidence. Everyone can see it.");

  // The baseline item now carries it, for everyone.
  await page.goto("/baseline");
  await page.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation" }).click();
  const d = page.getByRole("dialog", { name: "Raise activation" });
  await expect(d.getByTestId("evidence-row").filter({ hasText: "Pricing page refresh" })).toHaveCount(1);
});
