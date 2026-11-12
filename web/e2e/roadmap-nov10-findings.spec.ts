import { MOCK_FAIL_ONCE_KEY, MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { ADMIN, login, openRoadmapItem, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner's Roadmap (Simple > Roadmap), Nov 10, rebuilt on the mock's invented people and
 * products.
 *
 * - tracks-move-pointer: protects = Move up pressed twice at the same point moves the track up
 *   twice; Move to Trash never comes under the pointer after a move, and the pressed button
 *   keeps focus; fails_when = the second press lands on Move to Trash (a track is trashed or
 *   asks to be); no_claim = the track order's API (api/tests/test_simple_track_order.py).
 * - tracks-draft-count: protects = a track's "N features" counts what the reader's Roadmap
 *   shows: features moved onto a new track in the working draft count on it for the owner,
 *   while a viewer, who reads the published Roadmap, keeps the published counts;
 *   fails_when = the count reads another version than the Roadmap beside it;
 *   no_claim = the API (api/tests/test_simple_tracks_draft_count.py).
 * - tracks-trash-draft: protects = Move to Trash asks about what it moves for the reader: a
 *   track the draft moved every feature off still asks, naming the features on it in the
 *   published Roadmap, and a track holding features only in the draft moves them to No track
 *   there, Undo putting them back; fails_when = it trashes at once with no question, or the
 *   draft keeps its features on the track in Trash; no_claim = the API
 *   (api/tests/test_simple_tracks_draft_count.py).
 * - gantt-pm-lane-measure: protects = on the Gantt grouped by Goal the PM-owned lane has no
 *   goal measure line, while a goal's lane keeps its own; fails_when = it shows a goal's
 *   measure; no_claim = the Timeline's track bands.
 * - panel-track-at-once: protects = the feature panel's Track shows the picked track at once
 *   on Save, and the old one again when the change fails; fails_when = it keeps the old track
 *   until the Roadmap reads again; no_claim = the toast's words.
 */

const sheet = (page: Page) => page.getByTestId("tracks-sheet");
const row = (page: Page, title: string) => sheet(page).getByTestId("track-row").filter({ has: page.getByText(title, { exact: true }) });
const panel = (page: Page) => page.getByTestId("floating-card");
const toasts = (page: Page) => page.getByTestId("toasts");

async function roadmap(page: Page, email = ADMIN.email) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const titles = (page: Page) => sheet(page).getByTestId("track-row").locator("p.font-medium").allTextContents();

test.describe("Roadmap findings, Nov 10", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Move up pressed twice at the same point moves the track twice and trashes nothing", async ({ page }) => {
    await roadmap(page);
    await page.getByTestId("tracks-open").click();
    // A fourth track, so the last one moves up twice.
    await sheet(page).getByTestId("track-add").click();
    await sheet(page).getByLabel("New track name").fill("Partner care track");
    await sheet(page).getByLabel("New track PRD").selectOption({ label: "No PRD" });
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Partner care track");
    await expect(sheet(page).getByTestId("track-row")).toHaveCount(4);
    const before = await titles(page);
    expect(before.at(-1)).toBe("Partner care track");

    await sheet(page).getByRole("button", { name: "Change Partner care track" }).click();
    const up = row(page, "Partner care track").getByRole("button", { name: "Move up" });
    const box = (await up.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await expect.poll(() => titles(page)).toEqual([...before.slice(0, 2), "Partner care track", before[2]]);
    await expect(row(page, "Partner care track").getByRole("button", { name: "Move up" })).toBeEnabled();
    // The same point again: Move up, never Move to Trash.
    await page.mouse.click(x, y);
    await expect(sheet(page).getByTestId("track-trash-confirm")).toHaveCount(0);
    await expect.poll(() => titles(page)).toEqual([before[0], "Partner care track", before[1], before[2]]);
    await expect(sheet(page).getByTestId("track-row")).toHaveCount(4);
    await expect(toasts(page)).not.toContainText("to Trash");
    // The pressed button stays under the pointer, and keeps focus.
    await expect(row(page, "Partner care track").getByRole("button", { name: "Move up" })).toBeFocused();
    const under = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("button")?.textContent?.trim() ?? null, [x, y] as const);
    expect(under).toBe("Move up");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 4");
  });

  test("a track's feature count is what the Roadmap beside it shows, the working draft for the owner", async ({ page }) => {
    test.setTimeout(120_000);
    await roadmap(page);
    await page.getByTestId("tracks-open").click();
    await sheet(page).getByTestId("track-add").click();
    await sheet(page).getByLabel("New track name").fill("Partner care track");
    await sheet(page).getByLabel("New track PRD").selectOption({ label: "No PRD" });
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Partner care track");
    await expect(row(page, "Partner care track")).toContainText("0 features");
    await expect(row(page, "Usage alerts track")).toContainText("5 features");
    await page.getByRole("button", { name: "Close Tracks" }).click();

    // Five features moved onto it in the feature panel: the owner's working draft.
    for (const key of ["alert-rules", "alert-digest", "alert-mobile", "alert-export", "alert-sso"]) {
      await openRoadmapItem(page, key);
      await expect(panel(page)).toBeVisible();
      await panel(page).getByRole("button", { name: "Change the track" }).click();
      await panel(page).getByTestId("card-track-edit").getByLabel("Track").selectOption({ label: "Partner care track" });
      await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
      await expect(panel(page).getByTestId("card-track")).toHaveText("Partner care track");
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
    }
    await page.getByTestId("tracks-open").click();
    await expect(row(page, "Partner care track")).toContainText("5 features");
    await expect(row(page, "Usage alerts track")).toContainText("0 features");

    // A viewer reads the published Roadmap: the five are still on Usage alerts track there.
    await page.getByRole("button", { name: "Close Tracks" }).click();
    await signOut(page);
    await roadmap(page, "viewer@example.com");
    await page.getByTestId("tracks-open").click();
    await expect(row(page, "Usage alerts track")).toContainText("5 features");
    await expect(row(page, "Partner care track")).toContainText("0 features");
  });

  test("Move to Trash asks about what it moves, the draft's features and the published ones", async ({ page }) => {
    test.setTimeout(120_000);
    await roadmap(page);
    await page.getByTestId("tracks-open").click();
    await sheet(page).getByTestId("track-add").click();
    await sheet(page).getByLabel("New track name").fill("Partner care track");
    await sheet(page).getByLabel("New track PRD").selectOption({ label: "No PRD" });
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Partner care track");
    await page.getByRole("button", { name: "Close Tracks" }).click();
    const keys = ["alert-rules", "alert-digest", "alert-mobile", "alert-export", "alert-sso"];
    for (const key of keys) {
      await openRoadmapItem(page, key);
      await panel(page).getByRole("button", { name: "Change the track" }).click();
      await panel(page).getByTestId("card-track-edit").getByLabel("Track").selectOption({ label: "Partner care track" });
      await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
      await expect(panel(page).getByTestId("card-track")).toHaveText("Partner care track");
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
    }
    // The draft moved every feature off Usage alerts track, but the published Roadmap still has
    // five on it: Move to Trash asks first and says so.
    await page.getByTestId("tracks-open").click();
    await expect(row(page, "Usage alerts track")).toContainText("0 features");
    await row(page, "Usage alerts track").getByRole("button", { name: "Change Usage alerts track" }).click();
    await row(page, "Usage alerts track").getByRole("button", { name: "Move to Trash" }).click();
    await expect(sheet(page).getByTestId("track-trash-confirm")).toHaveText(/5 features still on it in the published Roadmap move to No track\./);
    await sheet(page).getByTestId("track-trash-confirm").getByRole("button", { name: "Cancel" }).click();
    await expect(row(page, "Usage alerts track")).toBeVisible();

    // Partner care track holds five only in the draft: they move to No track there.
    await row(page, "Partner care track").getByRole("button", { name: "Change Partner care track" }).click();
    await row(page, "Partner care track").getByRole("button", { name: "Move to Trash" }).click();
    await expect(sheet(page).getByTestId("track-trash-confirm")).toHaveText(/Its 5 features move to No track\./);
    await sheet(page).getByTestId("track-trash-confirm").getByRole("button", { name: "Move to Trash" }).click();
    await expect(toasts(page)).toContainText("Moved Partner care track to Trash · 5 features now have no track");
    await expect(row(page, "Partner care track")).toHaveCount(0);
    await toasts(page).getByRole("button", { name: "Undo" }).first().click();
    await expect(row(page, "Partner care track")).toContainText("5 features");
    await page.getByRole("button", { name: "Close Tracks" }).click();
    await openRoadmapItem(page, "alert-rules");
    await expect(panel(page).getByTestId("card-track")).toHaveText("Partner care track");
  });

  test("the Gantt grouped by Goal draws no goal measure under the PM-owned lane", async ({ page }) => {
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await roadmap(page);
    await page.getByTestId("format-gantt").click();
    await page.getByTestId("group-goal").click();
    const lane = (title: string) => page.getByTestId("chart-group").filter({ has: page.locator("span", { hasText: new RegExp(`^${title}$`) }) });
    // Launch email is PM-owned work; it is put on Grow retention, a goal with a measure.
    await page.getByRole("button", { name: /^Launch email:/ }).click();
    await panel(page).getByRole("button", { name: "Change the goal" }).click();
    await panel(page).getByRole("combobox", { name: "Goal" }).selectOption({ label: "Grow retention (measured by Teams active after 90 days)" });
    await panel(page).getByRole("button", { name: "Save" }).click();
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Grow retention");
    await page.keyboard.press("Escape");
    // The PM-owned lane is no goal: no goal's measure under its name.
    await expect(lane("PM-owned")).toHaveCount(1);
    await expect(lane("PM-owned").getByTestId("group-metric")).toHaveCount(0);
  });

  test("the feature panel's Track shows the new track at once on Save, and the old one again when it fails", async ({ page }) => {
    await roadmap(page);
    // The change answers late: what the panel shows before it is the panel's own.
    await page.evaluate(([k, v, msKey]) => (localStorage.setItem(k, v), localStorage.setItem(msKey, "4000")), [MOCK_SLOW_KEY, "POST /v1/simple/changes", MOCK_SLOW_MS_KEY] as const);
    await openRoadmapItem(page, "setup-import");
    await expect(panel(page).getByTestId("card-track")).toHaveText("Guided setup track");
    await panel(page).getByRole("button", { name: "Change the track" }).click();
    await panel(page).getByTestId("card-track-edit").getByLabel("Track").selectOption({ label: "Usage alerts track" });
    await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
    await expect(panel(page).getByTestId("card-track")).toHaveText("Usage alerts track", { timeout: 1500 });
    await expect(toasts(page)).toContainText("Track changed");
    await expect(panel(page).getByTestId("card-track")).toHaveText("Usage alerts track");

    // A change that fails puts the shown track back.
    await page.evaluate(([slow, k, v]) => (localStorage.removeItem(slow), localStorage.setItem(k, v)), [MOCK_SLOW_KEY, MOCK_FAIL_ONCE_KEY, "POST /v1/simple/changes"] as const);
    await panel(page).getByRole("button", { name: "Change the track" }).click();
    await panel(page).getByTestId("card-track-edit").getByLabel("Track").selectOption({ label: "Guided setup track" });
    await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
    await expect(toasts(page)).toContainText("Mock failure");
    await expect(panel(page).getByTestId("card-track")).toHaveText("Usage alerts track");
  });
});
