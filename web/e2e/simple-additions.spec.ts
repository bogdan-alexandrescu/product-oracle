import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple S7 (#723): quick add, Oracle's suggested features for a goal, reconcile (Merge,
 * Keep both) and a real merge, driven through the UI against the mock
 * (web/lib/api/mock/simple-changes.ts add_item / merge_item / keep_both,
 * simple-suggestions.ts). Invented data: Keep alerts quiet has no items and two features
 * Oracle suggested on its own; Grow retention has one a person asked for. A quick-added
 * draft titled "Alert digest for admins" looks like alert-digest (Weekly alert digest).
 * Desktop 1366x820 and phone 390x844, light and dark, as an owner (applies), an approver
 * and a commenter (propose) and a viewer (reads).
 */

const ROADMAP = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const TWIN = "Alert digest for admins";
const TWIN_KEY = "alert-digest-for-admins";

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const column = (page: Page, h: string): Locator => page.locator(`[data-testid="board-column"][data-horizon-column="${h}"]`);
const toastWith = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });

async function openRoadmap(page: Page, email?: string) {
  await login(page, email);
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  // A phone's Timeline (timeline-overlap B3) draws thin lanes, not bars.
  if (page.viewportSize()!.width > 640) await expect(bar(page, "alert-rules")).toBeVisible();
  else await expect(page.getByTestId("phone-lane").first()).toBeVisible();
}

/** A lane's key on the Timeline (timeline-overlap B2), by its title. */
const laneOf = (page: Page, title: string) => page.getByTestId("chart-group").filter({ hasText: title }).getAttribute("data-lane");

async function board(page: Page) {
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
}

/** Types a title in Quick add and drags its chip onto `target` with the mouse, as a person does. */
async function dragAdd(page: Page, title: string, target: Locator, at: "top" | "middle" = "middle") {
  await page.getByLabel("Add an item").fill(title);
  // All roadmaps and more than one: quick add asks which (the Roadmap filter's spec).
  await page.getByTestId("quick-add-roadmap").selectOption({ label: "Alerts roadmap" });
  const chip = page.getByTestId("quick-add-chip");
  await expect(chip).toHaveAttribute("aria-disabled", "false");
  // The chip and the target's top on screen together (the page's top).
  await page.evaluate(() => window.scrollTo(0, 0));
  const from = (await chip.boundingBox())!;
  const to = (await target.boundingBox())!;
  const bottom = (page.viewportSize()?.height ?? 800) - 12;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, Math.min(at === "top" ? to.y + 20 : to.y + to.height / 2, bottom), { steps: 12 });
  await page.mouse.up();
}

/** A phone's Add: the sheet with the title and where. */
async function sheetAdd(page: Page, title: string, where: string, button: "Add" | "Propose") {
  await page.getByTestId("quick-add-open").click();
  const sheet = page.getByRole("dialog", { name: "Add an item" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByLabel("Roadmap").selectOption({ label: "Alerts roadmap" });
  await sheet.getByLabel("Where").selectOption({ label: where });
  await sheet.getByRole("button", { name: button, exact: true }).click();
  await expect(sheet).toBeHidden();
}

async function noSidewaysScroll(page: Page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
}

async function switchTo(page: Page, email: string, path = ROADMAP) {
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.goto(path);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await page.context().addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
    });

    /**
     * Card simple-additions-quarter: protects = an owner types a title in Quick add and drags
     * its chip onto a timeline quarter column; the add applies at once as a draft (a dashed
     * bar, a "Draft" tag, "Oracle is drafting…" until Oracle's drafting job is done, then an
     * outcome, a flow and a date suggestion in that quarter), with "Added <title> as a draft ·
     * Undo", and Undo removes it; fails_when = the drop target is ignored, the draft is not
     * drawn, the drafting state never shows or never ends, the suggestion falls outside the
     * quarter, or Undo leaves the item; no_claim = the real drafting job's content (the API's
     * own tests), pixel placement.
     */
    test("an owner drags a quick add onto a quarter, sees Oracle draft it, and undoes it", async ({ page }) => {
      await openRoadmap(page);
      await dragAdd(page, "Quiet hours setting", page.locator('[data-testid="quarter-drop"][data-add-where="quarter:2027-Q1"]'), "top");
      await expect(toastWith(page, "Added Quiet hours setting as a draft")).toBeVisible();
      const b = bar(page, "quiet-hours-setting");
      await expect(b).toHaveAttribute("data-kind", "draft");
      // B2: the draft's pill says so ("Draft · Quiet hours setting").
      await expect(b.getByTestId("draft-tag")).toHaveText("Draft");
      await toastWith(page, "Added Quiet hours setting as a draft").getByRole("button", { name: "Undo" }).click();
      await expect(b).toHaveCount(0);

      await dragAdd(page, "Quiet hours setting", page.locator('[data-testid="quarter-drop"][data-add-where="quarter:2027-Q1"]'), "top");
      await expect(b).toHaveAttribute("data-kind", "draft");
      await b.locator("rect[data-body]").click();
      const card = page.getByTestId("floating-card");
      await expect(card.getByTestId("draft-tag")).toHaveText("Draft");
      await expect(card.getByTestId("item-drafting")).toHaveText("Oracle is drafting…");
      await expect(card.getByTestId("item-flow-none")).toHaveText("No flow yet");
      await expect(card.getByTestId("item-drafting")).toHaveCount(0, { timeout: 10_000 });
      await expect(card.getByTestId("card-outcome")).toContainText("Teams get quiet hours setting");
      await expect(page.locator('[data-testid="suggestion-outline"][data-item="quiet-hours-setting"]')).toBeAttached();
      await card.getByTestId("item-flow-thumb").click();
      await expect(card).toHaveAttribute("data-wide", "true");
      await expect(card.getByTestId("flow-detail")).toContainText("User flow: Quiet hours setting");
    });

    /**
     * Card simple-additions-merge: protects = a draft dropped on a Now / Next / Later column
     * that looks like an item says "Looks like <code> <title>" on its card and in the
     * 'Needs a decision' tray; Merge closes it as "Merged into <code>" below the line (the
     * kept item gets a note), Undo brings the draft back, and Keep both clears the match;
     * fails_when = the match is missing, Merge is a cut or writes nothing, Undo does not
     * restore it, or Keep both leaves the match; no_claim = Oracle's real duplicate matching
     * (the mock matches shared words).
     */
    test("an owner drops a draft on a column, merges the look-alike, undoes, and keeps both", async ({ page }) => {
      await openRoadmap(page);
      await board(page);
      await dragAdd(page, TWIN, column(page, "later"));
      await expect(toastWith(page, `Added ${TWIN} as a draft`)).toBeVisible();
      const c = boardCard(page, TWIN_KEY);
      await expect(column(page, "later").locator(`[data-item="${TWIN_KEY}"]`)).toBeVisible();
      await expect(c.getByTestId("draft-tag")).toHaveText("Draft");
      await expect(c.getByTestId("board-looks-like")).toHaveText("Looks like F-06 Weekly alert digest");

      await page.getByTestId("needs-decision").click();
      const tray = page.getByTestId("decision-tray");
      const twin = tray.getByTestId("tray-twin").filter({ hasText: TWIN });
      await expect(twin.getByTestId("looks-like-match").first()).toContainText("Looks like Weekly alert digest");
      await twin.getByTestId("looks-like-match").first().getByRole("button", { name: "Merge" }).click();
      await expect(toastWith(page, `Merged '${TWIN}' into Weekly alert digest in your working draft`)).toBeVisible();
      await tray.getByRole("button", { name: "Close" }).click();
      await expect(column(page, "later").getByTestId("board-below").locator(`[data-item="${TWIN_KEY}"]`)).toBeVisible();
      await expect(c.getByTestId("item-merged")).toHaveText("Merged into alert-digest");
      await boardCard(page, "alert-digest").click();
      await expect(page.getByTestId("floating-card").getByTestId("card-reasons")).toContainText(`Merged ${TWIN} (${TWIN_KEY}) into it.`);
      await page.getByTestId("floating-card").getByRole("button", { name: "Close" }).click();

      await toastWith(page, "Merged").getByRole("button", { name: "Undo" }).click();
      await expect(c.getByTestId("item-merged")).toHaveCount(0);
      await expect(c.getByTestId("board-looks-like")).toBeVisible();
      await c.click();
      const card = page.getByTestId("floating-card");
      await card.getByRole("button", { name: "Keep both" }).click();
      await expect(toastWith(page, /Kept 'Alert digest for admins' and Weekly alert digest/)).toBeVisible();
      await expect(c.getByTestId("board-looks-like")).toHaveCount(0);
      await expect(c.getByTestId("draft-tag")).toBeVisible();
    });

    /**
     * Card simple-additions-goal-drop: protects = a chip dropped on a goal's header adds the
     * draft under that goal; fails_when = it lands under another goal or none; no_claim =
     * the horizon chosen for a goal drop (the API's).
     */
    test("an owner drops a quick add on a goal header", async ({ page }) => {
      await openRoadmap(page);
      await dragAdd(page, "Team usage report", page.getByTestId("chart-group").filter({ hasText: "Faster activation" }));
      await expect(toastWith(page, "Added Team usage report as a draft")).toBeVisible();
      // B2: its pill sits in the Faster activation lane.
      await expect(bar(page, "team-usage-report")).toBeVisible();
      expect(await bar(page, "team-usage-report").getAttribute("data-lane")).toBe(await laneOf(page, "Faster activation"));
    });

    /**
     * Card simple-additions-suggestions-owner: protects = the tray's "Suggested features"
     * shows Oracle's suggestions with outcome, why, evidence with confidence and a flow;
     * Accept adds the feature as a draft on its goal (the empty goal gets its first item)
     * with Undo, which reopens the suggestion; Reject asks an optional reason and the
     * suggestion leaves; fails_when = a field is missing, Accept writes nothing or is not
     * undone, or Reject keeps it; no_claim = the real suggestion job's ideas.
     */
    test("an owner accepts, undoes and rejects suggested features in the tray", async ({ page }) => {
      await openRoadmap(page);
      await expect(page.getByTestId("goal-counter-empty")).toContainText("Keep alerts quiet");
      await page.getByTestId("needs-decision").click();
      const tray = page.getByTestId("decision-tray");
      const quiet = tray.locator('[data-testid="goal-suggestion"][data-title="Quiet hours for alerts"]');
      await expect(tray.getByTestId("goal-suggestion")).toHaveCount(3);
      await expect(quiet.getByTestId("suggestion-outcome")).toHaveText("Teams set hours when no alert pushes");
      await expect(quiet.getByTestId("suggestion-why")).toContainText("Most mutes happen at night");
      await expect(quiet.getByTestId("suggestion-evidence")).toContainText("12 requests for night-time silence");
      await expect(quiet.getByTestId("suggestion-evidence")).toContainText("high confidence");
      await quiet.getByRole("button", { name: "Show the flow" }).click();
      await expect(quiet).toHaveAttribute("data-wide", "true");
      await expect(quiet.getByTestId("flow-detail")).toBeVisible();
      await quiet.getByRole("button", { name: "Accept" }).click();
      await expect(toastWith(page, "Added Quiet hours for alerts as a draft")).toBeVisible();
      await expect(tray.getByTestId("goal-suggestion")).toHaveCount(2);
      await expect(page.getByTestId("goal-counter-empty")).toHaveCount(0);
      await expect(bar(page, "quiet-hours-for-alerts")).toHaveAttribute("data-kind", "draft");
      await toastWith(page, "Added Quiet hours for alerts as a draft").getByRole("button", { name: "Undo" }).click();
      await expect(bar(page, "quiet-hours-for-alerts")).toHaveCount(0);
      await expect(tray.getByTestId("goal-suggestion")).toHaveCount(3);

      const bundle = tray.locator('[data-testid="goal-suggestion"][data-title="Alert bundling per rule"]');
      await bundle.getByRole("button", { name: "Reject" }).click();
      const dialog = page.getByRole("dialog", { name: "Reject Alert bundling per rule" });
      await dialog.getByLabel("Why (optional)").fill("We bundle in the digest already");
      await dialog.getByRole("button", { name: "Reject" }).click();
      await expect(toastWith(page, "Rejected Alert bundling per rule: Oracle will not suggest it again")).toBeVisible();
      await expect(bundle).toHaveCount(0);
    });

    /**
     * Card simple-additions-suggest: protects = "✦ Ask Oracle for more" in a goal's panel
     * (opened from the goal's card over the chart: roadmap-milestones D draws no button on the
     * chart's goal row) asks Oracle, the panel says "Oracle is suggesting features…" while the
     * job runs, then shows 3 new suggestions; fails_when = no job, the pending line never shows
     * or never ends, or the suggestions do not arrive; no_claim = the number Oracle proposes
     * for real (3-5).
     */
    test("an owner asks Oracle to suggest features for a goal from its card", async ({ page }) => {
      await openRoadmap(page);
      await page.getByTestId("goal-counter").filter({ hasText: "Faster activation" }).getByTestId("goal-counter-suggestions").click();
      const panel = page.getByTestId("goal-panel");
      await expect(panel).toBeVisible();
      await panel.getByRole("tab", { name: "✦ Oracle · 0" }).click();
      await expect(panel.getByTestId("goal-suggestion")).toHaveCount(0);
      await panel.getByRole("button", { name: "✦ Ask Oracle for more" }).click();
      await expect(panel.getByTestId("suggest-pending")).toHaveText("Oracle is suggesting features…");
      await expect(panel.getByTestId("goal-suggestion")).toHaveCount(3, { timeout: 10_000 });
      await expect(panel.getByTestId("suggest-pending")).toHaveCount(0);
      await expect(panel).toContainText("Connect a source in one click");
    });

    /**
     * Card simple-additions-approver: protects = an approver's quick add and Accept are
     * proposals (nothing is drawn until the owner accepts the "Add an item" proposal in the
     * tray); an approver reads a goal's suggestions without Accept / Reject (the decider's);
     * fails_when = an approver's add applies, an approver sees Accept or Reject, or the owner cannot accept the proposal; no_claim =
     * routing to a named decider (simple-deciders.spec).
     */
    test("an approver proposes a quick add the owner accepts in the tray", async ({ page }) => {
      await openRoadmap(page, "approver@example.com");
      await board(page);
      await dragAdd(page, "Rule import from a file", column(page, "next"));
      await expect(toastWith(page, "Proposed Rule import from a file (Next): it waits for the roadmap's owner in Needs a decision")).toBeVisible();
      await expect(boardCard(page, "rule-import-from-a-file")).toHaveCount(0);
      await page.getByRole("button", { name: "Suggested features for Grow retention", exact: true }).first().click();
      // Only the decider accepts or rejects a goal's suggestions (pick D): an approver reads them.
      const panel = page.getByTestId("goal-panel");
      await panel.getByRole("tab", { name: "✦ Oracle · 1" }).click();
      await expect(panel.getByTestId("goal-suggestion")).toHaveCount(1);
      await expect(panel.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Reject" })).toHaveCount(0);
      await panel.getByRole("button", { name: "Close" }).click();

      await switchTo(page, "admin@example.com");
      await expect(bar(page, "alert-rules")).toBeVisible();
      await page.getByTestId("needs-decision").click();
      const tray = page.getByTestId("decision-tray");
      const p = tray.getByTestId("tray-proposal").filter({ hasText: "Rule import from a file" });
      await expect(p).toContainText("add an item");
      await p.getByRole("button", { name: "Accept" }).click();
      await expect(toastWith(page, "Accepted: it is in your working draft")).toBeVisible();
      await tray.getByRole("button", { name: "Close" }).click();
      await expect(bar(page, "rule-import-from-a-file")).toHaveAttribute("data-kind", "draft");
    });

    /**
     * Card simple-additions-viewer: protects = a viewer sees no quick add, no drop targets'
     * effect and no Accept, Reject, form or Ask Oracle for more, but reads the suggestions; fails_when
     * = any of them shows; no_claim = the API's 403s (its tests).
     */
    test("a viewer reads suggestions and cannot add or accept", async ({ page }) => {
      await openRoadmap(page, "viewer@example.com");
      await expect(page.getByTestId("quick-add")).toHaveCount(0);
      await expect(page.getByTestId("quick-add-open")).toHaveCount(0);
      await page.getByTestId("goal-counter-empty").getByTestId("goal-counter-suggestions").click();
      const panel = page.getByTestId("goal-panel");
      await expect(panel.getByTestId("suggest-form")).toHaveCount(0);
      await panel.getByRole("tab", { name: "✦ Oracle · 2" }).click();
      await expect(panel.getByTestId("goal-suggestion")).toHaveCount(2);
      await expect(panel.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Reject" })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "✦ Ask Oracle for more" })).toHaveCount(0);
    });

    /**
     * Card simple-additions-priorities: protects = Priorities' goal buckets show a goal's
     * one Suggestions button whose drawer has Ask Oracle for more and Accept; Merge on an unranked draft is a real
     * merge (merge_item): the roadmap shows the draft "Merged into <code>"; fails_when = the
     * bucket lacks the suggestions, or Merge is a cut on the roadmap; no_claim = bucket shares.
     */
    test("priorities: a bucket's suggestion is accepted and Merge merges the draft", async ({ page }) => {
      await login(page);
      await page.goto("/simple/priorities?tab=buckets");
      const bucket = page.locator('[data-testid="goal-bucket"][data-key="grow-retention"]');
      await bucket.getByRole("button", { name: "Suggestions for Grow retention" }).click();
      const drawer = page.getByTestId("goal-panel");
      await drawer.getByRole("tab", { name: "✦ Oracle · 1" }).click();
      const s = drawer.locator('[data-testid="goal-suggestion"][data-title="Alert templates for new teams"]');
      await expect(s).toBeVisible();
      await expect(drawer.getByRole("button", { name: "✦ Ask Oracle for more" })).toBeVisible();
      await s.getByRole("button", { name: "Accept" }).click();
      await expect(toastWith(page, "Added Alert templates for new teams as a draft")).toBeVisible();
      await expect(s).toHaveCount(0);
      await drawer.getByRole("button", { name: "Close" }).click();

      await page.goto("/simple/priorities");
      const draft = page.locator('[data-testid="prio-draft"][data-code="setup-ideas"]');
      await draft.getByRole("button", { name: "Merge into…" }).click();
      await draft.getByLabel("Merge into").selectOption({ label: "Setup checklist" });
      await draft.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(toastWith(page, "Merged Team invite nudges into Setup checklist")).toBeVisible();
      await page.goto(ROADMAP);
      await board(page);
      await expect(boardCard(page, "setup-ideas").getByTestId("item-merged")).toHaveText("Merged into setup-checklist");
    });
  });

  test.describe(`phone, ${scheme}`, () => {
    test.use({ ...PHONE, colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await page.context().addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
    });

    /**
     * Card simple-additions-phone-owner: protects = on a phone an owner's Add opens a sheet
     * with Title and Where; Add applies the draft (Undo in the toast), its card is a bottom
     * sheet with the Draft tag, and once drafted its flow opens as a full-height sheet; the
     * page never scrolls sideways; fails_when = no Add button or sheet, the button reads
     * Propose for an owner, the draft is missing, or the widened card is not full height;
     * no_claim = drag on a phone (the sheet replaces it).
     */
    test("an owner adds from the sheet and opens the drafted flow full height", async ({ page }) => {
      await openRoadmap(page);
      await expect(page.getByTestId("quick-add")).toHaveCount(0);
      await sheetAdd(page, "Mute a rule for a week", "Next", "Add");
      await expect(toastWith(page, "Added Mute a rule for a week as a draft")).toBeVisible();
      // B3: the draft is listed in its lane (No goal) with its Draft tag; its row opens the card.
      await page.getByTestId("phone-lane").filter({ hasText: "No goal" }).click();
      const row = page.locator('[data-testid="lane-row"][data-item="mute-a-rule-for-a-week"]');
      await expect(row.getByTestId("draft-tag")).toHaveText("Draft");
      await noSidewaysScroll(page);
      await row.click();
      const card = page.getByTestId("floating-card");
      await expect(card).toHaveAttribute("data-sheet", "bottom");
      await expect(card.getByTestId("draft-tag")).toHaveText("Draft");
      await expect(card.getByTestId("item-flow-thumb")).toBeVisible({ timeout: 10_000 });
      await card.getByTestId("item-flow-thumb").click();
      await expect(card).toHaveAttribute("data-wide", "true");
      const box = (await card.boundingBox())!;
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(840);
    });

    /**
     * Card simple-additions-phone-commenter: protects = a commenter's sheet says Propose and
     * proposes; on the empty goal's tile the suggestions open in a sheet where the commenter
     * reads Oracle's (no Accept or Reject: the decider's) and its flow opens full height;
     * fails_when = a commenter's add applies, or Accept or Reject shows to a commenter;
     * no_claim = who the proposal is routed to.
     */
    test("a commenter proposes from the sheet and reads a goal's suggestions", async ({ page }) => {
      await openRoadmap(page, "commenter@example.com");
      await sheetAdd(page, "Pause alerts on holidays", "Keep alerts quiet", "Propose");
      await expect(toastWith(page, "Proposed Pause alerts on holidays (Keep alerts quiet): it waits for the roadmap's owner in Needs a decision")).toBeVisible();
      await expect(page.locator('[data-item="pause-alerts-on-holidays"]')).toHaveCount(0);
      await page.getByTestId("goal-counter-empty").getByTestId("goal-counter-suggestions").click();
      const sheet = page.getByTestId("goal-panel");
      await sheet.getByRole("tab", { name: "✦ Oracle · 2" }).click();
      const s = sheet.locator('[data-testid="goal-suggestion"][data-title="Quiet hours for alerts"]');
      await expect(s.getByRole("button", { name: "Reject" })).toHaveCount(0);
      await expect(s.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await s.getByRole("button", { name: "Show the flow" }).click();
      const flow = page.getByTestId("flow-sheet").getByRole("dialog");
      const box = (await flow.boundingBox())!;
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(840);
      await flow.getByRole("button", { name: /close/i }).first().click();
      await noSidewaysScroll(page);
    });

    /**
     * Card simple-additions-phone-home: protects = Home's goal band shows each goal's
     * suggested features; the panel suggests more and an owner accepts one; fails_when = the
     * band lacks the suggestions or Accept writes nothing; no_claim = the band's other parts
     * (simple-home.spec).
     */
    test("Home's goal band opens a goal's suggestions and an owner accepts one", async ({ page }) => {
      await page.context().addInitScript((key) => localStorage.setItem(key, "simple-home"), MOCK_SCENARIO_KEY);
      await login(page);
      await page.goto("/simple");
      const quiet = page.getByTestId("home-goal").filter({ hasText: "Keep alerts quiet" });
      await expect(quiet.getByTestId("goal-suggestions-open")).toHaveText("Suggestions · 2");
      await quiet.getByTestId("goal-suggestions-open").click();
      const panel = page.getByTestId("goal-panel");
      await panel.getByRole("tab", { name: "✦ Oracle · 2" }).click();
      await panel.locator('[data-testid="goal-suggestion"][data-title="Quiet hours for alerts"]').getByRole("button", { name: "Accept" }).click();
      await expect(toastWith(page, "Added Quiet hours for alerts as a draft")).toBeVisible();
      await expect(panel.getByTestId("goal-suggestion")).toHaveCount(1);
      await panel.getByRole("button", { name: "✦ Ask Oracle for more" }).click();
      await expect(panel.getByTestId("goal-suggestion")).toHaveCount(4, { timeout: 10_000 });
      await noSidewaysScroll(page);
    });
  });
}
