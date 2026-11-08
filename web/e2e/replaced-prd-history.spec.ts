import { AREA_PRDS, OLD_PRD, OLD_ROADMAP, ONE_ROADMAP_SCENARIO, REPLACED_PRD_TRASH_SCENARIO } from "../lib/api/mock/one-roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * replaced-prd-history (the owner, Nov 7): an old PRD replaced by newer PRDs comes back from
 * Trash as read-only history only. Against the mock's "replaced-prd-trash" scenario (invented
 * data): Trust plan, replaced by User Safety and Scale, sits in Trash with its own roadmap, whose
 * draft was sent for approval and whose track is Trust track; the Product roadmap has one working
 * draft. Restoring Trust plan in Settings > Trash leaves Simple's roadmap with that one draft,
 * Tracks with its count and the Inbox with its count; Trust plan opens read-only from User Safety.
 */

const [SAFETY] = AREA_PRDS;

/** "Tracks · N" on Simple's roadmap, and its sheet without Trust track. */
async function tracks(page: Page): Promise<string> {
  const open = page.getByTestId("tracks-open");
  await expect(open).toHaveText(/^Tracks · \d+$/);
  const words = (await open.textContent()) ?? "";
  await open.click();
  await expect(page.getByTestId("track-row").first()).toBeVisible();
  await expect(page.getByTestId("track-row").filter({ hasText: "Trust track" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  return words;
}

async function inboxCount(page: Page): Promise<string> {
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge").filter({ visible: true }).first();
  await expect(badge).toHaveText(/^\d+$/);
  return (await badge.textContent()) ?? "";
}

/** Simple's roadmap: one working draft banner, the Product roadmap's, never the old roadmap's. */
async function oneDraft(page: Page) {
  await page.goto("/simple/roadmap");
  const banner = page.getByTestId("draft-banner");
  await expect(banner).toHaveCount(1);
  await expect(banner.getByTestId("draft-words")).toContainText("Your working draft ·");
  await expect(banner.getByTestId("draft-count")).toHaveText("1");
  await expect(banner).not.toContainText(OLD_ROADMAP[1]);
}

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * protects = restoring a replaced PRD brings back no second working draft, track or Inbox row,
 * and the old PRD is read-only history reached from its replacement; fails_when = the old
 * roadmap's draft shows on Simple's roadmap ("Your working drafts · 2 roadmaps"), Tracks counts
 * Trust track, the Inbox counts its approval, or User Safety does not link Trust plan;
 * no_claim = the Trash list itself (trash-features-goals.spec.ts).
 */
test("a replaced PRD restored from Trash is read-only history", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, REPLACED_PRD_TRASH_SCENARIO] as const);
  await login(page);

  // The same reads before and after (a first Simple read seeds Oracle's goal suggestions).
  await oneDraft(page);
  const shown = await tracks(page);
  const inbox = await inboxCount(page);

  await page.goto("/settings/trash");
  const row = page.getByTestId("trash-entry").filter({ hasText: OLD_PRD[1] });
  await expect(row).toContainText("Replaced by User Safety and Scale");
  await page.getByRole("button", { name: `Restore ${OLD_PRD[1]}` }).click();
  await expect(row).toHaveCount(0);

  await oneDraft(page);
  await expect(page.getByTestId("draft-publish")).toHaveCount(1);
  expect(await tracks(page)).toBe(shown);

  expect(await inboxCount(page)).toBe(inbox);
  await expect(page.getByRole("main")).not.toContainText(OLD_ROADMAP[1]);

  // Its replacement links it; it opens read-only, naming the PRDs that replaced it.
  await page.goto(`/documents/${SAFETY[0]}`);
  await page.getByTestId("replaces").getByRole("link", { name: OLD_PRD[1], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${OLD_PRD[0]}$`));
  await expect(page.getByTestId("replaced-by")).toContainText("Replaced by User Safety and Scale");
  await expect(page.getByRole("button", { name: "Build roadmap" })).toHaveCount(0);
  // Its roadmap is read-only history too.
  await page.goto(`/documents/${OLD_ROADMAP[0]}`);
  await expect(page.getByTestId("replaced-by")).toContainText("Replaced by User Safety and Scale");
});

/**
 * protects = a replaced PRD and its roadmap offer no Approve or Publish (the API refuses both with
 * 409): the roadmap's unsent v2 shows no Approve, the PRD's open v2 no Publish link, and its Publish
 * screen says why in plain words in place of the button; the roadmap's page shows a short
 * "Read-only" tick, the reason in its tooltip; fails_when = Approve version or Publish shows on
 * either, or the Publish screen offers "Publish v2"; no_claim = the API's refusals
 * (test_replaced_prd_history_api.py).
 */
test("a replaced PRD and its roadmap show no Approve or Publish", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, ONE_ROADMAP_SCENARIO] as const);
  await login(page);

  // The history roadmap's unsent version: no Approve version.
  await page.goto(`/documents/${OLD_ROADMAP[0]}/v/2`);
  await expect(page.getByTestId("doc-discuss").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("approve-version")).toHaveCount(0);
  await expect(page.getByTestId("publish-link")).toHaveCount(0);

  // The replaced PRD's open draft: no Publish link.
  await page.goto(`/documents/${OLD_PRD[0]}/v/2`);
  await expect(page.getByTestId("doc-discuss").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("publish-link")).toHaveCount(0);
  await expect(page.getByTestId("approve-version")).toHaveCount(0);

  // Its Publish screen says why, in place of a button that would fail.
  await page.goto(`/documents/${OLD_PRD[0]}/publish`);
  await expect(page.getByTestId("publish-read-only")).toHaveText(`${OLD_PRD[1]} is replaced and read-only`);
  await expect(page.getByTestId("publish-button")).toHaveCount(0);

  // The roadmap's page: a short Read-only tick, the reason in its tooltip, not on the page.
  await page.goto(`/documents/${OLD_ROADMAP[0]}`);
  const tick = page.getByTestId("replaced-by").getByRole("button", { name: "Read-only" });
  await expect(tick).toBeVisible();
  await expect(page.getByText("Read-only: its items no longer feed the roadmap.")).toHaveCount(0);
  await tick.hover();
  await expect(page.getByRole("tooltip")).toContainText(`${OLD_ROADMAP[1]} is the roadmap of a replaced PRD and read-only`);
});
