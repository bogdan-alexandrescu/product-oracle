import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * roadmap-decide (the owner's Nov 4 rule: a person always sees what is happening to a roadmap
 * shared with them, every change it needs can be made in the UI, and acting on a prompt removes
 * or updates it at once, everywhere), driven through the UI against the mock:
 *
 * - acting on a broken link drops the page's strip, Needs a decision, Home's tile and the side
 *   menu's Roadmap count together; the panel no longer apologises that the counts differ;
 * - a cut item others depend on offers Bring it back and Remove the dependency, each into the
 *   working draft with Undo, and is never listed as starting before what it depends on ends;
 * - every line of the draft's change list names its item;
 * - the draft banner says what happens next and who acts, with that person's button (Approve);
 * - a change asked of a PRD is its owner's to Approve / Decline on the chip and in Proposals;
 * - review fix 1: under a filter a cut item offers Remove the dependency for every dependent,
 *   one the filter hides too, and it applies when the dependent also waits on an item the
 *   filter hides; the strip says "N here, M in all" with Clear filters, and Needs a decision
 *   and the side menu count all M; the banner names the required reviewers still to come
 *   before Approve and publish, and shows each working draft's own step.
 *
 * fails_when: a count stays, a prompt stays after acting, a fix is missing, a line has no
 * item, or the owner has no action; no_claim: the API's own rules
 * (api/tests/test_simple_roadmap_decide.py).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page, scenario?: string) {
  if (scenario)
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const strip = (page: Page) => page.getByTestId("conflicts");
const tray = (page: Page) => page.getByTestId("decision-tray");
const badge = (page: Page) => page.getByTestId("simple-nav-roadmap-count").first();

/** The strip's own count ("⚠ 2 broken links"; 0 for "No broken links"). */
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

/** The side menu's Roadmap count says how many broken links it holds. */
async function badgeLinks(page: Page): Promise<number> {
  const words = (await badge(page).getAttribute("aria-label")) ?? "";
  return Number(/(\d+) broken link/.exec(words)?.[1] ?? NaN);
}

async function homeLinks(page: Page): Promise<number> {
  await page.goto("/simple");
  const tile = page.getByTestId("home-summary-broken-links");
  await expect(tile).not.toContainText("–");
  return Number(await tile.locator(".simple-number").innerText());
}

test.use(DESKTOP);

test("acting on a broken link drops the strip, Needs a decision, Home and the side menu together", async ({ page }) => {
  await open(page);
  const before = await stripCount(page);
  expect(before).toBeGreaterThan(0);
  expect(await trayLinks(page)).toBe(before);
  await expect.poll(() => badgeLinks(page)).toBe(before);
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-scope")).not.toContainText("can differ");
  await tray(page).getByRole("button", { name: "Close" }).click();
  expect(await homeLinks(page)).toBe(before);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect(page.getByText(/Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();
  // The prompt leaves at once, without a reload; every count drops with it.
  await expect(strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]')).toHaveCount(0);
  await expect.poll(() => stripCount(page)).toBe(before - 1);
  expect(await trayLinks(page)).toBe(before - 1);
  await expect.poll(() => badgeLinks(page)).toBe(before - 1);
  expect(await homeLinks(page)).toBe(before - 1);
});

test("the draft's change list names the item on every line, and the banner says who acts next", async ({ page }) => {
  await open(page);
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  const banner = page.getByTestId("draft-banner");
  // roadmap-decide (owner, Nov 4: draft, shown live): the decider approves and publishes in place.
  await expect(banner.getByTestId("draft-next")).toContainText("Next: you approve it");
  await expect(banner).not.toContainText("no approved version yet");
  await banner.getByRole("button", { name: "See changes" }).click();
  const rows = banner.getByTestId("draft-changes").locator("li");
  await expect(rows.first()).toContainText("Move the dependents: Weekly alert digest");
  for (const row of await rows.all()) await expect(row).toContainText(/: \S/);
  await expect(banner.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await banner.getByTestId("draft-publish").click();
  await expect(page.getByText(/Approved: .* is published/)).toBeVisible();
});

async function cutKeepingDependents(page: Page, key: string) {
  await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await card.getByRole("button", { name: "Talk to Oracle" }).click();
  const talk = card.getByTestId("item-talk");
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill("cut it");
  await talk.getByRole("button", { name: "Send" }).click();
  await talk.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" }).getByRole("button", { name: "Cut it, keep the dependents" }).click();
  await card.getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
}

test("a cut item others depend on: Bring it back, or Remove the dependency, each with Undo", async ({ page }) => {
  await open(page, "roadmap-talk");
  await cutKeepingDependents(page, "alert-rules");
  const cut: Locator = strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]');
  await expect(cut).toContainText("Cut, but");
  await expect(cut.getByRole("button", { name: "Bring it back" })).toBeVisible();
  // A cut item is never listed as starting before what it depends on ends.
  await expect(strip(page)).not.toContainText("‘Alert rules engine’ starts");
  const removes = cut.getByRole("button", { name: /^Remove the dependency/ });
  const n = await removes.count();
  expect(n).toBeGreaterThan(0);
  await removes.first().click();
  await expect(page.getByText(/Removed the dependency of ‘.*’ on ‘Alert rules engine’/)).toBeVisible();
  if (n === 1) await expect(cut).toHaveCount(0);
  else await expect(cut.getByRole("button", { name: /^Remove the dependency/ })).toHaveCount(n - 1);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(cut.getByRole("button", { name: /^Remove the dependency/ })).toHaveCount(n);
  await cut.getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByText("Brought back 'Alert rules engine'", { exact: false })).toBeVisible();
  await expect(cut).toHaveCount(0);
});

test("under a filter, every dependent of a cut item can drop it, and every count reads the whole roadmap", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-talk-two-deps"] as const);
  await login(page);
  // The Grow retention goal: Alert SLA report shows, Reliability work (which it also waits on) and Uptime alerts do not.
  await page.goto("/simple/roadmap?goal=grow-retention");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.locator('[data-testid="timeline-row"][data-item="alert-sla"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="timeline-row"][data-item="uptime-alerts"]')).toHaveCount(0);
  await cutKeepingDependents(page, "alert-rules");
  const cut = strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]');
  await expect(cut).toContainText("Cut, but");
  // Uptime alerts is out of this view, yet it depends on the cut item: its button is there.
  await expect(cut.getByRole("button", { name: "Remove the dependency of ‘Uptime alerts’" })).toBeVisible();
  await cut.getByRole("button", { name: "Remove the dependency of ‘Alert SLA report’" }).click();
  await expect(page.getByText("Removed the dependency of ‘Alert SLA report’ on ‘Alert rules engine’", { exact: false })).toBeVisible();
  await expect(cut.getByRole("button", { name: "Remove the dependency of ‘Alert SLA report’" })).toHaveCount(0);
  await expect(cut.getByRole("button", { name: "Remove the dependency of ‘Uptime alerts’" })).toBeVisible();
  // One number everywhere: the side menu, the strip's "in all" and Needs a decision count the whole roadmap.
  const all = strip(page).getByTestId("conflicts-all");
  await expect(all).toContainText(/\d+ in all/);
  const whole = Number(/(\d+) in all/.exec(await all.innerText())![1]);
  expect(whole).toBeGreaterThan(await stripCount(page));
  await expect.poll(() => badgeLinks(page)).toBe(whole);
  expect(await trayLinks(page)).toBe(whole);
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-links-here")).toContainText(`1 of the ${whole} broken links is in these filters`);
  await tray(page).getByRole("button", { name: "Close" }).click();
  await all.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator('[data-testid="timeline-row"][data-item="uptime-alerts"]')).toHaveCount(1);
  await expect(strip(page).getByTestId("conflicts-all")).toHaveCount(0);
  await expect.poll(() => stripCount(page)).toBe(whole);
});

test("Approve and publish names the required reviewers still to come before the click", async ({ page }) => {
  await open(page, "roadmap-reviewers");
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  const banner = page.getByTestId("draft-banner");
  await expect(banner.getByTestId("draft-next")).toContainText("Next: you approve it, then Priya Raman reviews it. When they approve, version");
  await banner.getByTestId("draft-publish").click();
  await expect(page.getByText(/Approved: .* waits for 1 more reviewer/)).toBeVisible();
  await expect(banner.getByTestId("draft-next")).toContainText("it waits for Priya Raman to approve");
});

test("with two working drafts, the banner has a line per draft: its roadmap, its own next step, its own button", async ({ page }) => {
  await open(page, "roadmap-two-drafts");
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect(page.getByText(/Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();
  // Guided setup's roadmap, which Priya Raman decides: the owner sends its draft for review.
  await strip(page).locator('[data-testid="conflict"][data-item="setup-tour"]').getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByText(/Brought back 'In-app tour'/)).toBeVisible();
  const banner = page.getByTestId("draft-banner");
  const lines = banner.getByTestId("draft-line");
  await expect(lines).toHaveCount(2);
  const alerts = lines.filter({ hasText: "Alerts roadmap" });
  const onboarding = lines.filter({ hasText: "Onboarding roadmap" });
  await expect(alerts.getByTestId("draft-next")).toContainText("Next: you approve it");
  await expect(alerts.getByRole("button", { name: "Approve and publish" })).toBeVisible();
  await expect(alerts.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await expect(onboarding.getByTestId("draft-next")).toContainText("Next: you send it for review.");
  await expect(onboarding.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
  await onboarding.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText(/Sent for review/).first()).toBeVisible();
  // Sent, the line says so with its own step: Priya Raman decides it, so it waits for her (as the
  // API has it, the owner who sent it does not approve it); no Send for review is left, disabled or not.
  await expect(onboarding.getByTestId("draft-next")).toContainText("Sent for review: it waits for Priya Raman to approve");
  await expect(onboarding.getByTestId("draft-next")).not.toContainText("your approval");
  await expect(onboarding.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(banner.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await alerts.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText(/Approved: Alerts roadmap is published/)).toBeVisible();
});

test("Home's Open draft to approve opens the Roadmap on that draft", async ({ page }) => {
  await open(page, "roadmap-two-drafts");
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect(page.getByText(/Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();
  await strip(page).locator('[data-testid="conflict"][data-item="setup-tour"]').getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByText(/Brought back 'In-app tour'/)).toBeVisible();
  await page.goto("/simple");
  await page.getByTestId("home-draft").filter({ hasText: "Alerts roadmap" }).getByRole("link", { name: "Open draft to approve" }).click();
  await expect(page).toHaveURL(/\/simple\/roadmap\?draft=/);
  const focused = page.getByTestId("draft-banner").locator('[data-testid="draft-line"][data-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText("Alerts roadmap");
  await expect(focused.getByRole("button", { name: "Approve and publish" })).toBeFocused();
});

test("a change asked of a PRD is its owner's to approve: on the chip and under Proposals", async ({ page }) => {
  await open(page, "simple-prd-milestones");
  await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
  const prd = page.getByTestId("ms-prd-card");
  await prd.getByLabel("Date").fill("2027-01-05");
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  const chip = page.getByTestId("ms-asked");
  await expect(chip).toHaveText("Asked the PRD: move M2 Digest for all teams to Jan 5 · waits for Nora Vance");
  // The company's owner decides it: listed under Needs a decision > Proposals.
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-proposal").filter({ hasText: "PRD milestone ‘Digest for all teams’" })).toBeVisible();
  await tray(page).getByRole("button", { name: "Close" }).click();
  await chip.click();
  const decide = page.getByTestId("ms-asked-decide");
  await expect(decide.getByRole("button", { name: "Decline" })).toBeVisible();
  await decide.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved: M2 Digest for all teams moves to Jan 5 in the PRD")).toBeVisible();
  await expect(chip).toHaveCount(0);
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-proposal").filter({ hasText: "PRD milestone" })).toHaveCount(0);
});

test("milestone labels and the PRD ask keep to their header row: none covers another or a bar, at every zoom", async ({ page }) => {
  await open(page, "simple-prd-milestones");
  await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
  const prd = page.getByTestId("ms-prd-card");
  await prd.getByLabel("Date").fill("2027-01-05");
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-asked")).toBeVisible();
  for (const zoom of ["6m", "1y", "all"]) {
    await page.getByTestId(`zoom-${zoom}`).click();
    await expect(page.getByTestId(`zoom-${zoom}`)).toHaveAttribute("aria-pressed", "true");
    const hits = await page.evaluate(() => {
      const box = (e: Element) => e.getBoundingClientRect();
      const meet = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const labels = [...document.querySelectorAll("[data-ms-label]")].filter((e) => (e as HTMLElement).style.visibility !== "hidden");
      const bars = [...document.querySelectorAll('[data-testid="timeline-bar"]')];
      const out: string[] = [];
      labels.forEach((a, n) => {
        const ra = box(a);
        if (ra.height > 24) out.push(`${a.textContent} wraps`);
        for (const b of labels.slice(n + 1)) if (meet(ra, box(b))) out.push(`${a.textContent} / ${b.textContent}`);
        for (const b of bars) if (meet(ra, box(b))) out.push(`${a.textContent} / ${b.getAttribute("aria-label")}`);
      });
      return out;
    });
    expect(hits, zoom).toEqual([]);
  }
});

test("an item with no dates of its own says so beside its bar when the bar has no room for its dates", async ({ page }) => {
  await open(page);
  await page.getByTestId("zoom-all").click();
  const row = (key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);
  await expect(row("setup-video").getByTestId("bar-no-dates")).toHaveText("No dates yet");
  await expect(row("alert-rules").getByTestId("bar-no-dates")).toHaveCount(0);
});

/** How many lines a cut flag's sentence takes. */
async function sentenceLines(row: Locator): Promise<number> {
  return row.locator("button").first().evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
}

test("a cut flag with many fixes keeps its sentence to two lines, its fixes on their own line under it, at 1440 and 390", async ({ page }) => {
  await open(page, "roadmap-talk-two-deps");
  await cutKeepingDependents(page, "alert-rules");
  const cut = strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]');
  await expect(cut).toContainText("Cut, but");
  // Bring it back, a Remove the dependency per dependent (four) and Accept as risk.
  await expect(cut.getByRole("button", { name: /^Remove the dependency of/ })).toHaveCount(4);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
    await expect.poll(() => sentenceLines(cut)).toBeLessThanOrEqual(2);
    // The fixes sit under the sentence, not beside it.
    const words = (await cut.locator("button").first().boundingBox())!;
    const fixes = (await cut.getByTestId("fixes").boundingBox())!;
    expect(fixes.y).toBeGreaterThanOrEqual(words.y + words.height - 1);
    // Every fix stays inside the strip.
    const box = (await strip(page).boundingBox())!;
    for (const b of await cut.getByTestId("fixes").getByRole("button").all()) {
      const r = (await b.boundingBox())!;
      expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
  }
});

test("an approver's proposed Remove the dependency says who it waits for and is not offered again", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-talk-own-decider"] as const);
  // Names answer late: the line holds its "waits for" until it knows whom, never "its decider".
  await page.addInitScript(([key, value, msKey]) => {
    localStorage.setItem(key, value);
    localStorage.setItem(msKey, "4000");
  }, [MOCK_SLOW_KEY, "/v1/people", MOCK_SLOW_MS_KEY] as const);
  await login(page, "approver@example.com");
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await cutKeepingDependents(page, "alert-rules");
  const cut = strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]');
  await expect(cut).toContainText("Cut, but");
  const propose = cut.getByRole("button", { name: /^Propose: remove the dependency/ }).first();
  const label = (await propose.innerText()).trim();
  await propose.click();
  // Nothing was removed yet: the toast says it was proposed, and to whom.
  await expect(page.getByText(/^Proposed: remove the dependency of ‘.+’ on ‘Alert rules engine’; it waits for Avery Stone in Needs a decision/).first()).toBeVisible();
  await expect(page.getByText(/^Removed the dependency/)).toHaveCount(0);
  await expect(cut.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  const line = cut.getByTestId("fix-proposed").first();
  await expect(line).toBeVisible();
  await expect(line).not.toContainText("its decider");
  await expect(line).toContainText(/[Pp]roposed,? waits for Avery Stone/, { timeout: 15_000 });
  // The proposed line's item name opens that item's panel, as other item names do, and looks it.
  const dependent = /of ‘(.+?)’/.exec(await line.innerText())![1];
  const name = line.getByRole("button", { name: `‘${dependent}’` });
  const accent = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent-ink)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  await expect(name).toHaveCSS("color", accent);
  await name.click();
  await expect(page.getByTestId("floating-card")).toContainText(dependent);
  // The person it waits for reads "waits for you", on the strip and in Needs a decision.
  await signOut(page);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]').getByTestId("fix-proposed").first()).toContainText(/waits for you/);
  await page.getByTestId("needs-decision").click();
  await expect(tray(page).getByTestId("tray-proposal").filter({ hasText: "remove the dependency" }).first()).toContainText("waits for you");
});

test("the decider of a draft sent for review sees Approve, not Send for review, on the owner's named draft", async ({ page }) => {
  await open(page, "roadmap-two-drafts");
  await strip(page).locator('[data-testid="conflict"][data-item="setup-tour"]').getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByText(/Brought back 'In-app tour'/)).toBeVisible();
  const banner = page.getByTestId("draft-banner");
  await banner.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText(/Sent for review/).first()).toBeVisible();
  // Priya Raman decides the Onboarding roadmap; the people lookup answers late.
  await signOut(page);
  await page.evaluate(([key, value, msKey]) => {
    localStorage.setItem(key, value);
    localStorage.setItem(msKey, "20000");
  }, [MOCK_SLOW_KEY, "/v1/people", MOCK_SLOW_MS_KEY] as const);
  await login(page, "approver@example.com");
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(banner).toBeVisible();
  // Right after load, before the people lookup answers, the banner names whose draft it is.
  await expect(banner.getByTestId("draft-words")).toContainText("Avery Stone's working draft of the Onboarding roadmap", { timeout: 3_000 });
  await expect(banner.getByTestId("draft-words")).not.toContainText("Someone");
  await expect(banner.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await expect(banner.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  // Not hers: the banner names whose draft it is and its roadmap.
  await expect(banner.getByTestId("draft-words")).not.toContainText("Your working draft");
  await expect(banner.getByTestId("draft-words")).toContainText("Avery Stone's working draft of the Onboarding roadmap");
});

test("under a filter, Needs a decision says N here, M in all on one basis, and 1 of N is", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-talk-two-deps"] as const);
  await login(page);
  await page.goto("/simple/roadmap?goal=grow-retention");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await cutKeepingDependents(page, "alert-rules");
  await expect(strip(page).getByTestId("conflicts-all")).toBeVisible();
  const button = Number(/· (\d+)/.exec(await page.getByTestId("needs-decision").innerText())![1]);
  await page.getByTestId("needs-decision").click();
  const scope = tray(page).getByTestId("tray-scope");
  // The whole count is every roadmap the reader sees, and says so.
  const m = /^(\d+) here, (\d+) in all your roadmaps to decide/.exec(await scope.innerText());
  expect(m).not.toBeNull();
  // No roadmap is chosen: the sentence counts every roadmap's draft, never "this roadmap's" too.
  await expect(scope).toContainText("in your roadmaps' working drafts");
  await expect(scope).not.toContainText("this roadmap's working draft");
  const tiles = await tray(page).getByTestId("tray-counter").locator("b").allInnerTexts();
  // The tiles count the whole roadmap, as the "in all" does and the button does.
  expect(tiles.reduce((n, t) => n + Number(t), 0)).toBe(Number(m![2]));
  expect(button).toBe(Number(m![2]));
  expect(Number(m![1])).toBeLessThan(Number(m![2]));
  const here = await tray(page).getByTestId("tray-links-here").innerText();
  const k = Number(/^(\d+) of/.exec(here.trim())![1]);
  expect(here).toContain(k === 1 ? " is in these filters" : " are in these filters");
});

test("the side menu's Roadmap count holds the dates to confirm: it equals Needs a decision", async ({ page }) => {
  await open(page);
  const waiting = Number(/· (\d+)/.exec(await page.getByTestId("needs-decision").innerText())![1]);
  await page.getByTestId("needs-decision").click();
  const dates = Number(await tray(page).getByTestId("tray-counter").filter({ hasText: "Dates to confirm" }).locator("b").innerText());
  await tray(page).getByRole("button", { name: "Close" }).click();
  expect(dates).toBeGreaterThan(0);
  await expect.poll(async () => Number(await badge(page).innerText())).toBe(waiting);
  await expect(badge(page)).toHaveAttribute("aria-label", new RegExp(`${dates} dates? to confirm`));
});

test("the strip's M in all shows only when a filter hides some broken links", async ({ page }) => {
  await open(page);
  // The Weekly alert digest's link fixed, the one left (Welcome video's) is under Faster activation.
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect.poll(() => stripCount(page)).toBe(1);
  await page.goto("/simple/roadmap?goal=faster-activation");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(strip(page).locator('[data-testid="conflict"]')).toHaveCount(1);
  // The filter hides none of them: no "here", no "in all", no Clear filters.
  await expect(strip(page).getByTestId("conflicts-all")).toHaveCount(0);
  await expect(strip(page)).not.toContainText("here,");
});

test("Needs a decision names this roadmap's draft only when one roadmap is chosen", async ({ page }) => {
  await open(page);
  await page.getByTestId("needs-decision").click();
  const scope = tray(page).getByTestId("tray-scope");
  await expect(scope).toContainText("in your roadmaps' working drafts");
  await expect(scope).not.toContainText("this roadmap's working draft");
  await tray(page).getByRole("button", { name: "Close" }).click();
  await page.getByRole("combobox", { name: "Roadmap", exact: true }).selectOption({ label: "Alerts roadmap" });
  await page.getByTestId("needs-decision").click();
  await expect(scope).toContainText("in this roadmap's working draft");
  await expect(scope).not.toContainText("your roadmaps");
});

test("at 390 px the Propose toast covers neither the cut flag's buttons nor the proposed line", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-talk-own-decider"] as const);
  await login(page, "approver@example.com");
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await cutKeepingDependents(page, "alert-rules");
  const cut = strip(page).locator('[data-testid="conflict"][data-item="alert-rules"]');
  await cut.getByRole("button", { name: /^Propose: remove the dependency/ }).first().click();
  const toast = page.getByRole("status").filter({ hasText: /^Proposed: remove the dependency/ });
  await expect(toast).toBeVisible();
  await expect(cut.getByTestId("fix-proposed").first()).toBeVisible();
  const box = (await toast.boundingBox())!;
  const covered = await cut.locator('[data-testid="fix-proposed"], button').evaluateAll(
    (els, t) =>
      els.flatMap((el) => {
        const r = el.getBoundingClientRect();
        const over = r.width > 0 && r.left < t.x + t.width && t.x < r.right && r.top < t.y + t.height && t.y < r.bottom;
        return over ? [(el.textContent ?? "").trim()] : [];
      }),
    box,
  );
  expect(covered).toEqual([]);
});
