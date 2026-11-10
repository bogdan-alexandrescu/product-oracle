import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * tb-mk (the owner's picks: track bands C "Name, goal, health tick"; milestone kinds B "Icon in the
 * label"), on invented data (the mock's "roadmap-milestones" scenario; the mock's today is Nov 3, 2026).
 *
 * Card roadmap-track-bands: protects = the Timeline draws one band per track in the tracks' order,
 * then No track; each band's header names its track and goal and ends with a health tick or
 * warning whose tooltip says why; fails_when = the bands are goals, or a header lacks the goal or mark.
 * Card milestone-kind-label: protects = each Milestones band label leads with its kind's icon and
 * ends with its status mark, its tooltip naming kind, status and reason; fails_when = no icon or mark.
 * Card milestone-kind-handoff: protects = the panel changes a milestone's kind to Hand-off and sets
 * its From and To tracks, kept after a reload; fails_when = the kind or the tracks are not saved.
 * Card milestone-kind-first: protects = "+ Milestone" asks for the kind first and the new milestone
 * has that kind; fails_when = the card opens with no kind asked.
 */

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-milestones"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("ms-band")).toBeVisible();
}

const lanes = (page: Page) => page.getByTestId("timeline-lane");
const label = (page: Page, start: string) => page.getByTestId("ms-label").filter({ hasText: start });
const card = (page: Page) => page.getByTestId("ms-card");

test.describe("Roadmap: track bands and milestone kinds", () => {
  test("the Timeline's bands are the tracks, in order, then No track; a header names the goal and its health tick says why", async ({ page }) => {
    await open(page);
    // A person ties a track to a goal in the Tracks sheet.
    await page.getByTestId("tracks-open").click();
    const sheet = page.getByTestId("tracks-sheet");
    await sheet.getByRole("button", { name: "Change Usage alerts track" }).click();
    const row = sheet.getByTestId("track-row").filter({ has: page.getByText("Usage alerts track", { exact: true }) });
    const goal = row.getByLabel("Goal", { exact: true });
    const goalName = (await goal.locator("option").nth(1).textContent())!.trim();
    await goal.selectOption({ label: goalName });
    await expect(page.getByTestId("toasts")).toContainText(`goal is now ${goalName}`);
    await page.reload();
    await expect(page.getByTestId("ms-band")).toBeVisible();

    const names = (await lanes(page).allInnerTexts()).map((t) => t.trim());
    expect(names[0]).toContain("Usage alerts track");
    expect(names[0]).toContain(goalName);
    const none = names.findIndex((t) => t.startsWith("No track"));
    expect(none).toBeGreaterThan(0);
    expect(names.slice(0, none).every((t) => /track/.test(t))).toBe(true);
    // No goal bands and no PM-owned band.
    expect(names.some((t) => t.startsWith("PM-owned"))).toBe(false);

    const head = lanes(page).first().getByTestId("track-head");
    const health = head.getByTestId("track-health");
    await expect(health).toHaveAttribute("data-health", /^(on_track|at_risk|stale)$/);
    await health.getByTestId("track-health-tip").hover();
    await expect(health.getByRole("tooltip")).toHaveText(/^(On track: every feature ends before its milestone|At risk: .+ ends [A-Z][a-z]{2} \d{1,2}, after M\d+ .+ on [A-Z][a-z]{2} \d{1,2}|Not checked since [A-Z][a-z]{2} \d{1,2})$/);
    // Pointing at the name shows its owner and PRDs.
    await head.getByTestId("track-name-tip").hover();
    await expect(head.getByTestId("track-name-tip").locator("xpath=..").getByRole("tooltip")).toContainText("Owner:");
  });

  // Card gantt-track-head-text: protects = a Gantt Group by Track header's text is its name and
  // goal only, the hover card's owner, PRD and health reason out of it until pointed at;
  // fails_when = the header's textContent carries "Owner:", "PRD:" or the reason.
  test("a Gantt track header reads its name and goal; its hover card shows only on hover or focus", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    const group = page.getByTestId("chart-group").filter({ has: page.getByTestId("track-head") }).first();
    await expect(group).toBeVisible();
    const text = (await group.textContent()) ?? "";
    expect(text).not.toContain("Owner:");
    expect(text).not.toContain("PRD:");
    expect(text).not.toMatch(/every feature ends|ends [A-Z][a-z]{2} \d{1,2}, after|Not checked since/);
    const nameTip = group.getByTestId("track-name-tip");
    expect(text.startsWith((await nameTip.innerText()).trim())).toBe(true);
    await nameTip.hover();
    await expect(nameTip.locator("xpath=..").getByRole("tooltip")).toContainText("Owner:");
    await page.mouse.move(0, 0);
    await expect(nameTip.locator("xpath=..").getByRole("tooltip")).toBeHidden();
    // A keyboard person reads it on focus.
    await nameTip.focus();
    await expect(nameTip.locator("xpath=..").getByRole("tooltip")).toContainText("PRD:");
  });

  test("a label leads with its kind's icon and ends with its status mark; its tooltip gives kind, status and why", async ({ page }) => {
    await open(page);
    const l = label(page, "M1 Alerts live for 50 teams");
    await expect(l.getByTestId("mk-icon")).toHaveAttribute("data-kind", "sub_goal");
    await expect(l.getByTestId("ms-status")).toHaveAttribute("data-status", /^(on_track|at_risk|hit|missed)$/);
    await l.hover();
    await expect(page.getByTestId("ms-tip-kind")).toHaveText(/^Sub-goal · (On track|At risk|Hit|Missed)$/);
    await expect(page.getByTestId("ms-tip-reason")).not.toBeEmpty();
    // The legend behind the band's (i) names every kind and mark.
    await page.getByTestId("ms-legend-tip").hover();
    const legend = page.getByTestId("mk-legend");
    for (const w of ["Goal", "Sub-goal", "Delivery", "Decision", "Outside date", "Hand-off", "On track", "At risk", "Hit", "Missed"]) await expect(legend).toContainText(w);
  });

  test("the panel makes a milestone a hand-off from one track to another, kept after a reload", async ({ page }) => {
    await open(page);
    await label(page, "M1 Alerts live for 50 teams").click();
    await expect(card(page)).toBeVisible();
    await card(page).getByLabel("Kind").selectOption({ label: "Hand-off" });
    await expect(card(page).getByLabel("Measure")).toHaveCount(0);
    await card(page).getByLabel("From track").selectOption({ label: "Usage alerts track" });
    await card(page).getByLabel("To track").selectOption({ label: "Guided setup track" });
    await card(page).getByLabel("Done when").fill("Setup reads alert rules in test");
    await card(page).getByLabel("Status").selectOption({ label: "At risk" });
    await card(page).getByLabel("Why").fill("Rules API is late");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(page.getByTestId("ms-toast")).toContainText("saved");

    await page.reload();
    const l = label(page, "M1 Alerts live for 50 teams");
    await expect(l.getByTestId("mk-icon")).toHaveAttribute("data-kind", "handoff");
    await expect(l.getByTestId("ms-status")).toHaveAttribute("data-status", "at_risk");
    await l.hover();
    await expect(page.getByTestId("ms-tip-kind")).toHaveText("Hand-off · Usage alerts track → Guided setup track · At risk");
    await expect(page.getByTestId("ms-tip-reason")).toHaveText("Rules API is late");
    await l.click();
    await expect(card(page).getByLabel("Kind")).toHaveValue("handoff");
    await expect(card(page).getByLabel("From track")).toHaveValue(/.+/);
    await expect(card(page).getByLabel("Done when")).toHaveValue("Setup reads alert rules in test");
  });

  test("+ Milestone asks for the kind first; the new milestone has it", async ({ page }) => {
    await open(page);
    await page.getByTestId("zoom-6m").click();
    const axis = page.getByTestId("ms-axis").first();
    const box = (await axis.boundingBox())!;
    const seen = await axis.evaluate((el) => {
      let sc = el.parentElement;
      while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
      const r = (sc ?? document.body).getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    const from = Math.max(box.x, seen.left);
    const at = { x: from + (Math.min(box.x + box.width, seen.right) - from) * 0.6, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);
    await expect(page.getByTestId("ms-ghost-words")).toBeVisible();
    await page.mouse.click(at.x, at.y);
    const picker = page.getByTestId("ms-kind-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByTestId("ms-card")).toHaveCount(0);
    await picker.getByRole("option", { name: "Decision" }).click();
    await expect(card(page).getByLabel("Kind")).toHaveValue("decision");
    await card(page).getByLabel("Name").fill("Pick the alert sound");
    await card(page).getByLabel("Date").fill("2027-03-10");
    await card(page).getByLabel("Done when").fill("The sound is picked");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(page.getByTestId("ms-label").filter({ hasText: "Pick the alert sound" }).getByTestId("mk-icon")).toHaveAttribute("data-kind", "decision");
  });
});
