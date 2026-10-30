import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA fixes on Plan's Roadmap documents and Outcomes tabs (group "plandocs"), on the mock API,
 * driven through the UI as a person would.
 */

const PHONE = { width: 390, height: 844 };

async function start(page: Page, opts: { scenario?: string; role?: "viewer" | "commenter" | "approver" } = {}) {
  if (opts.scenario) await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), opts.scenario);
  if (opts.role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), opts.role);
  await login(page);
}

async function openTab(page: Page, tab: "documents" | "outcomes") {
  await page.goto("/plan");
  const tabs = page.getByTestId("plan-tabs").filter({ visible: true });
  if (tab === "documents") await tabs.getByRole("link", { name: "Roadmap documents" }).click();
  else await tabs.getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(new RegExp(`/plan/${tab}$`));
}

/** The element's left edge sits at least `gap` px inside the box's left edge (and the right likewise). */
async function insetBy(page: Page, inner: string, outer: string, gap: number) {
  const i = (await page.locator(inner).first().boundingBox())!;
  const o = (await page.locator(outer).first().boundingBox())!;
  expect(i.x - o.x).toBeGreaterThanOrEqual(gap);
  expect(o.x + o.width - (i.x + i.width)).toBeGreaterThanOrEqual(gap);
}

/* ---------------------------------- Roadmap documents ---------------------------------- */

test("qa-plan-6: roadmap and PRD names show in full, not cut", async ({ page }) => {
  await start(page);
  await openTab(page, "documents");
  // qa-plan-49: the roadmaps and the approved PRDs each have their own table.
  const names = page.locator('[data-testid="roadmaps-table"], [data-testid="approved-prds-table"]').getByTestId("roadmap-name");
  await expect(names).toHaveText(["Usage alerts roadmap", "Usage alerts PRD"]);
  for (const name of await names.all()) {
    const fits = await name.evaluate((el) => {
      const cell = el.closest("td")!;
      return cell.scrollWidth <= cell.clientWidth + 1 && getComputedStyle(cell).textOverflow !== "ellipsis";
    });
    expect(fits).toBe(true);
  }
});

test("qa-plan-21: templates and themes by their names, not code names", async ({ page }) => {
  await start(page);
  await openTab(page, "documents");
  const row = page.getByTestId("roadmap-row").first();
  const template = row.getByTestId("roadmap-template");
  await expect(template).toHaveText("Now / Next / Later");
  expect(await template.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
  const inspector = page.getByTestId("roadmap-inspector");
  await expect(inspector).toContainText("Now / Next / Later");
  await expect(inspector).toContainText("Roadmap board");
  await expect(page.getByTestId("roadmaps-table")).not.toContainText("now-next-later");
  await expect(inspector).not.toContainText("roadmap-board");
  await expect(inspector).not.toContainText("now-next-later");
});

test("qa-plan-17: a roadmap in review says which earlier version is approved, and when", async ({ page }) => {
  // roadmap-diff: v1 approved Oct 5, then v2 in review.
  await start(page, { scenario: "roadmap-diff" });
  await openTab(page, "documents");
  const row = page.getByTestId("roadmap-row").first();
  await expect(row).toContainText("In review");
  await expect(row.getByTestId("roadmap-approved-version")).toHaveText("v1 approved");
  await expect(page.getByTestId("roadmap-inspector").getByTestId("roadmap-approved")).toHaveText("v1, Oct 5");
});

test("qa-plan-17: a roadmap never approved says so", async ({ page }) => {
  await start(page);
  await openTab(page, "documents");
  const row = page.getByTestId("roadmap-row").first();
  await expect(row).toContainText("In review");
  await expect(row.getByTestId("roadmap-approved-version")).toHaveCount(0);
  // qa-plan-50: as a status chip, not a big figure.
  await expect(page.getByTestId("roadmap-inspector").getByTestId("roadmap-not-approved")).toHaveText("Not approved yet");
});

test("qa-plan-54: Build roadmap template descriptions wrap, not cut", async ({ page }) => {
  await start(page);
  await openTab(page, "documents");
  await page.getByTestId("approved-prd").first().getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByTestId("build-roadmap-dialog");
  const description = dialog.getByTestId("template-option-now-next-later").getByTestId("template-description");
  await expect(description).toHaveText("What happens now, next and later. Only Now has dates; every card names the goal it serves.");
  const cut = await description.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis");
  expect(cut).toBe(false);
});

/* ---------------------------------------- Outcomes ---------------------------------------- */

test("qa-plan-1: the Track outcome and Add learning forms and the empty text are inset like the card header", async ({ page }) => {
  await start(page);
  await openTab(page, "outcomes");
  await expect(page.getByTestId("learnings-empty")).toBeVisible();
  await insetBy(page, '[data-testid="learnings-empty"]', '[data-testid="learnings-panel"]', 16);
  await page.getByTestId("learnings-panel").getByRole("button", { name: "Add learning" }).click();
  await insetBy(page, '[data-testid="learning-form"]', '[data-testid="learnings-panel"]', 16);
  await page.getByTestId("outcome-track").click();
  await insetBy(page, '[data-testid="track-outcome-form"]', 'section[aria-label="Track outcome"]', 16);
});

test("qa-shell-35: on a phone the learnings empty text is padded and reads plainly", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await start(page);
  await openTab(page, "outcomes");
  const empty = page.getByTestId("learnings-empty");
  await expect(empty).toHaveText(
    "No learnings yet. When an outcome is checked, Oracle drafts one for you to keep. You can also add your own.",
  );
  await insetBy(page, '[data-testid="learnings-empty"]', '[data-testid="learnings-panel"]', 12);
});

for (const role of ["viewer", "commenter"] as const) {
  test(`qa-plan-37: a ${role} is not told to add a learning`, async ({ page }) => {
    await start(page, { role });
    await openTab(page, "outcomes");
    const empty = page.getByTestId("learnings-empty");
    await expect(empty).toHaveText(
      "No learnings yet. When an outcome is checked, Oracle drafts one, and an approver can keep it or add their own.",
    );
    await expect(page.getByTestId("learnings-panel").getByRole("button", { name: "Add learning" })).toHaveCount(0);
  });
}

test("qa-plan-35: the learning form uses plain words and named choices", async ({ page }) => {
  await start(page, { scenario: "outcomes" });
  await openTab(page, "outcomes");
  const panel = page.getByTestId("learnings-panel");
  // The seeded learning names its topic, not its key.
  await expect(panel.getByTestId("learning-row").first()).toContainText("A kind of interview question · Success metric and baseline");
  await expect(panel).not.toContainText("success_metric");
  await panel.getByRole("button", { name: "Add learning" }).click();
  const form = page.getByTestId("learning-form");
  await expect(form.getByLabel("What it is about").locator("option")).toHaveText(["A part of Oracle", "A kind of interview question", "A quality check"]);
  await expect(form.getByLabel("Key")).toHaveCount(0);
  await expect(form.locator('[placeholder="success_metric"]')).toHaveCount(0);
  await expect(form.getByLabel("Which kind of question").locator("option", { hasText: "Team ownership" })).toHaveCount(1);
  await form.getByLabel("Learning").fill("Ask who owns the rollout early");
  await form.getByLabel("Which kind of question").selectOption({ label: "Team ownership" });
  await form.getByRole("button", { name: "Add learning" }).click();
  await expect(panel.getByTestId("learning-row").filter({ hasText: "Ask who owns the rollout early" })).toContainText(
    "A kind of interview question · Team ownership",
  );
});

test("qa-plan-36: the header's Track outcome button hides while the form is open", async ({ page }) => {
  await start(page);
  await openTab(page, "outcomes");
  await page.getByTestId("outcome-track").click();
  await expect(page.getByTestId("track-outcome-form")).toBeVisible();
  await expect(page.getByTestId("outcome-track")).toHaveCount(0);
  await page.getByTestId("track-outcome-form").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("outcome-track")).toBeVisible();
});

test("qa-plan-30: Escape cancels the Track outcome and Add learning forms", async ({ page }) => {
  await start(page);
  await openTab(page, "outcomes");
  await page.getByTestId("outcome-track").click();
  const track = page.getByTestId("track-outcome-form");
  await track.getByLabel("Expected effect").fill("+5 weekly active teams");
  await page.keyboard.press("Escape");
  await expect(track).toHaveCount(0);
  await expect(page.getByTestId("outcome-track")).toBeVisible();

  await page.getByTestId("learnings-panel").getByRole("button", { name: "Add learning" }).click();
  const learning = page.getByTestId("learning-form");
  await learning.getByLabel("Learning").fill("Something learnt");
  await page.keyboard.press("Escape");
  // A typed learning asks before it is dropped (fix-plan review: nothing lost by a stray key).
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard learning" }).click();
  await expect(learning).toHaveCount(0);
});
