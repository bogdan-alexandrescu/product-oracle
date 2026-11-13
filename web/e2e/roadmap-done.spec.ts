import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * roadmap-done (the owner's Nov 4 rule: "this is completed and should be marked as done and
 * not included in the roadmap"), driven through the UI against the mock: an item marked
 * shipped from its talk leaves the Timeline, Gantt, Now / Next / Later and Waterfall; it is
 * kept under a collapsed "Done · N" list that opens the item; a dependency on it is satisfied,
 * so its broken links leave the strip, Needs a decision, Home and the side menu's count (Home's
 * tile also counts the other red flags with a fix, qa-simple-home-3, so it drops by as many).
 *
 * fails_when: the done item still draws a bar or card in any view, a link on it is still
 * counted anywhere, or the Done list is missing or does not open it; no_claim: the API's own
 * checks (api/tests/test_simple_roadmap_done.py).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const strip = (page: Page) => page.getByTestId("conflicts");
const tray = (page: Page) => page.getByTestId("decision-tray");
const badge = (page: Page) => page.getByTestId("simple-nav-roadmap-count").first();
const doneList = (page: Page) => page.getByTestId("done-items");

async function stripCount(page: Page): Promise<number> {
  const words = (await strip(page).innerText()).split("\n")[0];
  if (/No broken links/.test(words)) return 0;
  return Number(/(\d+) broken link/.exec(words)?.[1] ?? NaN);
}

async function trayLinks(page: Page): Promise<number> {
  await page.getByTestId("needs-decision").click();
  const tile = tray(page).getByTestId("tray-counter").filter({ hasText: "Broken links" });
  const n = Number(await tile.locator("b").innerText());
  await tray(page).getByRole("button", { name: "Close" }).click();
  return n;
}

async function badgeLinks(page: Page): Promise<number> {
  if (!(await badge(page).count())) return 0;
  const words = (await badge(page).getAttribute("aria-label")) ?? "";
  return Number(/(\d+) broken link/.exec(words)?.[1] ?? NaN);
}

async function homeLinks(page: Page): Promise<number> {
  await page.goto("/simple");
  const tile = page.getByTestId("home-summary-broken-links");
  await expect(tile).not.toContainText("–");
  return Number(await tile.locator(".simple-number").innerText());
}

async function openRoadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

test("an item marked done leaves every view, its broken links and every count, and is kept under Done", async ({ page }) => {
  await login(page);
  // Home's tile counts the strip's links and the other red flags with a fix (qa-simple-home-3).
  const home = await homeLinks(page);
  await openRoadmap(page);
  const before = await stripCount(page);
  // The links that name Alert rules engine (its dependents start before it ends).
  const onIt = await strip(page).getByTestId("conflict").filter({ hasText: "Alert rules engine" }).count();
  expect(onIt).toBeGreaterThan(0);
  await expect(doneList(page)).toHaveCount(0);

  await openRoadmapItem(page, "alert-rules");
  const card = page.getByTestId("floating-card");
  // The feature panel: a desktop's talk is beside the details, a phone's behind its tab.
  const talkTab = card.getByRole("tab", { name: "Talk to Oracle" });
  if (await talkTab.isVisible()) await talkTab.click();
  // This line's feature panel (PR 1297) opens its talk from its Talk to Oracle button on a desktop.
  else await card.getByRole("button", { name: "Talk to Oracle" }).click();
  const talk = card.getByTestId("item-talk");
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill("This is completed, it has shipped already");
  await talk.getByRole("button", { name: "Send" }).click();
  const ship = talk.getByTestId("chat-card").filter({ hasText: "Mark as already shipped" });
  await ship.getByRole("button", { name: "Apply" }).click();
  await expect(ship).toHaveAttribute("data-status", "applied");
  await expect(card.getByTestId("card-status")).toHaveText("Done");
  await page.keyboard.press("Escape");

  // Off the timeline, its links gone and every count down by them.
  await expect(page.locator('[data-testid="timeline-row"][data-item="alert-rules"]')).toHaveCount(0);
  await expect(strip(page)).not.toContainText("Alert rules engine");
  await expect.poll(() => stripCount(page)).toBe(before - onIt);
  expect(await trayLinks(page)).toBe(before - onIt);
  await expect.poll(() => badgeLinks(page)).toBe(before - onIt);

  // Kept for history under a collapsed Done list, which opens the item.
  const done = doneList(page);
  await expect(done.getByTestId("done-items-toggle")).toHaveText("Done · 1");
  await expect(done.getByTestId("done-item")).toBeHidden();
  await done.getByTestId("done-items-toggle").click();
  // The done item shows its code with its name (Ground Truth rule).
  await expect(done.getByTestId("done-item")).toHaveText(["F-86 Alert rules engine"]);
  await done.getByTestId("done-item").click();
  await expect(page.getByTestId("floating-card").getByTestId("card-status")).toHaveText("Done");
  await page.keyboard.press("Escape");

  // fix 1, minor 4: a link to the done item (?item=, as from Home or the Inbox) opens its panel
  // once, and the Done list with its row marked open.
  const id = (await done.getByTestId("done-item").getAttribute("data-bar-id"))!;
  await page.goto(`/simple/roadmap?item=${id}`);
  const linked = page.getByTestId("floating-card");
  await expect(linked.getByTestId("card-status")).toHaveText("Done");
  await expect(linked).toHaveAttribute("aria-label", "Alert rules engine");
  await expect(doneList(page).getByTestId("done-item")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(linked).toHaveCount(0);

  // Not on the Gantt, Now / Next / Later or Waterfall either.
  for (const format of ["gantt", "board", "waterfall"]) {
    await page.getByTestId(`format-${format}`).click();
    await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-item="alert-rules"]'), format).toHaveCount(0);
    await expect(page.locator('[data-item="alert-mobile"]').first(), format).toBeVisible();
    await expect(doneList(page).getByTestId("done-items-toggle")).toHaveText("Done · 1");
  }

  expect(await homeLinks(page)).toBe(home - onIt);
});

/**
 * roadmap-decide (owner, Nov 4: draft, shown live): the decider's change stays in the working
 * draft, every count reads it at once, and the banner gives the decider Approve and publish in
 * place of Send for review. fails_when: a count still reads the approved version, or the
 * decider must send the draft for review first; no_claim: who else may approve
 * (api/tests/test_simple_roadmap_done.py).
 */
test("the decider's working draft is read at once everywhere, with Approve and publish in place", async ({ page }) => {
  await login(page);
  const home = await homeLinks(page);
  await openRoadmap(page);
  const before = await stripCount(page);
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  const banner = page.getByTestId("draft-banner");
  await expect(banner).toBeVisible();
  await expect.poll(() => stripCount(page)).toBe(before - 1);
  expect(await trayLinks(page)).toBe(before - 1);
  await expect.poll(() => badgeLinks(page)).toBe(before - 1);
  await expect(banner.getByTestId("draft-next")).toContainText("Next: you approve it");
  await expect(banner.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await expect(banner.getByTestId("draft-publish")).toHaveText("Approve and publish");
  await banner.getByTestId("draft-publish").click();
  await expect(page.getByText(/Approved: .* is published/)).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => stripCount(page)).toBe(before - 1);
  expect(await homeLinks(page)).toBe(home - 1);
});
