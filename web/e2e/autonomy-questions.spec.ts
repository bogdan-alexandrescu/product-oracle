import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING, QUESTIONS_OBSERVE } from "../lib/api/mock/intake";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * C2 Questions to people under H11 Autonomy (#151): at Observe, Oracle asks no one. An owner
 * sets Ask people questions to Observe in Settings › Autonomy, and the brief's Next questions
 * panel then says so in plain words instead of offering Ask these. The "before-drafting" mock
 * scenario is the default company plus one brief by admin@example.com (an owner) with twelve
 * questions not asked yet. Each test's card: protects=...; fails_when=...; no_claim=...
 */

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, "before-drafting");
  }, MOCK_SCENARIO_KEY);
});

// protects=an owner sets Ask people questions to Observe with a reason, and the brief's Next
// questions panel then shows "Oracle is set to observe questions: it asks no one..." with no
// proposed questions and no Ask these button; fails_when=the panel still proposes a batch or
// offers Ask these at Observe, or says nothing about why; no_claim=the API's refusal and the
// Act tick (pytest tests/test_questions_autonomy.py covers them).
test("autonomy: at Observe the brief's Next questions says Oracle asks no one", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(row(page, "questions")).toContainText("Ask people questions");
  await step(page, "questions", "Observe").click();
  const sheet = page.getByRole("dialog", { name: "Change Ask people questions" });
  await expect(sheet.getByTestId("autonomy-to")).toContainText("asks no one");
  await sheet.getByLabel("Why").fill("We are interviewing people ourselves this month");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "questions", "Observe")).toHaveAttribute("aria-pressed", "true");
  // #586 review MAJOR 3: Oracle follows Ask people questions now: no "Takes effect" chip.
  await expect(row(page, "questions").getByTestId("autonomy-pending")).toHaveCount(0);

  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  const next = page.getByTestId("next-questions");
  await expect(next.getByTestId("questions-held")).toHaveText(QUESTIONS_OBSERVE);
  await expect(next).toContainText("Oracle has 12 more questions");
  await expect(next.getByTestId("next-question")).toHaveCount(0);
  await expect(next.getByRole("button", { name: "Ask these" })).toHaveCount(0);
});
