import { expect, test, type Page } from "./test";

import { BLOCKER_NARROWED_SCENARIO } from "../lib/api/mock/blockers";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Set status on a blocker the API would refuse to reopen for this person (B4): the
 * address-lookup blocker was resolved while it gated publishing, and an import dropped its
 * document since. An approver sees Set status disabled with the API's reason; an owner
 * reopens it.
 */
const LOOKUP = "The address lookup service allows 100 requests a minute per company";
const REOPEN = "This blocker gated publishing when it was resolved and was lowered or narrowed since. Only an owner can reopen it.";

async function openLookup(page: Page, role?: "approver") {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, BLOCKER_NARROWED_SCENARIO] as const);
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
  await page.goto("/baseline?tab=blockers");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByTestId("blocker-row").filter({ hasText: LOOKUP }).click();
  const insp = page.getByTestId("blocker-inspector");
  await expect(insp.getByRole("heading", { name: LOOKUP })).toBeVisible();
  await expect(insp.getByTestId("blocker-status")).toHaveText("Resolved");
  return insp;
}

test("an approver sees Set status disabled with the reason when reopening takes an owner", async ({ page }) => {
  const insp = await openLookup(page, "approver");
  const form = insp.getByRole("form", { name: "Change status" });
  await expect(form).toContainText(REOPEN);
  await expect(form.getByRole("button", { name: "Set status" })).toBeDisabled();
  await expect(form.getByLabel("Status", { exact: true })).toBeDisabled();
  // The rest of the inspector stays the approver's.
  await expect(insp.getByRole("button", { name: "Edit blocker", exact: true })).toBeEnabled();
});

test("an owner reopens the same blocker", async ({ page }) => {
  const insp = await openLookup(page);
  const form = insp.getByRole("form", { name: "Change status" });
  await expect(form).not.toContainText(REOPEN);
  await form.getByLabel("Status", { exact: true }).selectOption("open");
  await form.getByLabel("Reason").fill("The provider cut our tier again");
  await form.getByRole("button", { name: "Set status" }).click();
  await expect(insp.getByTestId("blocker-status")).toHaveText("Open");
  await expect(insp.getByRole("list", { name: "History" })).toContainText("Status changed from resolved to open");
});
