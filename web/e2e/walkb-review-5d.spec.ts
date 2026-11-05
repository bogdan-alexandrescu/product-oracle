import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test } from "./test";

// walkb-roadmap review: a roadmap built from an approved PRD (the "simple-plan" scenario: the
// Guided setup PRD, its Setup checklist from section F-01). The PRD's one-pager draws a flow
// for its bet "A setup checklist that shows the next step"; Setup checklist's sheet in
// Simple > Roadmap shows that flow too, not "No flow yet". Invented data.

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("an item built from a PRD shows the flow its one-pager draws", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
      await login(page);

      await page.goto("/simple/roadmap");
      await openRoadmapItem(page, "setup-checklist");
      const card = page.getByTestId("floating-card");
      const flow = card.getByTestId("card-flow");
      await expect(flow).toContainText("Finish setup from the checklist");
      await expect(flow).not.toContainText("No flow yet");

      await card.getByRole("button", { name: "Open the item's flow" }).click();
      // build-feature-panel: the card is the one feature panel; its own parts (and the flow) sit in fp-more.
      await expect(card.getByTestId("fp-more")).toHaveAttribute("data-flow-open", "true");
      await expect(page.getByTestId("flow-detail").getByTestId("flow-regions")).toContainText("Setup checklist: 4 steps");
    });
  });
}
