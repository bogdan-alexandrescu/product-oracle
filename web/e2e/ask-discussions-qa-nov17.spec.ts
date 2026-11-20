import { expect, test, type Locator, type Page } from './test';

import { login, openSection } from './helpers';

/*
 * Ask and discussions visual QA, Nov 17, 2026, on the mock layer (invented data). Desktop =
 * 1440x900, phone = 390x844. The API side of finding 5 is
 * api/tests/test_qa_nov17_chat_card_code.py.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openAsk(page: Page): Promise<Locator> {
  // The rail's Ask Oracle; on a phone, the header's Ask.
  await page
    .locator('[data-testid="simple-ask"], [data-testid="phone-ask"]')
    .filter({ visible: true })
    .first()
    .click();
  const panel = page.getByTestId('hop-panel').filter({ visible: true });
  await expect(panel.getByTestId('ask-chat')).toBeVisible();
  return panel;
}

async function send(panel: Locator, text: string): Promise<void> {
  const box = panel.getByRole('textbox', { name: 'Message Oracle' });
  await expect(box).toHaveAttribute('placeholder', 'Ask about the roadmap, or ask for a change…');
  await box.fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

/** Asks about Weekly alert digest on the roadmap and shares the chat: the shared thread. */
async function shareDigest(page: Page): Promise<{ form: Locator; post: () => Promise<Locator> }> {
  await login(page);
  await page.goto('/simple/roadmap');
  const panel = await openAsk(page);
  await send(panel, 'what is Weekly alert digest about?');
  await expect(
    panel.getByTestId('ask-chat-thread').getByTestId('ask-answer').last(),
  ).toHaveAttribute('data-status', 'complete', { timeout: 15_000 });
  await panel.getByTestId('ask-share').click();
  const form = panel.getByTestId('hop-share-form');
  return {
    form,
    post: async () => {
      await form.getByRole('button', { name: 'Post' }).click();
      await expect(page).toHaveURL(/\/simple\/roadmap\?discussion=/);
      return page.getByTestId('linked-discussion-sheet').getByTestId('discussion-thread');
    },
  };
}

for (const [where, size] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  // protects=finding 1: Share as discussion pre-fills and posts the answer as plain text, the
  // feature with its code; fails_when="**", "###" or "- " lines are in the box or the posted
  // message, or the feature is named alone; no_claim=the answer's wording.
  test(`1: Share as discussion posts the answer as text, the feature with its code (${where})`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const { form, post } = await shareDigest(page);
    const box = form.getByLabel('First message');
    await expect(box).toHaveValue(/F-\d+ Weekly alert digest/);
    await expect(box).not.toHaveValue(/\*\*|#|^\s*- /m);
    await expect(box).toHaveValue(/^Runs /m);
    const thread = await post();
    const first = thread.getByTestId('discussion-message').first();
    await expect(first).toContainText(/F-\d+ Weekly alert digest/);
    await expect(first).not.toContainText('**');
    await expect(first).not.toContainText('###');
  });
}

// protects=finding 2: in a shared discussion only its starter is in, the composer's rule and its
// tick agree: no "Ask Oracle" box beside "Oracle will reply"; fails_when=an unticked box shows;
// no_claim=a discussion with other people (the box stays there).
test('2: a solo open discussion shows no Ask Oracle box beside Oracle will reply', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const { post } = await shareDigest(page);
  const thread = await post();
  await expect(thread.getByTestId('discussion-visibility')).toHaveText('Open');
  await expect(thread.getByTestId('oracle-rule')).toHaveText('Oracle will reply');
  await expect(thread.getByRole('checkbox', { name: 'Ask Oracle' })).toHaveCount(0);
});

// protects=finding 3: a citation in a discussion reply is its number alone, right after the word
// (the source is in its card); fails_when=the chip carries the source's name ("Oracle Ground
// Truth 1") or a space is left before it; no_claim=the card's contents.
test("3: a discussion reply's citation is a small number after the word", async ({ page }) => {
  await login(page, 'commenter@example.com');
  await page.goto('/documents/annual-billing/v/2');
  await openSection(page, 'problem');
  await page.getByTestId('hop-strip').click();
  const panel = page.getByTestId('hop-panel').filter({ visible: true });
  await panel.getByRole('textbox', { name: 'Ask Oracle' }).fill('Why is this ranked third?');
  await panel.getByRole('button', { name: 'Send' }).click();
  const reply = panel.getByTestId('discussion-thread').getByTestId('oracle-reply').last();
  await expect(reply).toContainText('the goal does not depend on it');
  const chip = reply.getByTestId('cite-c-1').first();
  await expect(chip).toHaveText('1');
  await expect(reply).toContainText(/thresholds only1\./);
  // One line high: it does not wrap as a box.
  expect((await chip.boundingBox())!.height).toBeLessThan(28);
});

// protects=finding 4: a closed discussion's header shows one state, Closed; fails_when="Open" is
// beside "Closed"; no_claim=Reopen.
test('4: a closed discussion shows Closed, not Open beside it', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const { post } = await shareDigest(page);
  const thread = await post();
  await thread.getByRole('button', { name: 'Discussion actions' }).click();
  await thread.getByRole('menuitem', { name: 'Close' }).click();
  await expect(thread.getByText('Closed', { exact: true })).toBeVisible();
  await expect(thread.getByTestId('discussion-visibility')).toHaveCount(0);
});

// protects=finding 5 (mock): Ask's change card names the feature with its code; fails_when="Move
// Weekly alert digest to Next"; no_claim=the API (pytest).
test('5: the move card names the feature with its code', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto('/simple/roadmap');
  const panel = await openAsk(page);
  await send(panel, 'move Weekly alert digest to next');
  await expect(panel.getByTestId('chat-card').last().getByTestId('chat-card-summary')).toHaveText(
    /^Move F-\d+ Weekly alert digest to Next$/,
    { timeout: 15_000 },
  );
});

// protects=finding 6: an undone card shows no warning; fails_when=a warning shows on the Undone
// card; no_claim=which warnings an open card shows.
test('6: an undone move card shows no warning', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto('/simple/roadmap');
  const panel = await openAsk(page);
  await send(panel, 'move Weekly alert digest to next');
  const card = panel.getByTestId('chat-card').last();
  await expect(card.getByTestId('chat-card-summary')).toContainText('Weekly alert digest to Next', {
    timeout: 15_000,
  });
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(card).toHaveAttribute('data-status', 'applied');
  await card.getByRole('button', { name: 'Undo this change' }).click();
  await expect(card).toHaveAttribute('data-status', 'undone');
  await expect(card.getByTestId('chat-card-outcome')).toContainText('Undone');
  await expect(card.getByTestId('chat-card-flag')).toHaveCount(0);
});

// protects=finding 7: Enter in the rename box saves the title; fails_when=Enter adds a line and
// only Save saves; no_claim=the title's length limit.
test("7: Enter saves a discussion's new title", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const { post } = await shareDigest(page);
  const thread = await post();
  await thread.getByRole('button', { name: 'Discussion actions' }).click();
  await thread.getByRole('menuitem', { name: 'Rename' }).click();
  const title = thread.getByRole('textbox', { name: 'Title' });
  await title.fill('Digest timing');
  await title.press('Enter');
  await expect(title).toHaveCount(0);
  await expect(thread.getByRole('heading', { name: 'Digest timing' })).toBeVisible();
});
