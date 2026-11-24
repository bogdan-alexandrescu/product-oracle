import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * roadmap-ux (the UX audit of Nov 23, issues #1740 #1746 #1749 #1750 #1751 #1752 #1753 #1757):
 * Simple > Roadmap, driven as a person would, on the mock's invented roadmaps.
 * fails_when = a count says nothing of what it covers; Key dates stays open on an outside click,
 * mixes outside events with PRD milestones under one list, or shows the browser's own date
 * format; the open feature's row and bar are barely marked; a cut label has no full name on
 * hover; a track's health mark is a 14 px target; every track reads "No owner".
 */

const WIDE = { width: 1500, height: 620 };

async function open(page: Page, scenario?: string, path = '/simple/roadmap') {
  await page.setViewportSize(WIDE);
  if (scenario)
    await page
      .context()
      .addInitScript(([key, value]) => localStorage.setItem(key, value), [
        MOCK_SCENARIO_KEY,
        scenario,
      ] as const);
  await login(page);
  await page.goto(path);
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

const editor = (page: Page) => page.getByTestId('key-dates-editor');

test('#1746 Key dates closes on an outside click, as on Escape; a click inside keeps it', async ({
  page,
}) => {
  await open(page, 'roadmap-keydates', '/simple/roadmap?roadmap=onboarding-roadmap');
  await page.getByTestId('key-dates-open').click();
  await expect(editor(page)).toBeVisible();
  await editor(page).getByLabel("New key date's name").click();
  await expect(editor(page)).toBeVisible();
  await page.getByTestId('simple-chart').click({ position: { x: 5, y: 5 } });
  await expect(editor(page)).toBeHidden();
  // Its own button still toggles it.
  await page.getByTestId('key-dates-open').click();
  await expect(editor(page)).toBeVisible();
  await page.getByTestId('key-dates-open').click();
  await expect(editor(page)).toBeHidden();
  await page.getByTestId('key-dates-open').click();
  await page.keyboard.press('Escape');
  await expect(editor(page)).toBeHidden();
});

test("#1750 Key dates lists the roadmap's events apart from its PRD's milestones", async ({
  page,
}) => {
  await open(page, 'roadmap-keydates', '/simple/roadmap?roadmap=onboarding-roadmap');
  await page.getByTestId('key-dates-open').click();
  await expect(editor(page).getByTestId('key-dates-heading')).toHaveText([
    'Events',
    'PRD milestones',
  ]);
  const events = editor(page).getByTestId('key-dates-events');
  const milestones = editor(page).getByTestId('key-dates-milestones');
  await expect(events.getByTestId('key-date-row')).toHaveCount(1);
  await expect(events.getByTestId('key-date-row')).toHaveAttribute('data-name', 'Board meeting');
  await expect(milestones.getByTestId('key-date-row')).toHaveCount(2);
  await expect(milestones.getByTestId('key-date-from-prd')).toHaveCount(2);
});

test('#1751 the key date field reads month first, never the browser format', async ({ page }) => {
  await open(page, 'roadmap-keydates', '/simple/roadmap?roadmap=onboarding-roadmap');
  await page.getByTestId('key-dates-open').click();
  const form = editor(page).getByTestId('key-date-add');
  const words = form.getByTestId('key-date-day-words');
  await expect(words).toHaveText('Pick a day');
  await form.getByLabel("New key date's day").fill('2026-12-03');
  await expect(words).toHaveText('Dec 3, 2026');
  // The native field sits over the words, unseen: its dd.mm.yyyy never shows.
  await expect(form.getByLabel("New key date's day")).toHaveCSS('opacity', '0');
  // Editing a key date reads the same way.
  await editor(page).getByRole('button', { name: 'Edit Board meeting' }).click();
  const edit = editor(page).getByTestId('key-date-edit');
  await expect(edit.getByTestId('key-date-day-words')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
});

test("#1749 the open feature's row and bar are clearly marked, on the Timeline and the Gantt", async ({
  page,
}) => {
  await open(page, 'roadmap-milestones');
  const row = page.getByTestId('timeline-row').first();
  const label = row.getByTestId('timeline-row-label');
  await label.click();
  await expect(row).toHaveAttribute('data-open', 'true');
  expect(await label.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  expect(await label.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');
  const bar = row.getByTestId('timeline-bar');
  expect(await bar.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth))).toBe(3);
  expect(await bar.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  await page.keyboard.press('Escape');

  await page.getByTestId('format-gantt').click();
  const name = page.getByTestId('chart-label').first();
  const id = (await name.getAttribute('data-item-id'))!;
  await name.click();
  await expect(name).toHaveAttribute('data-open', 'true');
  expect(await name.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  const gbar = page.locator(`[data-testid="bar"][data-bar-id="${id}"]`);
  await expect(gbar).toHaveAttribute('data-open', 'true');
  await expect(gbar.getByTestId('bar-open-ring')).toHaveCount(1);
});

test('#1752 every cut label on the timeline shows its full name on hover and focus', async ({
  page,
}) => {
  await open(page, 'roadmap-milestones');
  await expect(page.getByTestId('ms-band')).toBeVisible();
  // Every label cut with an ellipsis: a title (the browser's tip), else it is marked to point at.
  const { titled, pointed } = await page.getByTestId('simple-roadmap').evaluate((root) => {
    let titled = 0;
    let pointed = 0;
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (!el.offsetParent || !el.textContent?.trim()) continue;
      if (getComputedStyle(el).textOverflow !== 'ellipsis') continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (el.closest('[title]')) titled++;
      else el.closest<HTMLElement>('[aria-label]')!.dataset.cutProbe = String(pointed++);
    }
    return { titled, pointed };
  });
  expect(titled + pointed).toBeGreaterThan(3);
  for (let n = 0; n < pointed; n++) {
    const label = page.locator(`[data-cut-probe="${n}"]`);
    const whole = (await label.getAttribute('aria-label'))!.split(/ · |, /)[0];
    await label.hover();
    await expect(page.getByRole('tooltip').filter({ hasText: whole })).toBeVisible();
    await page.mouse.move(0, 0);
  }
  // And on focus, for a keyboard.
  if (pointed) {
    const first = page.locator('[data-cut-probe="0"]');
    const whole = (await first.getAttribute('aria-label'))!.split(/ · |, /)[0];
    await first.focus();
    await expect(page.getByRole('tooltip').filter({ hasText: whole })).toBeVisible();
  }
});

test("#1753 a track's health reason shows on a tap near its small mark", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: WIDE });
  const page = await context.newPage();
  await open(page, 'roadmap-milestones');
  const risk = page
    .getByTestId('timeline-lane')
    .filter({ hasText: 'Usage alerts track' })
    .getByTestId('track-health');
  await expect(risk).toHaveAttribute('data-health', 'at_risk');
  await risk.scrollIntoViewIfNeeded();
  const box = (await risk.boundingBox())!;
  // A finger lands a few pixels off the 14 px glyph: still the mark.
  await page.touchscreen.tap(box.x + box.width + 3, box.y + box.height / 2);
  await expect(risk.getByRole('tooltip')).toHaveText(/^At risk: /);
  await context.close();
});

test('#1757 the Tracks sheet names owners only once they are used, and "No owner" leads to one', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('tracks-open').click();
  const sheet = page.getByTestId('tracks-sheet');
  const rows = sheet.getByTestId('track-row');
  await expect(rows.first()).toBeVisible();
  await expect(sheet.getByText(/No owner/)).toHaveCount(0);
  // An owner set on one track: the others offer to set theirs.
  const first = rows.first();
  await first.getByRole('button', { name: /^Change / }).click();
  const owner = first.getByLabel('Owner', { exact: true });
  const person = (await owner.locator('option').nth(1).textContent())!.trim();
  await owner.selectOption({ label: person });
  await expect(first).toContainText(person);
  await first.getByRole('button', { name: /^Hide / }).click();
  const other = rows.nth(1).getByTestId('track-no-owner');
  await expect(other).toHaveText('No owner');
  await other.click();
  await expect(rows.nth(1).getByLabel('Owner', { exact: true })).toBeFocused();
});

test('#1740 the goal cards and the Tracks sheet each say what their count covers', async ({
  page,
}) => {
  await open(page);
  // A goal card counts items for the goal that the filters show; a track's count is every
  // feature on it: each says so on hover.
  const cards = page.getByTestId('goal-counter-items');
  await expect(cards.first()).toHaveAttribute('title', /filters show.*cut and merged/);
  await page.getByTestId('tracks-open').click();
  await expect(page.getByTestId('track-count').first()).toHaveAttribute(
    'title',
    /whatever the filters show.*cut and merged/,
  );
});
