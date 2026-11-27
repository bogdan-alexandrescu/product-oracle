import { login, openRoadmapItem, signOut } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * flakes-dates (datesReason, app/simple/roadmap/_fields.tsx ~186): once a suggestion is
 * accepted into a working draft that is not published yet, a dependency can still move the
 * item's estimate. dates.after_dependencies then turns the moved dates' basis from
 * "suggestion" into "dependencies" (api/tests/test_simple_honest_starts.py's
 * test_accepted_suggestion_moved_by_a_dependency_reads_its_dependencies; the mock's
 * afterDependencies in web/lib/api/mock/simple-roadmap.ts ~1230 does the same). A reader who
 * cannot see that draft (simple-roadmap.ts's seesDraft/readerView, ~1766-1792) reads dates
 * moved past the dependency, and the Dates (i) says Oracle estimated them from the window and
 * what the feature depends on, never that they were "accepted from Oracle's suggestion in a
 * draft". fails_when=the (i) reads "accepted" once the dependency has moved the dates past
 * what was accepted.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId('floating-card');

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

async function openRoadmap(page: Page) {
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

async function openItem(page: Page, key: string) {
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

async function closePanel(page: Page) {
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
}

async function setDates(page: Page, start: string, end: string) {
  await tap(panel(page).getByRole('button', { name: 'Change the dates' }));
  await panel(page).getByLabel('Start', { exact: true }).fill(start);
  await panel(page).getByLabel('End', { exact: true }).fill(end);
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-dates-kind')).toHaveText('Set by a person');
}

/**
 * Publishes `roadmap`'s working draft (its title, e.g. "Alerts roadmap"): the one banner line
 * when it is the only working draft open, else its own line in the list (another roadmap's
 * working draft may be left open on purpose, untouched).
 */
async function publishWorkingDraft(page: Page, roadmap: string) {
  const banner = page.getByTestId('draft-banner');
  const lines = banner.getByTestId('draft-line');
  const many = await lines.count();
  const scope = many ? lines.filter({ hasText: roadmap }) : banner;
  if (many) await expect(scope).toHaveCount(1);
  await tap(scope.getByTestId('draft-publish'));
  await expect(page.getByTestId('toasts')).toContainText('is published');
  await expect(many ? lines.filter({ hasText: roadmap }) : banner).toHaveCount(0);
}

test("an accepted suggestion a dependency later moves still reads as accepted, to a commenter too, because a decider's change is shown to every reader at once", async ({
  page,
}) => {
  await login(page);
  await openRoadmap(page);

  // Alert routing by team (alert-sso) comes to depend on Sample data import too (a feature of
  // another PRD, well before Oracle's current suggestion for it: adding the dependency moves
  // nothing yet). Published at once, so it is not part of the draft the suggestion's accept
  // opens next, and a reader who cannot see that later draft still reads this dependency.
  await openItem(page, 'alert-sso');
  await tap(panel(page).getByRole('button', { name: 'Add a dependency' }));
  await panel(page).getByLabel('Or a feature from another PRD').fill('Sample data import');
  await tap(
    panel(page)
      .getByTestId('card-depends-search')
      .getByRole('button', { name: /Sample data import/ }),
  );
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-depends')).toContainText('Sample data import');
  await closePanel(page);
  await publishWorkingDraft(page, 'Alerts roadmap');

  // Oracle's suggestion for alert-sso is accepted: its dates go into alert-sso's own working
  // draft, left open (not published). The owner, who sees every draft, reads it as accepted.
  await openItem(page, 'alert-sso');
  const why = panel(page).getByTestId('card-dates-why');
  const before = await panel(page).getByTestId('card-dates').innerText();
  await tap(panel(page).getByTestId('card-suggestion').getByRole('button', { name: 'Accept' }));
  await expect(panel(page).getByTestId('card-suggestion')).toHaveCount(0);
  await expect(panel(page).getByTestId('card-dates-kind')).toHaveText('Dates accepted from Oracle');
  const acceptedDates = await panel(page).getByTestId('card-dates').innerText();
  await closePanel(page);
  await expect(page.getByTestId('draft-banner')).toBeVisible();

  // Sample data import's own dates move well past what was just accepted for alert-sso:
  // published at once too, on a roadmap with no open draft of its own, so a reader sees it
  // plainly while alert-sso's own (still open) draft above stays hidden from them.
  await openItem(page, 'setup-import');
  await setDates(page, '2027-11-01', '2027-12-31');
  await closePanel(page);
  // The banner picks up this second roadmap's own working draft a beat after the save.
  await expect(page.getByTestId('draft-banner')).toContainText('Onboarding roadmap');
  await publishWorkingDraft(page, 'Onboarding roadmap');

  // A commenter: a decider's change is final at once and shown to every reader (direct edit,
  // Nov 23), so the open draft's accepted dates read for them exactly as they do for the owner,
  // as accepted, while the published dependency and Sample data import's dates read as they are.
  await page.goto('/home');
  await signOut(page);
  await login(page, 'commenter@example.com');
  await openRoadmap(page);
  await openItem(page, 'alert-sso');
  const dates = panel(page).getByTestId('card-dates');
  await expect(dates).not.toHaveText(before);
  await expect(dates).toContainText(acceptedDates.split(' · ')[0]);
  await expect(panel(page).getByTestId('card-dates-kind')).toHaveText('Dates accepted from Oracle');
  await expect(why).toHaveAccessibleDescription(/accepted/);
});
