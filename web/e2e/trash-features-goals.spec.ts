import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * trash-features-goals (owner's pick, Nov 4): a roadmap feature and a goal deleted to Trash are
 * listed in Settings › Trash beside documents (their kind in words, their name, who deleted them,
 * the days left), and Restore puts each back where it was. The screens that delete them are still
 * being drawn, so the delete is made through the mock API's own routes (as the API would get it);
 * Settings › Trash, and every other step a screen offers, is driven as a person would.
 * A row's Delete feature (Gantt, Timeline, Priorities) is driven in trash-feature-rows.spec.ts; the feature panel's own Delete comes later.
 *
 * Card tfg-list-restore: protects = Settings › Trash lists "Feature <name>" and "Goal <name>"
 * with "Deleted by" and "30 days left"; Restore on each takes it out of Trash and the roadmap and
 * the goal buckets read it again; fails_when = either kind is missing from Trash, a bare kind
 * name ("feature") shows, or Restore leaves it out of its page's read; no_claim = the delete
 * screens (not drawn yet).
 *
 * Card tfg-code-links (review round 2): protects = the feature's row reads its code before its
 * name ("F-26 Alert rules engine"); a goal deleted with its features moved to another goal gets
 * every feature's goals back exactly on Restore; fails_when = the code is missing or a feature
 * keeps the goal it was moved to, or loses the restored one; no_claim = the API's own links (pytest).
 *
 * Card tfg-deleter-restores (owner's answer, Nov 5: "Whoever deleted it, too"): protects = an
 * approver (the pricing roadmap's decider) who deleted a feature and a goal finds Settings › Trash, sees both there with Restore
 * (and not what an owner deleted) and restores each without an owner; fails_when = the approver
 * has no Trash tab, no Restore, sees the owner's delete, or Restore is refused; no_claim = other
 * approvers (the API's tests).
 *
 * Card tfg-restore-after-version (review round 3): protects = a feature deleted before another
 * edit is submitted and approved (review round 4: by the required reviewer) shows on Simple's roadmap again after Restore in Settings › Trash;
 * fails_when = Restore empties the Trash row and the feature stays off the roadmap (review round 4:
 * the mock keeps each roadmap's published versions with the features in Trash when each was made,
 * so a Restore that leaves the newer version alone fails here); no_claim = the API's copy onto
 * versions waiting for approval (pytest test_restore_after_a_new_version_puts_the_feature_on_the_
 * current_roadmap and test_restore_reaches_a_version_proposed_from_a_detailed_change_set).
 */

type Call = { status: number; body: unknown };

async function call(page: Page, method: string, path: string, body?: unknown): Promise<Call> {
  return page.evaluate(
    async ([method, path, body]) => {
      const w = globalThis as unknown as { __poMockFetch?: (r: Request) => Promise<Response> };
      const init = body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
      const res = await w.__poMockFetch!(new Request(new URL(path, location.origin), init));
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body] as const,
  );
}

type Item = { id: string; title: string; code: string | null; can_decide: boolean };
type Goal = { id: string; title: string };

async function items(page: Page): Promise<Item[]> {
  return ((await call(page, "GET", "/v1/simple/roadmap")).body as { items: Item[] }).items;
}

async function goals(page: Page): Promise<Goal[]> {
  return ((await call(page, "GET", "/v1/simple/goal-buckets")).body as { goals: Goal[] }).goals;
}

async function links(page: Page): Promise<Record<string, string[]>> {
  const out = (await call(page, "GET", "/v1/simple/goal-buckets")).body as { features: { id: string; goal_ids: string[] }[] };
  return Object.fromEntries(out.features.map((f) => [f.id, f.goal_ids]));
}

test("a deleted feature and goal are listed in Settings › Trash and restored from there", async ({ page }) => {
  await login(page);
  const feature = (await items(page)).find((i) => i.can_decide && i.code)!;
  const [goal, other] = await goals(page);
  expect(feature && goal && other).toBeTruthy();
  const before = await links(page);
  expect(Object.values(before).some((ids) => ids[0] === goal.id)).toBe(true);

  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${feature.id}`)).status).toBe(200);
  expect((await call(page, "DELETE", `/v1/simple/goal-buckets/goals/${goal.id}?to_goal_id=${other.id}`)).status).toBe(200);
  expect((await items(page)).map((i) => i.id)).not.toContain(feature.id);
  expect((await goals(page)).map((g) => g.id)).not.toContain(goal.id);

  await page.goto("/settings/trash");
  const entries = page.getByTestId("trash-entry");
  const featureRow = entries.filter({ hasText: feature.title });
  const goalRow = entries.filter({ hasText: goal.title });
  await expect(featureRow).toContainText("Feature");
  await expect(featureRow).toContainText(`${feature.code} ${feature.title}`);
  await expect(featureRow).toContainText("Deleted by");
  await expect(featureRow).toContainText("30 days left");
  await expect(goalRow).toContainText("Goal");
  await expect(goalRow).toContainText("30 days left");
  await expect(entries.filter({ hasText: /\bfeature\b|\bgoal\b/ })).toHaveCount(0);

  await page.getByRole("button", { name: `Restore ${feature.title}` }).click();
  await expect(featureRow).toHaveCount(0);
  await page.getByRole("button", { name: `Restore ${goal.title}` }).click();
  await expect(goalRow).toHaveCount(0);

  expect((await items(page)).map((i) => i.id)).toContain(feature.id);
  expect((await goals(page)).map((g) => g.id)).toContain(goal.id);
  // The features the delete moved to the other goal serve the restored one again, as before.
  expect(await links(page)).toEqual(before);
});

test("whoever deleted a feature or a goal sees it in Trash and restores it, with no owner", async ({ page }) => {
  // Dana Decider, an approver, decides the pricing roadmap's features ("simple-deciders").
  await page.addInitScript((key) => localStorage.setItem(key, "simple-deciders"), MOCK_SCENARIO_KEY);
  // An owner deletes a feature: it is the owners' to restore, so the approver never sees it.
  await login(page);
  const theirs = (await items(page)).find((i) => i.can_decide)!;
  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${theirs.id}`)).status).toBe(200);

  await signOut(page);
  await login(page, "dana.decider@example.com");
  const feature = (await items(page)).find((i) => i.can_decide && i.id !== theirs.id)!;
  const [goal, other] = await goals(page);
  expect(feature && goal && other).toBeTruthy();
  const deleted = await call(page, "DELETE", `/v1/simple/roadmap/items/${feature.id}`);
  expect(deleted.status).toBe(200);
  expect((deleted.body as { can_restore: boolean }).can_restore).toBe(true);
  expect((await call(page, "DELETE", `/v1/simple/goal-buckets/goals/${goal.id}?to_goal_id=${other.id}`)).status).toBe(200);

  await page.goto("/settings");
  await page.getByTestId("nav-trash").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/settings\/trash$/);
  const entries = page.getByTestId("trash-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.filter({ hasText: theirs.title })).toHaveCount(0);
  const featureRow = entries.filter({ hasText: feature.title });
  const goalRow = entries.filter({ hasText: goal.title });
  await expect(featureRow).toContainText("Feature");
  await expect(goalRow).toContainText("Goal");

  await featureRow.getByRole("button", { name: `Restore ${feature.title}` }).click();
  await expect(featureRow).toHaveCount(0);
  await goalRow.getByRole("button", { name: `Restore ${goal.title}` }).click();
  await expect(goalRow).toHaveCount(0);
  await expect(page.getByTestId("trash-empty")).toBeVisible();

  expect((await items(page)).map((i) => i.id)).toContain(feature.id);
  expect((await goals(page)).map((g) => g.id)).toContain(goal.id);
  expect((await items(page)).map((i) => i.id)).not.toContain(theirs.id);
});

/** The alerts roadmap's required reviewer ("trash-reviewer"), who approves its drafts. */
const REVIEWER = "avery.lane@example.com";

/** Signs in as the alerts roadmap's required reviewer and approves the Alerts roadmap's draft in
 * review (the version is published), and stays signed in as them. This branch has no screen for a
 * reviewer's approval of a roadmap draft yet (Home's waiting list for it is on the AN line): the
 * mock API's route, as the draft rules' pytest does. */
async function approveOnHome(page: Page) {
  await signOut(page);
  await login(page, REVIEWER);
  await page.goto("/simple");
  const drafts = (await call(page, "GET", "/v1/simple/drafts")).body as { id: string; status: string; document: { title: string } }[];
  const draft = drafts.find((d) => d.status === "submitted" && d.document.title === "Alerts roadmap")!;
  expect(draft).toBeTruthy();
  const approved = await call(page, "POST", `/v1/simple/drafts/${draft.id}/approve`);
  expect(approved.status).toBe(200);
  expect((approved.body as { status: string }).status).toBe("approved");
}

/** Moves `key`'s bar on the Timeline a step later: one change in the open draft. */
async function moveBar(page: Page, key: string) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  const count = page.getByTestId("draft-count");
  const before = (await count.count()) ? await count.textContent() : null;
  await page.locator(`[data-testid="timeline-row"][data-item="${key}"] [data-testid="timeline-bar"]`).focus();
  await page.keyboard.press("ArrowRight");
  await expect(count).not.toHaveText(before ?? "");
}

async function sendForReview(page: Page) {
  await page.getByTestId("draft-banner").getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent for review" })).toBeVisible();
}

type RoadmapItem = Item & { key: string; roadmap: { slug: string } };

async function alerts(page: Page): Promise<RoadmapItem[]> {
  const all = (await call(page, "GET", "/v1/simple/roadmap")).body as { items: RoadmapItem[] };
  return all.items.filter((i) => i.roadmap.slug === "alerts-roadmap");
}

test("a feature deleted before the roadmap's next version is published comes back on it from Trash", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "trash-reviewer"), MOCK_SCENARIO_KEY);
  await login(page);
  const mine = await alerts(page);
  const feature = mine.find((i) => i.can_decide && i.code)!;
  const other = mine.find((i) => i.can_decide && i.id !== feature?.id)!;
  expect(feature && other).toBeTruthy();
  // No screen deletes a feature yet (the queued feature-panel lane adds Delete): the mock API's route.
  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${feature.id}`)).status).toBe(200);

  // Another feature's dates moved on the Timeline and the draft sent for review.
  await moveBar(page, other.key);
  const roadmap = page.getByTestId("simple-roadmap");
  await expect(roadmap).not.toContainText(feature.title);
  await sendForReview(page);
  // The required reviewer's approval on Home publishes the next version, made without the
  // feature in Trash.
  await approveOnHome(page);
  await signOut(page);
  await login(page);

  await page.goto("/settings/trash");
  const row = page.getByTestId("trash-entry").filter({ hasText: feature.title });
  await row.getByRole("button", { name: `Restore ${feature.title}` }).click();
  await expect(row).toHaveCount(0);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(feature.title);
  await expect(roadmap).toContainText(other.title);
});

/*
 * Card tfg-draft-only (review round 4): protects = a feature added in the open draft (never
 * approved), deleted, and restored while the draft is in review is back in the draft only: a
 * viewer, who reads the published roadmap, does not see it; once the required reviewer approves
 * the draft on Home it is on the roadmap; fails_when = Restore puts it on the published roadmap,
 * the draft waits on no one, or the approval loses it; no_claim = the API's copy onto the version
 * in review (pytest test_a_feature_only_in_the_draft_is_restored_to_the_draft_only).
 */
test("a feature added in the draft and restored while the draft is in review stays off the published roadmap until approved", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "trash-reviewer"), MOCK_SCENARIO_KEY);
  await login(page);
  const other = (await alerts(page)).find((i) => i.can_decide)!;
  const title = "Quiet hours digest";
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await page.getByLabel("Add an item").fill(title);
  await page.getByTestId("quick-add-roadmap").selectOption({ label: "Alerts roadmap" });
  const chip = page.getByTestId("quick-add-chip");
  await expect(chip).toHaveAttribute("aria-disabled", "false");
  await page.evaluate(() => window.scrollTo(0, 0));
  const target = page.locator('[data-testid="quarter-drop"][data-add-where="quarter:2027-Q1"]');
  const from = (await chip.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, Math.min(to.y + 20, (page.viewportSize()?.height ?? 800) - 12), { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: `Added ${title} as a draft` })).toBeVisible();
  const added = (await alerts(page)).find((i) => i.title === title)!;
  expect(added).toBeTruthy();
  // No screen deletes a feature yet (the queued feature-panel lane adds Delete): the mock API's route.
  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${added.id}`)).status).toBe(200);

  await moveBar(page, other.key);
  const roadmap = page.getByTestId("simple-roadmap");
  await expect(roadmap).not.toContainText(title);
  await sendForReview(page);

  await page.goto("/settings/trash");
  const row = page.getByTestId("trash-entry").filter({ hasText: title });
  await row.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(row).toHaveCount(0);
  // Back in the draft, which its owner reads.
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(title);

  // A viewer reads the published roadmap: it is not there.
  await signOut(page);
  await login(page, "vic.moss@example.com");
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(other.title);
  await expect(roadmap).not.toContainText(title);

  // Approved on Home, it is on the roadmap.
  await approveOnHome(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(title);
});

/*
 * Card tfg-draft-approved (review round 6): protects = a feature added in the open draft and
 * deleted, its draft then sent and approved while it is in Trash, is still in Settings › Trash;
 * Restore puts it in the roadmap's working draft (a new one), not on the published roadmap: a
 * viewer does not see it, its owner does; once that draft is sent and approved on Home it is on
 * the roadmap; fails_when = the approval loses it (no Trash row, or Restore refused), Restore puts
 * it on the published roadmap, or the new draft cannot be sent with it; no_claim = the API's rows
 * (pytest test_a_feature_only_in_the_draft_is_restored_to_the_draft_only[draft_approved]).
 */
test("a feature added in the draft and restored after the draft was approved without it comes back in a new draft", async ({ page }) => {
  // Two drafts sent and approved, with sign-ins between: past the default 30 s.
  test.slow();
  await page.addInitScript((key) => localStorage.setItem(key, "trash-reviewer"), MOCK_SCENARIO_KEY);
  await login(page);
  const other = (await alerts(page)).find((i) => i.can_decide)!;
  const title = "Quiet hours digest";
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await page.getByLabel("Add an item").fill(title);
  await page.getByTestId("quick-add-roadmap").selectOption({ label: "Alerts roadmap" });
  const chip = page.getByTestId("quick-add-chip");
  await expect(chip).toHaveAttribute("aria-disabled", "false");
  await page.evaluate(() => window.scrollTo(0, 0));
  const target = page.locator('[data-testid="quarter-drop"][data-add-where="quarter:2027-Q1"]');
  const from = (await chip.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, Math.min(to.y + 20, (page.viewportSize()?.height ?? 800) - 12), { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: `Added ${title} as a draft` })).toBeVisible();
  const added = (await alerts(page)).find((i) => i.title === title)!;
  expect(added).toBeTruthy();
  // No screen deletes a feature yet (the queued feature-panel lane adds Delete): the mock API's route.
  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${added.id}`)).status).toBe(200);

  // The draft sent and approved on Home while the feature is in Trash.
  await moveBar(page, other.key);
  const roadmap = page.getByTestId("simple-roadmap");
  await expect(roadmap).not.toContainText(title);
  await sendForReview(page);
  await approveOnHome(page);
  await signOut(page);
  await login(page);

  // Still in Trash, and Restore brings it back.
  await page.goto("/settings/trash");
  const row = page.getByTestId("trash-entry").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(row).toHaveCount(0);
  // In the roadmap's new working draft, which its owner reads.
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(title);

  // A viewer reads the published roadmap: it is not there.
  await signOut(page);
  await login(page, "vic.moss@example.com");
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(other.title);
  await expect(roadmap).not.toContainText(title);

  // The new draft is sent with it and, approved on Home, it is on the roadmap.
  await signOut(page);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await sendForReview(page);
  await approveOnHome(page);
  await signOut(page);
  await login(page, "vic.moss@example.com");
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await expect(roadmap).toContainText(title);
});
