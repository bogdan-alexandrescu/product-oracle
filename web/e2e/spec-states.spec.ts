import { expect, test, type Locator } from "@playwright/test";

import { login, openSection } from "./helpers";

// E1 'Added sections, visible' (owner, 2026-10-20): in the document view every section an
// edit added carries 'Proposed · added in an edit', and Oracle's parts show their state.
// Version 1 is the brief Oracle wrote; version 2 is an edit that added "Rollout notes" (not
// in the template), "Proposed architecture" (a template section a brief does not have) and
// a source. The version view opens one section at a time (the strip picks it).
const BRIEF = "/documents/checkout-redesign-early-shipping-cost-spec";
const FULL = "/documents/checkout-redesign-early-shipping-cost-engineering-spec";
const ADDED = "Proposed · added in an edit";

async function expectAdded(label: Locator) {
  await expect(label).toHaveText(ADDED);
  await expect(label).toHaveAttribute("data-added", "true");
  await expect(label).toHaveAttribute("data-decided", "false");
}

test("spec: an added section is labelled Proposed · added in an edit; Oracle's parts show their state", async ({ page }) => {
  await login(page);
  await page.goto(`${BRIEF}/v/2`);
  const rollout = await openSection(page, "rollout-notes");
  await expect(rollout.getByRole("heading", { name: "Rollout notes" })).toBeVisible();
  await expectAdded(rollout.getByTestId("spec-state"));
  // A template section a technical brief does not have is an added section too.
  const architecture = await openSection(page, "architecture");
  await expect(architecture.getByRole("heading", { name: "Proposed architecture" })).toBeVisible();
  await expectAdded(architecture.getByTestId("spec-state"));
  // Oracle's Product requirements are decided from the PRD; the approach is proposed.
  const requirements = (await openSection(page, "requirements")).getByTestId("spec-state");
  await expect(requirements).toHaveText("Decided · from the approved PRD");
  await expect(requirements).toHaveAttribute("data-decided", "true");
  await expect(requirements).toHaveAttribute("data-added", "false");
  await expect((await openSection(page, "approach")).getByTestId("spec-state")).toHaveText(
    "Proposed · until an engineering approver approves this version",
  );
  // The acceptance criteria read as two parts, in the full document.
  await page.getByRole("button", { name: /Show full document/ }).click();
  const ac = await openSection(page, "acceptance-criteria");
  await expect(ac.getByTestId("spec-state")).toHaveText([
    "Decided · from the approved PRD",
    "Proposed · not a product requirement until the PRD adopts it",
  ]);
  await expect(ac.getByTestId("spec-state").nth(1)).toHaveAttribute("data-added", "false");
  // The proposed label sits right before Oracle's "Proposed by this spec" paragraph.
  const marker = ac.getByTestId("spec-state-marker");
  await expect(marker.locator("xpath=following-sibling::p[1]")).toContainText("Proposed by this spec");
  // The title holds the document together: no state.
  await expect((await openSection(page, "spec")).getByTestId("spec-state")).toHaveCount(0);
});

test("spec: the version Oracle wrote has no added section", async ({ page }) => {
  await login(page);
  await page.goto(`${BRIEF}/v/1`);
  await expect((await openSection(page, "requirements")).getByTestId("spec-state")).toBeVisible();
  await expect(page.locator('a[data-strip-key="architecture"]')).toHaveCount(0);
  await expect(page.locator('a[data-strip-key="rollout-notes"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="spec-state"][data-added="true"]')).toHaveCount(0);
});

test("spec: a source an edit added is listed under Added sources, apart from Oracle's", async ({ page }) => {
  await login(page);
  await page.goto(`${BRIEF}/v/2`);
  await page.getByRole("tab", { name: /^Sources/ }).filter({ visible: true }).click();
  const oracle = page.getByTestId("sources-list").filter({ visible: true });
  await expect(oracle.getByRole("listitem")).toHaveCount(1);
  await expect(oracle).toContainText("Checkout redesign PRD, version 1");
  await expect(oracle).not.toContainText("Carrier quote latency");
  const added = page.getByTestId("added-sources").filter({ visible: true });
  await expect(added.getByText("Added sources")).toBeVisible();
  await expectAdded(added.getByTestId("spec-state"));
  await expect(added.getByRole("listitem")).toHaveCount(1);
  await expect(added.getByRole("listitem")).toContainText("Carrier quote latency, p95");
});

test("spec: a full engineering spec labels only the section outside the template as added", async ({ page }) => {
  await login(page);
  await page.goto(`${FULL}/v/1`);
  await page.getByRole("button", { name: /Show full document/ }).click();
  await expectAdded((await openSection(page, "launch-checklist")).getByTestId("spec-state"));
  // Architecture is in a full spec's template: proposed until an engineering approver approves.
  const architecture = (await openSection(page, "architecture")).getByTestId("spec-state");
  await expect(architecture).toHaveText("Proposed · until an engineering approver approves this version");
  await expect(architecture).toHaveAttribute("data-added", "false");
  await expect((await openSection(page, "acceptance-criteria")).getByTestId("spec-state")).toHaveCount(2);
  await page.getByRole("tab", { name: /^Sources/ }).filter({ visible: true }).click();
  await expect(page.getByTestId("added-sources").filter({ visible: true }).getByRole("listitem")).toHaveCount(1);
});

test("spec: the diff shows an added section's state", async ({ page }) => {
  await login(page);
  await page.goto(`${BRIEF}/diff?from=1&to=2`);
  const architecture = page.getByTestId("diff-section").filter({ hasText: "Proposed architecture" });
  await expect(architecture).toHaveAttribute("data-status", "added");
  await expectAdded(architecture.getByTestId("spec-state"));
  await expectAdded(page.getByTestId("diff-section").filter({ hasText: "Rollout notes" }).getByTestId("spec-state"));
});

test("spec: a PRD's sections carry no spec state", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "problem");
  await expect(page.getByTestId("spec-state")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Sources/ }).filter({ visible: true }).click();
  await expect(page.getByTestId("added-sources")).toHaveCount(0);
});
