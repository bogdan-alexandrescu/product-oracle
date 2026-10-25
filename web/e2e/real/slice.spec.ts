import { expect, test, type Page } from "@playwright/test";

import { login } from "./ui";

/*
 * Wave 3, the vertical slice (docs/product-oracle-v2/waves.md): one short brief becomes a
 * published PRD and a roadmap on the real stack, on synthetic data. The agent work runs on
 * the API's FakeRuntime (ORACLE_RUNTIME=fake in playwright.real.config.ts) and advances
 * when the owner presses "Check agents now", as Cloud Scheduler's tick would.
 *
 * Card (E2E real): protects=brief -> gaps and questions -> composition -> PRD draft ->
 * review -> publish -> roadmap, each step fed by the one before through the real API and
 * Next's /v1 proxy; fails_when=a step's output does not reach the next one (the brief's
 * gaps, the draft gate, the run's import, the review, the publish gate, the composition
 * pinned to the published version, the roadmap run from the approved PRD);
 * no_claim=the agents' writing (FakeRuntime's fixed files), the real Claude or SwarmCloud,
 * the engineering spec (no screen starts one: POST /v1/spec-requests only).
 *
 * No screen shows the composition yet (web/e2e/compositions-mock.spec.ts): the slice
 * confirms and checks it as the agent track does, through /v1, and says so where it does.
 */

const TITLE = "Saved delivery notes";
const DOC = "saved-delivery-notes";
const PROBLEM =
  "Returning buyers type the same delivery note at every checkout. Saving it once would make repeat checkout faster.";

/** The owner's "Check agents now" on the run page: one tick of the company's runs. */
async function checkAgents(page: Page) {
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(page.getByTestId("tick-result")).toBeVisible();
}

/** Ticks until the segment reads `state` (a tick moves a run one segment at most). */
async function tickUntil(page: Page, segment: string, state: RegExp) {
  const shown = page.getByTestId(`segment-${segment}`).getByTestId("segment-state");
  for (let i = 0; i < 6; i++) {
    if (state.test((await shown.textContent()) ?? "")) return;
    await checkAgents(page);
  }
  await expect(shown).toHaveText(state);
}

test("the slice: a brief becomes a published PRD and a roadmap", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  // 1. The brief, through the one New PRD door.
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill(TITLE);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  const intakeId = page.url().split("/intakes/")[1];
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();

  // 2. Gaps and questions: Oracle asked its first batch, and the critical gaps hold the draft.
  const thread = page.getByTestId("intake-thread");
  await expect(thread.getByTestId("question")).not.toHaveCount(0);
  const draft = page.getByRole("button", { name: "Draft with Oracle" });
  await expect(draft).toBeDisabled();
  await expect(page.getByTestId("draft-reason")).toContainText("critical");
  const inspector = page.getByTestId("intake-inspector").filter({ visible: true });
  const gate = inspector.getByTestId("ready-to-draft");
  await expect(gate.getByTestId("blocking-gap")).not.toHaveCount(0);

  // The owner answers Oracle's first question in the thread (plain answers: no follow-up model call).
  const followUp = page.getByRole("switch", { name: "Oracle follows up" });
  if (await followUp.isChecked()) await followUp.uncheck();
  const question = thread.getByTestId("question").filter({ has: page.getByRole("button", { name: "Answer", exact: true }) }).first();
  await question.getByRole("button", { name: "Answer", exact: true }).click();
  const form = question.getByTestId("answer-question");
  await form.getByLabel("Your answer").fill("Repeat checkouts with a note: 40 a day today, half of them saved by June.");
  await form.getByRole("button", { name: "Send answer" }).click();
  await expect(question.getByTestId("answer")).toContainText("Repeat checkouts with a note");

  // The rest of the critical gaps are decided from the inspector, each with a rationale.
  while ((await gate.getByTestId("blocking-gap").count()) > 0) {
    const gap = gate.getByTestId("blocking-gap").first();
    await gap.getByRole("button", { name: "Decide" }).click();
    await gate.getByRole("radio", { name: "Accept as an assumption" }).check();
    await gate.getByLabel("Rationale").fill("A synthetic slice: drafting proceeds on this assumption.");
    await gate.getByRole("button", { name: "Record decision" }).click();
    await expect(gap).not.toBeVisible();
  }
  await expect(page.getByTestId("draft-reason")).toHaveCount(0);
  await expect(draft).toBeEnabled();

  // 3. Composition (no screen yet: through /v1 as the agent track does). The intake's
  // recommendation names the modules the PRD will be composed of.
  const recommended = await page.request.post("/v1/compositions/recommend", { data: { intake_id: intakeId } });
  expect(recommended.status(), await recommended.text()).toBe(200);
  const modules: { key: string; included: boolean }[] = (await recommended.json()).composition.modules;
  expect(modules.filter((m) => m.included).length).toBeGreaterThan(0);

  // 4. The PRD draft: Draft with Oracle, every stop but the PRD review switched off.
  await draft.click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  for (const stop of await sheet.getByRole("switch").all()) {
    const name = await stop.getAttribute("aria-label");
    if (name !== "PRD review" && (await stop.isChecked())) await stop.uncheck();
  }
  await expect(sheet.getByRole("switch", { name: "PRD review" })).toBeChecked();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toContainText("$");
  await sheet.getByRole("button", { name: /^(Start drafting|Approve .* and start)$/ }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();

  await tickUntil(page, "prd_draft", /Imported|Waiting|Succeeded|Done/);
  const review = page.getByTestId("checkpoint-prd_review");
  await expect(review.getByTestId("run-review-summary")).toContainText("v1");

  // The composition is confirmed on the drafted PRD.
  const confirmed = await page.request.post(`/v1/documents/${DOC}/composition/revisions`, {
    data: { base_revision: null, reason: "The slice's composition, from the brief's intake", intake_id: intakeId },
  });
  expect(confirmed.status(), await confirmed.text()).toBe(201);
  const revision: number = (await confirmed.json()).current.number;

  // 5. Review: the run's review opens the version.
  await review.getByRole("link", { name: "Open review" }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/v/1`));

  // 6. Publish: the publish check, then the publish (it approves v1 and the run's review).
  await page.getByTestId("publish-link").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/publish`));
  await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v1");
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v1");

  // The confirmed composition is pinned to the published version (through /v1).
  const pinned = await page.request.post(`/v1/documents/${DOC}/composition/publish`, { data: { version: 1 } });
  expect(pinned.status(), await pinned.text()).toBe(200);
  expect(await pinned.json()).toMatchObject({ number: revision, published_version: 1 });

  // 7. The roadmap, from the approved PRD.
  await page.goto(`/documents/${DOC}/v/1`);
  await page.getByRole("button", { name: "Build roadmap" }).filter({ visible: true }).click();
  const build = page.getByRole("dialog", { name: "Build roadmap" });
  await expect(build).toContainText("v1");
  await build.getByRole("button", { name: "Estimate" }).click();
  await expect(build.getByTestId("estimate-total")).toContainText("$");
  await build.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await tickUntil(page, "roadmap_items", /Waiting|Succeeded|Done/);
  const items = page.getByTestId("checkpoint-roadmap_items");
  if (await items.isVisible()) {
    await items.getByRole("link", { name: "Review items" }).click();
    await page.getByTestId("decision-bar").getByRole("button", { name: "Approve" }).click();
    await page.goBack();
  }
  await tickUntil(page, "roadmap_draft", /Imported|Waiting|Succeeded|Done/);
  await expect(page.getByTestId("segment-roadmap_draft")).toContainText(`Imported as ${DOC}-roadmap v1`);
  await page.getByTestId("segment-roadmap_draft").getByRole("link", { name: `${DOC}-roadmap v1` }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}-roadmap/v/1`));
});
