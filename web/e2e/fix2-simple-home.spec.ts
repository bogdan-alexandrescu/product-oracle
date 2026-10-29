import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, signOut } from "./helpers";

/*
 * QA fixes on Simple's Home (desktop 1440 x 900 unless a test says phone; mock-backed, through
 * the UI only). One test per finding, each failing without its fix:
 * qa-simple-home-3, -4, -5, -9, -10, -13, -14, -15, -24, -25, -26, -27, -28, -34, -35, -36.
 * no_claim: the real API's answers (api/tests cover them); the roadmap's own review tray.
 */

const EMAILS = { owner: ADMIN.email, commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;

test.use({ viewport: { width: 1440, height: 900 } });

async function setScenario(page: Page, scenario: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
}

async function signIn(page: Page, email: string, scenario: string | null = "simple-home") {
  if (scenario) await setScenario(page, scenario);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-sentence")).toBeVisible();
}

/** The broken-links tile's number, once it has loaded. */
async function brokenTile(page: Page): Promise<number> {
  const n = page.getByTestId("home-summary-broken-links").locator(".simple-number");
  await expect(n).toHaveText(/^\d+$/);
  return Number(await n.textContent());
}

const digest = (page: Page) => page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "which it depends on" });
const mobilePush = (page: Page) => page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Mobile alert push" });

test("qa-simple-home-3: Home's sentence and its list count every broken link the tile counts", async ({ page }) => {
  // fails_when: the sentence counts only the links I decide, or the list stops at three
  await signIn(page, EMAILS.owner);
  const n = await brokenTile(page);
  expect(n).toBeGreaterThan(0);
  await expect(page.getByTestId("home-broken")).toHaveCount(n);
  const sentence = (await page.getByTestId("home-sentence").textContent()) ?? "";
  const said = [...sentence.matchAll(/(\d+) broken links?/g)].reduce((t, m) => t + Number(m[1]), 0);
  expect(said).toBe(n);
  await expect(page.getByTestId("home-broken-links").getByTestId("home-more")).toHaveCount(0);
});

test("qa-simple-home-4: a commenter's greeting names the broken links they can propose fixes for", async ({ page }) => {
  // fails_when: the greeting says "Nothing waits on you today." beside a tile of broken links
  await signIn(page, EMAILS.commenter);
  const n = await brokenTile(page);
  expect(n).toBeGreaterThan(0);
  const sentence = page.getByTestId("home-sentence");
  await expect(sentence).not.toHaveText("Nothing waits on you today.");
  await expect(sentence).toContainText(`${n} ${n === 1 ? "broken link" : "broken links"} you can propose fixes for.`);
});

test("qa-simple-home-5: after proposing a fix the broken-link row says so and offers no second Propose", async ({ page }) => {
  // fails_when: the row looks the same after Propose, so a second click sends a duplicate
  await signIn(page, EMAILS.commenter);
  await expect(digest(page).getByRole("button", { name: "Propose: Move dependents" })).toBeVisible();
  await digest(page).getByRole("button", { name: "Propose: Move dependents" }).click();
  await expect(page.getByText(/^Proposed: .+ decides?$/)).toBeVisible();
  await expect(digest(page).getByTestId("home-broken-proposed")).toHaveText(/^You proposed: Move dependents · waiting for \S.*$/);
  await expect(digest(page).getByRole("button", { name: /^Propose/ })).toHaveCount(0);
  // A new visit reads it from the proposals: still marked.
  await page.reload();
  await expect(digest(page).getByTestId("home-broken-proposed")).toContainText("You proposed: Move dependents");
  await expect(digest(page).getByRole("button", { name: /^Propose/ })).toHaveCount(0);
});

test("qa-simple-home-9: broken links have their own titled list, apart from the plan strip", async ({ page }) => {
  // fails_when: the tile jumps to the plan strip with no row called a broken link
  await signIn(page, EMAILS.owner);
  const list = page.getByTestId("home-plan").getByRole("region", { name: /^Broken links · / });
  await expect(list).toBeVisible();
  await expect(list.getByRole("heading", { level: 3 })).toHaveText(/^Broken links · .*Alerts roadmap/);
  await expect(list).toHaveAttribute("id", "broken-links");
  await expect(list.getByTestId("home-broken").first()).toBeVisible();
  await expect(page.getByTestId("home-strip").getByTestId("home-broken")).toHaveCount(0);
  await page.getByTestId("home-summary-broken-links").click();
  await expect(page).toHaveURL(/#broken-links$/);
  await expect(list.getByRole("heading", { level: 3 })).toBeInViewport();
});

test("qa-simple-home-10: a goal's weight reads as its share of the score", async ({ page }) => {
  // fails_when: a goal card shows "weight 3"
  await signIn(page, EMAILS.owner);
  const weights = page.getByTestId("home-goal-weight");
  await expect(weights.first()).toHaveText(/^\d+% of the score$/);
  await expect(weights.first()).toHaveAttribute("title", /priority score/);
  await expect(page.getByTestId("home-goals")).not.toContainText(/weight \d/);
});

test("qa-simple-home-13: Accept as risk shows pressed, asks for a reason, and saves a risk note", async ({ page }) => {
  // fails_when: the field's submit is "Accept the risk" beside the unpressed opener, with no hint
  await signIn(page, EMAILS.owner);
  const row = mobilePush(page);
  const opener = row.getByRole("button", { name: "Accept as risk" });
  await expect(opener).toHaveAttribute("aria-pressed", "false");
  await opener.click();
  await expect(opener).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByTestId("home-risk-hint")).toHaveText("Say why, in one line, to save it.");
  await expect(row.getByLabel("Why the risk is acceptable")).toHaveAccessibleDescription("Say why, in one line, to save it.");
  const save = row.getByRole("button", { name: "Save risk note" });
  await expect(save).toBeDisabled();
  await expect(row.getByRole("button", { name: "Accept the risk" })).toHaveCount(0);
  await row.getByLabel("Why the risk is acceptable").fill("Push ships behind a flag");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Risk accepted in your working draft", { exact: true })).toBeVisible();
});

test("qa-simple-home-13: a commenter's risk note is a proposal", async ({ page }) => {
  await signIn(page, EMAILS.commenter);
  const row = mobilePush(page);
  await row.getByRole("button", { name: "Propose: Accept as risk" }).click();
  await expect(row.getByRole("button", { name: "Propose risk note" })).toBeDisabled();
});

test("qa-simple-home-14: a fix's toast says what happened, and its Undo waits while hovered", async ({ page }) => {
  // fails_when: the toast reads "Move dependents: applied to your working draft", or it closes under the pointer
  await signIn(page, EMAILS.owner);
  await digest(page).getByRole("button", { name: "Move dependents", exact: true }).click();
  const toast = page.getByRole("status").filter({ hasText: "Dependents moved in your working draft" });
  await expect(toast).toHaveText(/^Dependents moved in your working draft/);
  await toast.hover();
  await page.clock.runFor(12_000);
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  // Off the toast, its time runs again.
  await page.mouse.move(5, 5);
  await page.clock.runFor(12_000);
  await expect(toast).toHaveCount(0);
});

test("qa-simple-home-14: a toast holds while focus is on its Undo", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  await digest(page).getByRole("button", { name: "Move dependents", exact: true }).click();
  const toast = page.getByRole("status").filter({ hasText: "Dependents moved in your working draft" });
  await toast.getByRole("button", { name: "Undo" }).focus();
  await page.clock.runFor(12_000);
  await expect(toast).toBeVisible();
});

test("qa-simple-home-15: since my last visit says my own change as mine and drops it once undone", async ({ page }) => {
  // fails_when: my change reads "Admin moved ..." or stays as "... · undone" with an undo row
  await signIn(page, EMAILS.owner);
  await digest(page).getByRole("button", { name: "Move dependents", exact: true }).click();
  const since = page.getByTestId("home-since");
  const rows = since.getByTestId("home-since-row").filter({ hasText: "Weekly alert digest" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(/^You moved /);
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(digest(page)).toBeVisible();
  await expect(rows).toHaveCount(0);
  for (const text of await since.getByTestId("home-since-row").allInnerTexts()) {
    expect(text).not.toContain("undone");
    expect(text).not.toContain("undid");
  }
});

test("qa-simple-home-24: one change in review reads 'until it is approved'", async ({ page }) => {
  // fails_when: "1 change is in review. You see the published plan until they are approved."
  await signIn(page, EMAILS.commenter, null);
  await digest(page).getByRole("button", { name: "Propose: Move dependents" }).click();
  await expect(page.getByText(/^Proposed: .+ decides?$/)).toBeVisible();
  await signOut(page);
  await signIn(page, EMAILS.viewer, null);
  await expect(page.getByTestId("home-in-review")).toHaveText("1 change is in review. You see the published plan until it is approved.");
});

test("qa-simple-home-25 and -36: a viewer with no name is greeted plainly, with no gap for a walk", async ({ page }) => {
  // fails_when: "Good morning, viewer." or an invisible 40 px "Walk me through it" slot for a known viewer
  await signIn(page, EMAILS.viewer);
  const lead = page.getByTestId("home-greeting").locator(".simple-lead");
  await expect(lead).toHaveText(/^Good (morning|afternoon|evening)\. Here is where the plan stands\.$/);
  await expect(page.getByTestId("home-walk-slot")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Walk me through it" })).toHaveCount(0);
  const leadBox = (await lead.boundingBox())!;
  const goals = (await page.getByTestId("home-goals").boundingBox())!;
  expect(goals.y - (leadBox.y + leadBox.height)).toBeLessThan(40);
});

test("qa-simple-home-26: Decided lately is newest first and each row opens its decision; milestone rows open their item", async ({ page }) => {
  // fails_when: the rows are in no date order, or a row is plain text
  await signIn(page, EMAILS.viewer);
  const rows = page.getByTestId("home-decided").getByTestId("home-decided-row");
  await expect(rows.first()).toBeVisible();
  const links = rows.getByRole("link");
  await expect(links).toHaveCount(await rows.count());
  for (const href of await links.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) expect(href).toMatch(/^\/simple\/decisions#d-\d+$/);
  // Each row's day ("Oct 19"), newest first.
  const days = await rows.evaluateAll((els) => els.map((e) => e.querySelector(".simple-small")?.textContent ?? ""));
  const stamps = days.map((d) => Date.parse(`${d} 2026`));
  expect(stamps.every((t) => !Number.isNaN(t))).toBe(true);
  expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  const milestone = page.getByTestId("home-next-milestone").getByTestId("home-milestone-row");
  await expect(milestone.first().getByRole("link")).toHaveAttribute("href", /^\/simple\/roadmap\?(prd|roadmap)=/);
  await links.first().click();
  await expect(page).toHaveURL(/\/simple\/decisions#d-\d+$/);
});

test("qa-simple-home-27: each card's All link is named for its card and big enough to tap", async ({ page }) => {
  // fails_when: four links are all named "All ->", or smaller than 24 px
  await signIn(page, EMAILS.owner);
  for (const name of ["All decisions", "All proposals", "All meetings", "All of the roadmap"]) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())!.height, name).toBeGreaterThanOrEqual(24);
  }
  await expect(page.getByRole("link", { name: "All ->", exact: true })).toHaveCount(0);
});

test("qa-simple-home-27: on a phone the All and more links are 44 px tall, and more names its list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, EMAILS.commenter);
  // A fourth proposal: the card shows three and "1 more".
  await digest(page).getByRole("button", { name: "Propose: Move dependents" }).click();
  await expect(page.getByText(/^Proposed: .+ decides?$/)).toBeVisible();
  const all = page.getByRole("link", { name: "All proposals", exact: true });
  await expect(all).toBeVisible();
  expect((await all.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const more = page.getByTestId("home-proposals").getByTestId("home-more");
  await expect(more).toHaveText(/^\d+ more ->$/);
  await expect(more).toHaveAccessibleName(/^\d+ more of the proposals$/);
  expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("qa-simple-home-28: Proposals' All opens the review list", async ({ page }) => {
  // fails_when: All goes to the bare roadmap, or the empty card says only "No proposals on your items."
  await signIn(page, EMAILS.owner);
  const all = page.getByRole("link", { name: "All proposals", exact: true });
  await expect(all).toHaveAttribute("href", "/simple/roadmap?review=1");
  await all.click();
  await expect(page).toHaveURL(/\/simple\/roadmap/);
  await expect(page.getByTestId("decision-tray")).toBeVisible();
});

test("qa-simple-home-28: a new company's empty proposals card says what will show there", async ({ page }) => {
  await signIn(page, EMAILS.owner, "empty");
  await expect(page.getByTestId("home-proposals-empty")).toHaveText("When someone suggests a change to your items, it shows here.");
});

test("qa-simple-home-34: a broken link's actions sit in a row, so the row hugs its text", async ({ page }) => {
  // fails_when: the fixes stack as full-height buttons, one under the other
  await signIn(page, EMAILS.owner);
  const rows = page.getByTestId("home-broken");
  await expect(rows.first()).toBeVisible();
  let checked = 0;
  for (const row of await rows.all()) {
    const buttons = row.getByTestId("home-row-actions").getByRole("button");
    if ((await buttons.count()) < 2) continue;
    const [a, b] = [(await buttons.nth(0).boundingBox())!, (await buttons.nth(1).boundingBox())!];
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(2);
    expect(b.x).toBeGreaterThan(a.x);
    checked += 1;
  }
  expect(checked).toBeGreaterThan(0);
  expect(await rows.first().getByTestId("home-row-actions").evaluate((e) => getComputedStyle(e).flexDirection)).toBe("row");
});

test("qa-simple-home-35: on a phone the three counts sit in one compact row", async ({ page }) => {
  // fails_when: the tiles stack as full-width 90 px blocks
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, EMAILS.owner);
  const tiles = ["decisions", "proposals", "broken-links"].map((id) => page.getByTestId(`home-summary-${id}`));
  await expect(tiles[2].locator(".simple-number")).toHaveText(/^\d+$/);
  const boxes = await Promise.all(tiles.map(async (t) => (await t.boundingBox())!));
  for (const b of boxes) {
    expect(Math.abs(b.y - boxes[0].y)).toBeLessThanOrEqual(1);
    expect(b.width).toBeLessThan(140);
  }
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
  expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
