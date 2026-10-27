import { login, signOut } from "./helpers";
import { expect, test, type BrowserContext, type Locator, type Page } from "./test";

/**
 * Simple S6 priorities (#723, D9; the owner's pick "A · Ladder with B's compare as a
 * toggle"), against the mock's company-wide roadmap (lib/api/mock/simple-priorities.ts):
 * Oracle's order by score in dependency order is setup-checklist, alert-rules, alert-digest
 * (after alert-rules, which it needs), alert-mobile, setup-import, alert-export, alert-sso
 * (after alert-export), then the rows with no goal; setup-ideas is a draft not yet ranked.
 * Every action is driven through the UI: drags, the arrow keys, the dialogs and buttons.
 */

const ORACLE = ["setup-checklist", "alert-rules", "alert-digest", "alert-mobile", "setup-import", "alert-export", "alert-sso", "price-tiers", "setup-video"];
const PHONE = { width: 390, height: 844 };

const signedIn = new WeakSet<BrowserContext>();

/** A tab signed in as `email` (a new tab starts as the last one signed in: it signs out first). */
async function as(page: Page, email: string): Promise<Page> {
  const context = page.context();
  const tab = await context.newPage();
  if (signedIn.has(context)) {
    await tab.goto("/home");
    await signOut(tab);
  }
  await login(tab, email);
  signedIn.add(context);
  await tab.goto("/simple/priorities");
  await expect(tab.getByTestId("prio-row").first()).toBeVisible();
  return tab;
}

async function dark(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => localStorage.setItem("oracle-theme", "dark"));
}

const codes = (tab: Page, id = "prio-row") => tab.getByTestId(id).evaluateAll((els) => els.map((e) => e.getAttribute("data-code")));
const row = (tab: Page, code: string): Locator => tab.locator(`[data-testid="prio-row"][data-code="${code}"]`);

/** Drags a row's handle onto the row now at `to` (0-based), as a person does with a mouse or a finger. */
async function dragRow(tab: Page, code: string, to: number): Promise<void> {
  const handle = tab.getByRole("button", { name: `Drag ${code} to reorder` });
  // Both rows on screen (a phone's rail sits at the bottom).
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const from = await handle.boundingBox();
  const target = await tab.getByTestId("prio-row").nth(to).boundingBox();
  await tab.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await tab.mouse.down();
  await tab.mouse.move(from!.x + from!.width / 2, target!.y + target!.height / 2 + 2, { steps: 10 });
  await tab.mouse.up();
}

async function giveReason(tab: Page, code: string, reason: string, button: "Move" | "Propose"): Promise<void> {
  const dialog = tab.getByRole("dialog", { name: `Why move ${code}` });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe("desktop", () => {
  /**
   * Card simple-priorities-ranked: protects = the ranked list is ordered by score in
   * dependency order with the subtitle saying so, a row whose score beats a row above says
   * "After <code>, which it needs" from its real dependency, an owner's drag asks a one-line
   * reason, applies through the change engine, shows the override with the name and Oracle's
   * rank as a ghost, and Undo puts it back; Compare with Oracle shows Oracle's order beside
   * yours; fails_when = rows come in another order, the after line is missing or wrong, a
   * drag moves without a reason or without the change engine, the ghost or the override line
   * is missing, Undo does nothing, or compare does not show both orders; no_claim = Oracle's
   * pushback on a move (the API's oracle.priorities rules, api/tests/test_simple_priorities_api.py),
   * the real API's scoring.
   */
  test("an owner drags a row with a reason, sees the ghost and the override, compares and undoes", async ({ page }) => {
    const admin = await as(page, "admin@example.com");
    await expect(admin.getByTestId("prio-subtitle")).toContainText("a feature never ranks above one it depends on");
    expect(await codes(admin)).toEqual(ORACLE);
    await expect(row(admin, "alert-digest").getByTestId("prio-after")).toHaveText("After alert-rules, which it needs.");
    await expect(row(admin, "alert-sso").getByTestId("prio-after")).toHaveText("After alert-export, which it needs.");
    await expect(row(admin, "setup-checklist").getByTestId("prio-after")).toHaveCount(0);
    await expect(admin.getByTestId("prio-ghost")).toHaveCount(0);

    await dragRow(admin, "alert-export", 0);
    await giveReason(admin, "alert-export", "Two large customers asked for it this month", "Move");
    await expect(admin.getByText("Moved alert-export to rank 1")).toBeVisible();
    expect((await codes(admin))[0]).toBe("alert-export");
    await expect(row(admin, "alert-export").getByTestId("prio-ghost")).toHaveText("Oracle #6");
    await expect(row(admin, "alert-export").getByTestId("prio-override")).toHaveText("Moved by Admin: “Two large customers asked for it this month”");

    await admin.getByRole("switch", { name: "Compare with Oracle" }).click();
    const oracle = admin.getByRole("region", { name: "Oracle's order" });
    await expect(oracle).toBeVisible();
    await expect(admin.getByRole("region", { name: "Your order" })).toBeVisible();
    expect(await codes(admin, "oracle-row")).toEqual(ORACLE);
    await expect(oracle.locator('[data-code="alert-export"]').getByTestId("oracle-why")).toHaveText(
      "Yours: #1. Admin moved it: “Two large customers asked for it this month”",
    );

    await admin.getByRole("button", { name: "Undo" }).click();
    await expect(admin.getByText("Undone")).toBeVisible();
    await expect.poll(() => codes(admin)).toEqual(ORACLE);
    await expect(admin.getByTestId("prio-ghost")).toHaveCount(0);
  });

  /**
   * Card simple-priorities-proposal: protects = a commenter's move is a proposal (nothing
   * moves), shown inline under its row with its flow thumbnail and "waiting for" the
   * company's owners; the thumbnail widens the card in place to the user flow and a low-fi
   * wireframe; an estimate proposal with no bundle says "No flow yet"; the owner accepts it
   * and the row moves; fails_when = a commenter's move applies, the proposal is not inline,
   * names nobody, has no thumbnail or does not widen, or the owner cannot accept it;
   * no_claim = S10's flow bundles (the mock invents one), the decider rules (simple-deciders).
   */
  test("a commenter proposes inline with its flow thumbnail; the owner accepts", async ({ page }) => {
    await dark(page.context());
    const cory = await as(page, "commenter@example.com");
    await cory.getByRole("button", { name: "Drag alert-mobile to reorder" }).focus();
    await cory.keyboard.press("ArrowUp");
    await giveReason(cory, "alert-mobile", "Push is what the beta users asked for", "Propose");
    await expect(cory.getByText("Proposed: waiting for the decider")).toBeVisible();
    expect(await codes(cory)).toEqual(ORACLE);
    // The pricing roadmap is for approvers and owners: its feature ranks, with no item to move.
    await expect(cory.getByRole("button", { name: "Drag price-tiers to reorder" })).toHaveCount(0);
    await expect(cory.getByRole("button", { name: "Drag alert-sso to reorder" })).toBeVisible();
    const card = row(cory, "alert-mobile").getByTestId("prio-proposal");
    await expect(card).toContainText("Commenter proposes rank 3: “Push is what the beta users asked for” · waiting for Admin");
    await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expect(card).toHaveAttribute("data-wide", "false");
    await card.getByRole("button", { name: "Open the flow for alert-mobile" }).click();
    await expect(card).toHaveAttribute("data-wide", "true");
    await expect(card.getByTestId("flow-detail")).toContainText("User flow: Act on a pushed alert");
    await expect(card.getByRole("img", { name: "Wireframe of Alert on a phone" })).toContainText("Snooze and Assign buttons");

    // An estimate with no flow bundle: "No flow yet".
    await cory.getByRole("tab", { name: "Value / effort" }).click();
    await cory.locator('[data-testid="vxe-point"][data-code="setup-import"]').focus();
    await cory.keyboard.press("ArrowUp");
    await expect(cory.getByText("Proposed: waiting for the decider")).toBeVisible();
    await cory.getByRole("tab", { name: "Ranked list" }).click();
    await expect(row(cory, "setup-import").getByTestId("prio-proposal")).toContainText("Commenter proposes goal value 6.5");
    await expect(row(cory, "setup-import").getByTestId("flow-none")).toHaveText("No flow yet");

    const admin = await as(page, "admin@example.com");
    const waiting = row(admin, "alert-mobile").getByTestId("prio-proposal");
    await expect(waiting).toContainText("waiting for Admin");
    await waiting.getByRole("button", { name: "Accept" }).click();
    await expect(admin.getByText("Accepted alert-mobile's proposal")).toBeVisible();
    await expect.poll(async () => (await codes(admin)).indexOf("alert-mobile")).toBe(2);
    await expect(row(admin, "alert-mobile").getByTestId("prio-override")).toContainText("“Push is what the beta users asked for”");
    await expect(row(admin, "alert-mobile").getByTestId("prio-ghost")).toHaveText("Oracle #4");
  });

  /**
   * Card simple-priorities-2x2: protects = the value/effort 2x2 draws each row as its goal's
   * shape with its rank as the number, hollow below the line, beside B's ranked side list;
   * dragging a mark sideways re-estimates effort through the change engine and score and rank
   * update at once; Undo restores; fails_when = marks lack ranks or the below-the-line
   * state, a sideways drag changes goal value instead of effort, the rank does not move, or
   * Undo does nothing; no_claim = the real API's scoring of a person's estimate (pytest).
   */
  test("value / effort: a sideways drag re-estimates effort and the rank moves at once", async ({ page }) => {
    const admin = await as(page, "admin@example.com");
    await admin.getByRole("tab", { name: "Value / effort" }).click();
    await expect(admin.getByRole("button", { name: "#7 alert-sso: goal value 3, effort 2 weeks, below the line" })).toBeVisible();
    await expect(admin.getByRole("button", { name: "#5 setup-import: goal value 6, effort 3 weeks" })).toBeVisible();
    expect(await codes(admin, "side-row")).toEqual(ORACLE);
    const point = admin.locator('[data-testid="vxe-point"][data-code="setup-import"]');
    const plot = (await admin.getByTestId("vxe-plot").boundingBox())!;
    const at = (await point.boundingBox())!;
    // maxE is 5 weeks across the plot's inner 92%: two weeks to the left.
    await admin.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await admin.mouse.down();
    await admin.mouse.move(at.x + at.width / 2 - (plot.width * 0.92 * 2) / 5, at.y + at.height / 2 + 3, { steps: 10 });
    await admin.mouse.up();
    await expect(admin.getByText("Re-estimated setup-import: effort 1 wk")).toBeVisible();
    await expect(admin.getByRole("button", { name: "#2 setup-import: goal value 6, effort 1 weeks" })).toBeVisible();
    expect((await codes(admin, "side-row"))[1]).toBe("setup-import");
    await admin.getByRole("button", { name: "Undo" }).click();
    await expect(admin.getByRole("button", { name: "#5 setup-import: goal value 6, effort 3 weeks" })).toBeVisible();
  });

  /**
   * Card simple-priorities-drafts: protects = draft items not yet ranked sit at the bottom
   * with Confirm and Merge; Merge cuts the draft through the change engine with "Merged into
   * <code>" (Undo brings it back); Confirm ranks it; fails_when = drafts are missing, Merge or
   * Confirm write nothing, or Undo of a merge does not return the draft; no_claim = Oracle's
   * duplicate reconciliation (S5), the real API (test_confirm_item_into_the_working_draft).
   */
  test("a draft at the bottom merges, comes back with Undo, and is confirmed", async ({ page }) => {
    const admin = await as(page, "admin@example.com");
    const drafts = admin.getByRole("region", { name: "Not ranked yet" });
    const draft = drafts.locator('[data-testid="prio-draft"][data-code="setup-ideas"]');
    await expect(draft).toContainText("Team invite nudges");
    await draft.getByRole("button", { name: "Merge" }).click();
    await draft.getByLabel("Merge into").selectOption({ label: "setup-checklist · Setup checklist" });
    await draft.getByRole("button", { name: "Merge" }).last().click();
    await expect(admin.getByText("Merged setup-ideas into setup-checklist")).toBeVisible();
    await expect(drafts).toHaveCount(0);
    await admin.getByRole("button", { name: "Undo" }).click();
    await expect(draft).toBeVisible();
    await draft.getByRole("button", { name: "Confirm" }).click();
    await expect(admin.getByText("Confirmed setup-ideas")).toBeVisible();
    await expect(drafts).toHaveCount(0);
    await expect(row(admin, "setup-ideas")).toContainText("Team invite nudges");
  });

  /**
   * Card simple-priorities-draft-proposals (review minor): protects = a commenter's Confirm
   * and Merge on a draft not yet ranked show inline under that draft, waiting for the
   * decider, and the decider accepts from there; fails_when = the draft's proposals are
   * nowhere on the page; no_claim = the real API's routing (pytest).
   */
  test("a commenter's Confirm and Merge on a draft wait inline for the decider", async ({ page }) => {
    const cory = await as(page, "commenter@example.com");
    const draft = cory.locator('[data-testid="prio-draft"][data-code="setup-ideas"]');
    await draft.getByRole("button", { name: "Confirm" }).click();
    await expect(cory.getByText("Proposed: waiting for the decider")).toBeVisible();
    await draft.getByRole("button", { name: "Merge" }).click();
    await draft.getByLabel("Merge into").selectOption({ label: "setup-checklist · Setup checklist" });
    await draft.getByRole("button", { name: "Merge" }).last().click();
    const cards = draft.getByTestId("prio-proposal");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Commenter proposes confirming it · waiting for Admin");
    await expect(cards.nth(1)).toContainText("Commenter proposes merging it: “Merged into setup-checklist” · waiting for Admin");
    await expect(cards.nth(0).getByRole("button", { name: "Accept" })).toHaveCount(0);

    const admin = await as(page, "admin@example.com");
    const theirs = admin.locator('[data-testid="prio-draft"][data-code="setup-ideas"]').getByTestId("prio-proposal");
    await theirs.nth(0).getByRole("button", { name: "Accept" }).click();
    await expect(admin.getByText("Accepted setup-ideas's proposal")).toBeVisible();
    await expect(row(admin, "setup-ideas")).toContainText("Team invite nudges");
  });

  /**
   * Card simple-priorities-decide-fails (review minor): protects = a decision the API refuses
   * (here the proposal was declined in another tab) says the API's reason, not a bare "Could
   * not decide"; fails_when = the reason is dropped; no_claim = the API's wording (its own).
   */
  test("accepting a proposal another tab already declined says why", async ({ page }) => {
    const cory = await as(page, "commenter@example.com");
    await cory.getByRole("button", { name: "Drag alert-mobile to reorder" }).focus();
    await cory.keyboard.press("ArrowUp");
    await giveReason(cory, "alert-mobile", "Push is what the beta users asked for", "Propose");
    await expect(cory.getByText("Proposed: waiting for the decider")).toBeVisible();
    const stale = await as(page, "admin@example.com");
    const fresh = await page.context().newPage();
    await fresh.goto("/simple/priorities");
    await row(fresh, "alert-mobile").getByTestId("prio-proposal").getByRole("button", { name: "Decline" }).click();
    await expect(fresh.getByText("Declined alert-mobile's proposal")).toBeVisible();
    await row(stale, "alert-mobile").getByTestId("prio-proposal").getByRole("button", { name: "Accept" }).click();
    await expect(stale.getByText("This change is declined already")).toBeVisible();
  });

  /**
   * Card simple-priorities-tokens (review major): protects = the screen's type follows S1's
   * shared --simple-* scale (body --simple-text, heading --simple-h1, small --simple-small),
   * not sizes of its own; fails_when = a size is hard-coded or the tokens are a second set;
   * no_claim = S1's values (S1's own spec).
   */
  test("the screen's type follows the shared --simple-* tokens", async ({ page }) => {
    const admin = await as(page, "admin@example.com");
    const sizes = await admin.getByTestId("simple-priorities").evaluate((root) => {
      const v = (n: string) => getComputedStyle(root).getPropertyValue(n).trim();
      const px = (e: Element | null) => (e ? getComputedStyle(e).fontSize : "missing");
      return {
        text: [v("--simple-text"), getComputedStyle(root).fontSize],
        h1: [v("--simple-h1"), px(root.querySelector("h1"))],
        small: [v("--simple-small"), px(root.querySelector('[data-testid="prio-after"]'))],
        radius: [v("--simple-card-radius"), getComputedStyle(root.querySelector('[data-testid="prio-row"]')!).borderTopLeftRadius],
      };
    });
    expect(sizes).toEqual({ text: ["18px", "18px"], h1: ["34px", "34px"], small: ["15px", "15px"], radius: ["18px", "18px"] });
  });

  /**
   * Card simple-priorities-buckets: protects = one bucket per goal sized by this quarter's
   * engineer-weeks with its share, "No goal" flagged; fails_when = weeks or shares are wrong
   * or No goal is not flagged; no_claim = capacity (the API serves effort, not headcount).
   */
  test("goal buckets size each goal by this quarter's weeks and flag No goal", async ({ page }) => {
    const admin = await as(page, "admin@example.com");
    await admin.getByRole("tab", { name: "Goal buckets" }).click();
    await expect(admin.getByTestId("bucket-bar")).toBeVisible();
    const b = (key: string) => admin.locator(`[data-testid="goal-bucket"][data-key="${key}"]`);
    await expect(b("grow-retention")).toContainText("9 wk · 64%");
    await expect(b("faster-activation")).toContainText("5 wk · 36%");
    await expect(b("none")).toContainText("No goal");
    await expect(b("none")).toContainText("Serves no confirmed goal");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  /**
   * Card simple-priorities-phone: protects = on a phone the ranked list drags (a finger's
   * drag is the same pointer drag), Compare with Oracle is a Yours / Oracle's toggle with each
   * override explained, buckets are goal cards; dark theme; fails_when = the phone cannot
   * reorder, compare squeezes both lists side by side, or the bar replaces the cards;
   * no_claim = touch hardware gestures (Playwright drives pointer events).
   */
  test("drag, compare toggle and goal cards on a phone, dark", async ({ page }) => {
    await dark(page.context());
    const admin = await as(page, "admin@example.com");
    await dragRow(admin, "alert-mobile", 2);
    await giveReason(admin, "alert-mobile", "Needed for the audit in November", "Move");
    await expect.poll(async () => (await codes(admin))[2]).toBe("alert-mobile");
    await admin.getByRole("switch", { name: "Compare with Oracle" }).click();
    await expect(admin.getByRole("region", { name: "Oracle's order" })).toHaveCount(0);
    await admin.getByRole("radio", { name: "Oracle's" }).click();
    const oracle = admin.getByRole("region", { name: "Oracle's order" });
    await expect(oracle.locator('[data-code="alert-mobile"]').getByTestId("oracle-why")).toHaveText("Yours: #3. Admin moved it: “Needed for the audit in November”");
    await admin.getByRole("radio", { name: "Yours" }).click();
    await expect(admin.getByRole("list", { name: "Ranked list" })).toBeVisible();

    await admin.getByRole("tab", { name: "Goal buckets" }).click();
    await expect(admin.getByTestId("bucket-bar")).toBeHidden();
    await expect(admin.getByTestId("goal-bucket")).toHaveCount(3);
  });

  /**
   * Card simple-priorities-phone-flow: protects = on a phone the flow thumbnail opens a
   * full-height sheet instead of widening the card; fails_when = the sheet does not open or
   * the card widens off-screen; no_claim = S10's bundles.
   */
  test("a proposal's flow opens a full-height sheet on a phone", async ({ page }) => {
    const cory = await as(page, "commenter@example.com");
    await cory.getByRole("button", { name: "Drag alert-mobile to reorder" }).focus();
    await cory.keyboard.press("ArrowUp");
    await giveReason(cory, "alert-mobile", "Push first", "Propose");
    const card = row(cory, "alert-mobile").getByTestId("prio-proposal");
    await card.getByRole("button", { name: "Open the flow for alert-mobile" }).click();
    await expect(card).toHaveAttribute("data-wide", "false");
    await expect(cory.getByTestId("flow-sheet")).toContainText("Snooze and Assign buttons");
  });

  /**
   * Card simple-priorities-viewer: protects = a viewer reads the list, buckets and 2x2 but
   * gets no drag handles, no Confirm or Merge; fails_when = a viewer is offered a change;
   * no_claim = the API's 403 (pytest test_viewer_reads_and_runs_are_refused).
   */
  test("a viewer reads and is offered no change", async ({ page }) => {
    const viewer = await as(page, "viewer@example.com");
    await expect(viewer.getByRole("button", { name: /^Drag / })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Confirm" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Merge" })).toHaveCount(0);
    expect(await codes(viewer)).toEqual(ORACLE);
  });
});
