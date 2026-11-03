import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * home-honest-loading: Simple's Home says what waits only once it knows, keeps its header
 * buttons' places while it loads, and still reads its sections when every roadmap and PRD
 * is in Trash, where the next review of a roadmap says its roadmap is in Trash.
 *
 * Test cards (protects / fails_when / no_claim):
 * - the greeting: protects=while the waiting decisions load, the greeting reads a neutral
 *   "Checking what waits on you…" and then says what waits once; fails_when=it first says
 *   "Nothing waits on you today." or a partial count, then changes to another claim.
 * - the buttons: protects=New PRD is at the same place from its first paint to the loaded
 *   page; fails_when="Walk me through it" arrives late and pushes New PRD to the right.
 * - nothing to walk: protects=on a new company (nothing waits, no review due) New PRD stays
 *   where it was first painted once Home knows there is no walk; fails_when=the walk's
 *   kept place is dropped and New PRD jumps left under the pointer.
 * - Trash: protects=with every roadmap and PRD moved to Trash (through their menus),
 *   "Decisions waiting for you" and "Since your last visit" load, and "Next review
 *   meeting" says the monthly roadmap refresh reviews a roadmap in Trash, linking the
 *   ritual's settings; fails_when=a section says "Oracle could not load this part" or the
 *   refresh shows as if its roadmap were live, or, opened on a wide window, the ritual's
 *   sheet pops open once the window narrows to a phone; no_claim=the API's filters (pytest:
 *   test_home_sections_trash.py, test_home_ritual_trash.py).
 */

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const simple = (page: Page) => page.getByTestId("simple-page");

/** Every greeting line and every left edge of New PRD the page painted, frame by frame. */
async function watchHeader(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __said: string[]; __prdX: number[] };
    w.__said = [];
    w.__prdX = [];
    const look = () => {
      const said = document.querySelector('[data-testid="simple-page"] [data-testid="home-sentence"]')?.textContent ?? null;
      if (said !== null && w.__said.at(-1) !== said) w.__said.push(said);
      const prd = document.querySelector('[data-testid="simple-page"] [data-testid="np-new-prd"]');
      if (prd) {
        const x = Math.round(prd.getBoundingClientRect().left);
        if (w.__prdX.at(-1) !== x) w.__prdX.push(x);
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

async function honestHeader(page: Page) {
  await signIn(page);
  // The waiting decisions answer late, after every other read.
  await page.evaluate(
    ([slowKey, msKey]) => {
      localStorage.setItem(slowKey, "/v1/simple/decisions/waiting");
      localStorage.setItem(msKey, "2500");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
  );
  await watchHeader(page);
  await page.goto("/simple");
  const sentence = simple(page).getByTestId("home-sentence");
  await expect(sentence).not.toHaveText("Checking what waits on you…", { timeout: 15_000 });
  await expect(simple(page).getByRole("button", { name: "Walk me through it" })).toBeVisible();
  const final = (await sentence.textContent()) ?? "";
  expect(final).toMatch(/wait on you|waits on you/);
  expect(final).not.toContain("Nothing waits");
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  // The neutral line, then the one true line: never "Nothing waits", never a claim taken back.
  expect(said).toEqual(["Checking what waits on you…", final]);
  const xs = await page.evaluate(() => (window as unknown as { __prdX: number[] }).__prdX);
  expect(xs.length).toBe(1);
  // A click aimed at New PRD lands on New PRD.
  await simple(page).getByTestId("np-new-prd").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("Home says nothing about what waits until it knows, and New PRD never moves", async ({ page }) => {
  await honestHeader(page);
});

/** A new company (nothing waits, no review due): Home finds there is no walk, and New PRD stays put. */
async function nothingToWalk(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "empty"] as const);
  await signIn(page);
  await page.evaluate(
    ([slowKey, msKey]) => {
      localStorage.setItem(slowKey, "/v1/simple/decisions/waiting");
      localStorage.setItem(msKey, "2500");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
  );
  await watchHeader(page);
  await page.goto("/simple");
  const sentence = simple(page).getByTestId("home-sentence");
  await expect(sentence).toHaveText("Nothing waits on you today.", { timeout: 15_000 });
  await expect(simple(page).getByRole("button", { name: "Walk me through it" })).toHaveCount(0);
  const xs = await page.evaluate(() => (window as unknown as { __prdX: number[] }).__prdX);
  expect(xs.length).toBe(1);
  await simple(page).getByTestId("np-new-prd").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("with nothing to walk, New PRD stays where it was first painted", async ({ page }) => {
  await nothingToWalk(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("Home says nothing about what waits until it knows, and New PRD never moves", async ({ page }) => {
    await honestHeader(page);
  });
  test("with every roadmap and PRD in Trash, Home's sections load and the roadmap review says so", async ({ page }) => {
    await everythingInTrash(page);
  });
  test("with nothing to walk, New PRD stays where it was first painted", async ({ page }) => {
    await nothingToWalk(page);
  });
});

/**
 * Deletes every row of a list through its Actions menu (Delete…, then Move to Trash); a row
 * whose run has not finished cannot go (Trash says to cancel the run first) and stays.
 * Returns how many stayed.
 */
async function trashEvery(page: Page, rows: Locator): Promise<number> {
  await expect(rows.first()).toBeVisible();
  const kept: string[] = [];
  for (let n = 0; n < 15 && kept.length < (await rows.count()); n++) {
    const menu = rows.nth(kept.length).getByRole("button", { name: /^Actions for / });
    const title = ((await menu.getAttribute("aria-label")) ?? "").replace(/^Actions for /, "");
    const row = rows.nth(kept.length);
    await expect(async () => {
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      if (!(await page.getByRole("menuitem", { name: "Delete…" }).isVisible())) await row.getByRole("button", { name: `Actions for ${title}` }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const dialog = page.getByRole("dialog", { name: `Delete ${title}` });
    const blocked = dialog.getByText("Cancel the run first");
    const second = dialog.getByLabel("Delete it here; the external copy stays where it is");
    // The dialog reads what goes with it first: then it can go, asks once more, or cannot go.
    await expect(blocked.or(second).or(dialog.getByRole("button", { name: "Move to Trash", disabled: false }))).toBeVisible();
    if (await blocked.isVisible()) {
      kept.push(title);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      continue;
    }
    if (await second.isVisible()) await second.check();
    await dialog.getByRole("button", { name: "Move to Trash" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rows.getByRole("button", { name: `Actions for ${title}`, exact: true })).toHaveCount(0);
  }
  return kept.length;
}

/** Pauses every ritual but the monthly roadmap refresh (Company › Rituals), so it is Home's next review. */
async function onlyTheRoadmapRefresh(page: Page) {
  await page.goto("/company/rituals");
  const on = page
    .getByTestId("ritual-row")
    .filter({ has: page.getByTestId("ritual-state").filter({ hasText: /^On$/ }) })
    .filter({ hasNotText: "Monthly roadmap refresh" });
  await expect(on.first()).toBeVisible();
  for (let n = 0; n < 15 && (await on.count()) > 0; n++) {
    const before = await on.count();
    // The row's corner, clear of its links (a phone opens the ritual in a sheet).
    await on.first().click({ position: { x: 4, y: 4 } });
    await page.getByRole("button", { name: "Pause", exact: true }).filter({ visible: true }).click();
    await expect(on).toHaveCount(before - 1);
    if (await page.getByTestId("ritual-sheet").isVisible()) await page.keyboard.press("Escape");
  }
  await expect(on).toHaveCount(0);
}

test("with every roadmap and PRD in Trash, Home's sections load and the roadmap review says so", async ({ page }) => {
  await everythingInTrash(page);
});

async function everythingInTrash(page: Page) {
  await signIn(page);
  await onlyTheRoadmapRefresh(page);
  await page.goto("/plan/documents");
  await expect(page.getByTestId("roadmaps-table")).toBeVisible();
  expect(await trashEvery(page, page.getByTestId("roadmap-row"))).toBe(0);
  await expect(page.getByTestId("roadmap-row")).toHaveCount(0);
  await page.goto("/documents");
  await expect(page.getByTestId("documents-table")).toBeVisible();
  await trashEvery(page, page.getByTestId("document-row"));

  await page.goto("/simple");
  const home = simple(page);
  await expect(home.getByTestId("home-sentence")).not.toHaveText("Checking what waits on you…", { timeout: 15_000 });
  // Every section read (an empty "Decisions waiting for you" is not drawn; the PRDs' questions wait in their own cards).
  await expect(home.getByTestId("home-since")).toBeVisible();
  await expect(home.getByText("Oracle could not load this part")).toHaveCount(0);
  const meeting = home.getByTestId("home-meeting-next");
  await expect(meeting).toContainText("Monthly roadmap refresh");
  const line = meeting.getByTestId("home-meeting-trash");
  await expect(line).toHaveText("Reviews a roadmap in Trash · Ritual settings");
  await line.getByRole("link", { name: "Ritual settings" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\?ritual=/);
  // The ritual's settings open (beside the table, or in a sheet on a phone).
  await expect(page.getByRole("heading", { name: "Monthly roadmap refresh" }).filter({ visible: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) > 600) {
    // Opened on a wider window, the ritual sits beside the table: narrowing the window to a
    // phone's width does not pop its sheet open.
    await expect(page.getByTestId("ritual-sheet")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("ritual-row").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Monthly roadmap refresh" }).filter({ visible: true })).toHaveCount(0);
  }
}
