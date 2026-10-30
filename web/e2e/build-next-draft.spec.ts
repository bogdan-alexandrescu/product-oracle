import { expect, test, type Page } from "./test";

import { feedbackState, login } from "./helpers";

/**
 * D12: one Build next draft that picks the engine and says why.
 *
 * Fixture ("next-draft" scenario): the fleet PRD on draft 2 with two accepted section-text
 * changes (F-33 Proof of delivery, F-34 Failed delivery flow), a whole-draft remark staged
 * for the agents, and one whole-draft remark nobody staged. "next-draft-costly": the same,
 * with the agents' run estimated over the owner-approval threshold ($50).
 */
const DOC = "/documents/fleet-next/v/2";
const STAGED_REMARK = "The draft never says how drivers learn the new app.";
const OPEN_REMARK = "Say which fleets join the pilot first.";

async function open(page: Page, scenario = "next-draft") {
  await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), scenario);
  await login(page);
  await page.goto(DOC);
}

const buildButton = (page: Page) => page.getByTestId("build-draft").filter({ visible: true });
const sheet = (page: Page) => page.getByTestId("next-draft-sheet");
const engine = (page: Page) => sheet(page).getByTestId("engine-line");
const agentBox = (page: Page) => sheet(page).getByRole("checkbox", { name: `Include General: ${STAGED_REMARK}` });

test("the sheet says which engine builds the ticked items, and Build starts the agents' run", async ({ page }) => {
  await open(page);
  await expect(buildButton(page)).toContainText("Build draft 3");
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 3 staged");
  await buildButton(page).click();
  const s = sheet(page);
  await expect(s.getByTestId("staged-list").getByTestId("staged-item")).toHaveCount(2);
  await expect(s.getByTestId("staged-list")).toContainText("Section F-33 Proof of delivery");
  const agents = s.getByTestId("agent-list").getByTestId("agent-item");
  await expect(agents).toHaveCount(1);
  await expect(agents).toContainText("General");
  await expect(agents).toContainText(STAGED_REMARK);
  await expect(engine(page)).toHaveText("Agents write draft 3 because 1 remark is about the whole draft.");

  await agentBox(page).uncheck();
  await expect(engine(page)).toHaveText("Oracle rewrites 2 sections itself and shows you a preview.");
  await agentBox(page).check();
  await expect(engine(page)).toHaveText("Agents write draft 3 because 1 remark is about the whole draft.");

  await s.getByRole("button", { name: "Build draft 3" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");
  await expect(page.getByText("Feedback loop").filter({ visible: true }).first()).toBeVisible();
});

test("Stage for agents on a whole-draft remark adds it to the next draft", async ({ page }) => {
  await open(page);
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 3 staged");
  await page.getByRole("tab", { name: "Feedback" }).filter({ visible: true }).click();
  const panel = page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
  await panel.getByTestId("inspector-scope").getByRole("button", { name: /^General/ }).click();
  const remark = panel.getByTestId("feedback-item").filter({ hasText: OPEN_REMARK });
  await expect(remark).toHaveAttribute("data-state", "open");

  await remark.getByRole("button", { name: "Stage for agents" }).click();

  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 4 staged");
  await feedbackState(page, "Staged");
  const staged = panel.getByTestId("feedback-item").filter({ hasText: OPEN_REMARK });
  await expect(staged.getByTestId("feedback-state-chip")).toHaveText("Staged");
  await expect(staged.getByTestId("agent-staged")).toHaveText("Staged for draft 3 · agents");
  // Unstage reverses it.
  await staged.getByRole("button", { name: "Unstage" }).click();
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 3 staged");
});

test("cost shows only when the agents build: one small estimate, or the owner's approval above $50", async ({ page }) => {
  await open(page);
  await buildButton(page).click();
  const s = sheet(page);
  await expect(engine(page)).toContainText("Agents write draft 3");
  await expect(s.getByTestId("run-estimate")).toHaveText("Estimate $9.00");
  await agentBox(page).uncheck();
  await expect(engine(page)).toContainText("Oracle rewrites 2 sections");
  await expect(s.getByTestId("run-estimate")).toHaveCount(0);
  await expect(s.getByTestId("build-estimate")).toHaveCount(0);
  await expect(s).not.toContainText("$");
});

test("over the threshold the estimate becomes the owner's decision and the run waits", async ({ page }) => {
  await open(page, "next-draft-costly");
  await buildButton(page).click();
  const s = sheet(page);
  await expect(s.getByTestId("run-estimate")).toHaveText("Ask an owner to approve ($64.00)");
  await s.getByRole("button", { name: "Build draft 3" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Awaiting cost approval");
});

test("the New run dialog no longer offers the feedback loop and points at where flows start", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.getByRole("button", { name: "Start a run…" }).click();
  const dialog = page.getByRole("dialog", { name: "Where to start a run" });
  // C4: Baseline to PRD starts at New PRD too, so the dialog offers no flow.
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(dialog.getByText("Feedback loop")).toHaveCount(0);
  const pointers = dialog.getByTestId("flow-pointer");
  await expect(pointers).toHaveText([
    "New PRD · PRDs",
    "Build next draft · open a PRD or roadmap and use Build next draft",
    "PRD to roadmap · Plan › Roadmap documents",
    // F5 lane 3: an engineering spec is requested from the Plan or a PRD's overview.
    "Request spec · Plan, an approved item, or a PRD's overview",
    "Vision or strategy · Company › Strategy, New vision or Draft next version",
    "Build the baseline · Baseline",
    // H9: a pricing memo is drafted from Company › Market › Pricing (D12).
    "Draft with Oracle · Company › Market › Pricing",
  ]);
  await expect(pointers.getByRole("link", { name: "PRD to roadmap · Plan › Roadmap documents" })).toHaveAttribute("href", "/plan/documents");
  // H4: a vision or strategy draft starts on Company › Strategy.
  await expect(pointers.getByRole("link", { name: /^Vision or strategy/ })).toHaveAttribute("href", "/company/strategy");
});
