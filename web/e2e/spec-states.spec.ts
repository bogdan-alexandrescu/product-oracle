import { expect, test } from "@playwright/test";

import { login, section } from "./helpers";

// E1 'Added sections, visible' (owner, 2026-10-20): in the document view every section an
// edit added carries 'Proposed · added in an edit', and Oracle's parts show their state.
const SPEC = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";

test("spec: an added section is labelled Proposed · added in an edit; Oracle's parts show their state", async ({ page }) => {
  await login(page);
  await page.goto(SPEC);
  const added = section(page, "rollout-notes").first();
  await expect(added.getByRole("heading", { name: "Rollout notes" })).toBeVisible();
  const label = added.getByTestId("spec-state");
  await expect(label).toHaveText("Proposed · added in an edit");
  await expect(label).toHaveAttribute("data-added", "true");
  await expect(label).toHaveAttribute("data-decided", "false");
  // Oracle's Product requirements are decided from the PRD; the approach is proposed.
  await expect(section(page, "requirements").first().getByTestId("spec-state")).toHaveText("Decided · from the approved PRD");
  await expect(section(page, "approach").first().getByTestId("spec-state")).toHaveText(
    "Proposed · until an engineering approver approves this version",
  );
  // The title holds the document together: no state.
  await expect(section(page, "spec").first().getByTestId("spec-state-top")).toHaveCount(0);
  // The acceptance criteria read as two parts, in the full document.
  await page.getByRole("button", { name: /Show full document/ }).click();
  const ac = section(page, "acceptance-criteria").first();
  await expect(ac.getByTestId("spec-state")).toHaveText([
    "Decided · from the approved PRD",
    "Proposed · not a product requirement until the PRD adopts it",
  ]);
  // The proposed label sits right before Oracle's "Proposed by this spec" paragraph.
  const proposed = ac.getByTestId("spec-state").nth(1);
  await expect(proposed.locator("xpath=../following-sibling::p[1]")).toContainText("Proposed by this spec");
});

test("spec: a PRD's sections carry no spec state", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(section(page, "problem").first()).toBeVisible();
  await expect(page.getByTestId("spec-state")).toHaveCount(0);
});
