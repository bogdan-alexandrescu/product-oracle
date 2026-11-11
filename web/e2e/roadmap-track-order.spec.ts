import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * track-order (owner Nov 9): the company's tracks keep one stored order. In the Tracks sheet an
 * opened track row has Move up and Move down (as the One-pagers rows' PRD order: one step per
 * press, a toast with Undo, keyboard reachable, disabled at the ends); the Roadmap's track bands,
 * the Tracks sheet and the Track filter follow it, and a reload keeps it. Invented products (the
 * mock's seed).
 *
 * Card track-order-move: protects = Move up moves a track one step, the sheet's rows, the
 * Timeline's bands and the Track filter follow; Undo puts it back; a reload keeps a move;
 * fails_when = the rows or bands keep the old order, Undo leaves it moved, a reload loses it, or
 * the first row's Move up is enabled.
 * Card track-order-propose: protects = one who does not decide a track proposes its move (the
 * toast names who decides, with Withdraw) and the order stays; fails_when = the move applies.
 */

async function open(page: Page, email?: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-milestones"] as const);
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("timeline-lane").first()).toBeVisible();
}

const ALERTS = "Usage alerts track";
const SETUP = "Guided setup track";
const MEDIA = "Welcome media track";
const sheet = (page: Page) => page.getByTestId("tracks-sheet");
const row = (page: Page, title: string) => sheet(page).getByTestId("track-row").filter({ has: page.getByText(title, { exact: true }) });
const toasts = (page: Page) => page.getByTestId("toasts");

/** The sheet's rows, by name. */
async function rows(page: Page): Promise<string[]> {
  return (await sheet(page).getByTestId("track-row").locator("p.font-medium").allInnerTexts()).map((t) => t.trim());
}

/** The Timeline's track bands that name one of the mock's tracks, in the order drawn. */
async function bands(page: Page): Promise<string[]> {
  const names = (await page.getByTestId("timeline-lane").allInnerTexts()).map((t) => t.trim());
  return names.flatMap((t) => [ALERTS, SETUP, MEDIA].filter((n) => t.startsWith(n)));
}

/** The Track filter's choices that name one of the mock's tracks. */
async function filter(page: Page): Promise<string[]> {
  const options = (await page.getByLabel("Track", { exact: true }).locator("option").allInnerTexts()).map((t) => t.trim());
  return options.filter((t) => [ALERTS, SETUP, MEDIA].includes(t));
}

test.describe("Track order", () => {
  test("an owner moves a track up in the Tracks sheet; the bands follow, Undo puts it back, a reload keeps a move", async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    await expect.poll(() => bands(page)).toEqual([ALERTS, SETUP]);
    expect(await filter(page)).toEqual([ALERTS, SETUP]);

    await page.getByTestId("tracks-open").click();
    await expect.poll(() => rows(page)).toEqual([ALERTS, SETUP, MEDIA]);
    await sheet(page).getByRole("button", { name: `Change ${SETUP}` }).click();
    const up = row(page, SETUP).getByRole("button", { name: "Move up", exact: true });
    await expect(up).toBeEnabled();
    // Keyboard reachable: a press of Enter on the focused button moves it one step.
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(toasts(page)).toContainText(`Moved ${SETUP} up.`);
    await expect.poll(() => rows(page)).toEqual([SETUP, ALERTS, MEDIA]);
    // The first cannot go up; it can go down.
    await expect(row(page, SETUP).getByRole("button", { name: "Move up", exact: true })).toBeDisabled();
    await expect(row(page, SETUP).getByRole("button", { name: "Move down", exact: true })).toBeEnabled();
    await expect.poll(() => bands(page)).toEqual([SETUP, ALERTS]);
    await expect.poll(() => filter(page)).toEqual([SETUP, ALERTS]);

    // Undo puts the order back, in the sheet and on the Roadmap.
    await toasts(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => rows(page)).toEqual([ALERTS, SETUP, MEDIA]);
    await expect.poll(() => bands(page)).toEqual([ALERTS, SETUP]);

    // The last cannot go down; a move is kept after a reload.
    await sheet(page).getByRole("button", { name: `Change ${MEDIA}` }).click();
    await expect(row(page, MEDIA).getByRole("button", { name: "Move down", exact: true })).toBeDisabled();
    await sheet(page).getByRole("button", { name: `Change ${SETUP}` }).click();
    await row(page, SETUP).getByRole("button", { name: "Move up", exact: true }).click();
    await expect.poll(() => rows(page)).toEqual([SETUP, ALERTS, MEDIA]);
    await page.reload();
    await expect(page.getByTestId("timeline-lane").first()).toBeVisible();
    await expect.poll(() => bands(page)).toEqual([SETUP, ALERTS]);
    expect(await filter(page)).toEqual([SETUP, ALERTS]);
    await page.getByTestId("tracks-open").click();
    await expect.poll(() => rows(page)).toEqual([SETUP, ALERTS, MEDIA]);
  });

  test("an approver who does not decide proposes a move; the order stays until it is decided", async ({ page }) => {
    await open(page, "approver@example.com");
    await page.getByTestId("tracks-open").click();
    await expect.poll(() => rows(page)).toEqual([ALERTS, SETUP, MEDIA]);
    await sheet(page).getByRole("button", { name: `Change ${SETUP}` }).click();
    await row(page, SETUP).getByRole("button", { name: "Move up", exact: true }).click();
    await expect(toasts(page)).toContainText("Move proposed · waits for");
    await expect(toasts(page).getByRole("button", { name: "Withdraw" })).toBeVisible();
    await expect.poll(() => rows(page)).toEqual([ALERTS, SETUP, MEDIA]);
    await expect.poll(() => bands(page)).toEqual([ALERTS, SETUP]);
  });
});
