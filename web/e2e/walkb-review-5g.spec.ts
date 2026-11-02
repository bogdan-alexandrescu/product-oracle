import { expect, test } from "./test";

import { login } from "./helpers";

// walkb-review 5g: the Build roadmap dialog, opened from an approved PRD, keeps its layout once
// open. The recommendation, templates and themes load in after it opens; they no longer push the
// footer down, so a click aimed at Estimate cost does not land on a template option instead.

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    // Card entry: protects = a click aimed at Estimate cost as the dialog opens still estimates;
    // fails_when = the templates load in, move the footer down and the click picks a template;
    // no_claim = what the estimate costs.
    test("the Build roadmap dialog does not move once open", async ({ page }) => {
      await login(page);
      await page.goto("/plan/documents");
      await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
      const dialog = page.getByRole("dialog", { name: "Build roadmap" });
      await expect(dialog).toContainText("Usage alerts PRD v1");

      // Where Estimate cost is the moment the dialog shows.
      const estimate = dialog.getByRole("button", { name: "Estimate cost" });
      const aimed = (await estimate.boundingBox())!;

      // The templates load in; Estimate cost stays where it was.
      const templates = dialog.getByRole("radiogroup", { name: "Template" });
      await expect(templates.getByRole("radio", { name: /Now \/ Next \/ Later/ })).toBeChecked();
      const now = (await estimate.boundingBox())!;
      expect(Math.abs(now.y - aimed.y)).toBeLessThan(1);
      expect(Math.abs(now.x - aimed.x)).toBeLessThan(1);

      // The click aimed there estimates, and picks no other template.
      await page.mouse.click(aimed.x + aimed.width / 2, aimed.y + aimed.height / 2);
      await expect(dialog.getByTestId("estimate-total")).toBeVisible();
      await expect(templates.getByRole("radio", { name: /Now \/ Next \/ Later/ })).toBeChecked();
    });
  });
}
