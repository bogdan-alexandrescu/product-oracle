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
  test.setTimeout(180_000);
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

  // 2. Gaps and questions: Oracle found the brief's gaps and asked its first batch.
  await page.getByRole("tab", { name: /^Gaps/ }).click();
  await expect(page.getByTestId("gap-row")).not.toHaveCount(0);
  await page.getByRole("tab", { name: "Questions" }).click();
  const thread = page.getByTestId("intake-thread");
  await expect(thread.getByTestId("question")).not.toHaveCount(0);
  const draft = page.getByRole("button", { name: "Draft with Oracle" });
  const inspector = page.getByTestId("intake-inspector").filter({ visible: true });
  const gate = inspector.getByTestId("ready-to-draft");
  await expect(gate).toBeVisible();

  // The owner answers Oracle's first question in the thread (plain answers: no follow-up model call).
  const followUp = page.getByRole("switch", { name: "Oracle follows up" });
  if (await followUp.isChecked()) await followUp.uncheck();
  const first = thread.getByTestId("question").filter({ has: page.getByRole("button", { name: "Answer", exact: true }) }).first();
  const prompt = (await first.getByRole("article").getAttribute("aria-label")) ?? "";
  const question = thread.getByTestId("question").filter({ has: page.getByRole("article", { name: prompt, exact: true }) });
  await question.getByRole("button", { name: "Answer", exact: true }).click();
  const form = question.getByTestId("answer-question");
  await form.getByLabel("Your answer").fill("Repeat checkouts with a note: 40 a day today, half of them saved by June.");
  await form.getByRole("button", { name: "Send answer" }).click();
  await expect(question.getByTestId("answer")).toContainText("Repeat checkouts with a note");

  // A critical blocker gap still open holds the draft: it is decided from the inspector.
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
  const recommendation = await recommended.json();
  expect(recommendation.intake_id).toBe(intakeId);
  expect(recommendation.modules.length).toBeGreaterThan(0);

  // 4. The PRD draft: Draft with Oracle, every stop but the PRD review switched off.
  await draft.click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  // No baseline was approved yet: Oracle rebuilds it first, so its stop is listed too.
  await expect(sheet.getByRole("switch")).toHaveCount(5);
  for (const stop of ["Confirm the baseline", "Feature set and dependencies", "Engineering check", "Priority order"]) {
    await sheet.getByRole("switch", { name: stop }).uncheck();
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

  // 5. Review: the run's review opens the version, where the run's review bar waits.
  const prdRun = page.url();
  await review.getByRole("link", { name: "Open review" }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/v/1`));
  await expect(page.getByTestId("run-review-bar")).toBeVisible();

  // 6. Publish: the publish check, then the publish (it approves v1 and the run's review).
  await page.getByTestId("publish-link").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/publish`));
  await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v1");
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v1");

  // Publishing settled the run's PRD review: the run is done.
  await page.goto(prdRun);
  await expect(page.getByTestId("run-status")).toHaveText("Succeeded");

  // The confirmed composition is pinned to the published version (through /v1).
  const pinned = await page.request.post(`/v1/documents/${DOC}/composition/publish`, { data: { version: 1 } });
  expect(pinned.status(), await pinned.text()).toBe(200);
  const published = await pinned.json();
  expect(published).toMatchObject({ number: revision, status: "published" });
  expect(published.document_version_id).not.toBeNull();

  // 7. The roadmap, from the approved PRD.
  await page.goto(`/documents/${DOC}/v/1`);
  await page.getByRole("button", { name: "Build roadmap" }).filter({ visible: true }).click();
  const build = page.getByRole("dialog", { name: "Build roadmap" });
  await expect(build).toContainText("v1");
  await build.getByRole("button", { name: "Estimate" }).click();
  await expect(build.getByTestId("estimate-total")).toContainText("$");
  await build.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  const roadmapRun = page.url();

  // The Roadmap items stop: the items drawn from the PRD are approved on their review screen.
  await tickUntil(page, "roadmap_items", /Waiting|Succeeded|Done/);
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await expect(page.getByTestId("roadmap-item-row")).not.toHaveCount(0);
  const decided = page.waitForResponse((r) => r.url().includes("/decide") && r.request().method() === "POST");
  await page.getByTestId("decision-bar").getByRole("button", { name: "Approve" }).click();
  expect((await decided).status()).toBe(200);
  await page.goto(roadmapRun);
  await tickUntil(page, "roadmap_draft", /Imported|Waiting|Succeeded|Done/);
  await expect(page.getByTestId("segment-roadmap_draft")).toContainText(`Imported as ${DOC}-roadmap v1`);
  await page.getByTestId("segment-roadmap_draft").getByRole("link", { name: `${DOC}-roadmap v1` }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}-roadmap/v/1`));
  // The roadmap draft waits for its review, in its version, like the PRD did.
  await expect(page.getByTestId("run-review-bar")).toBeVisible();
});
