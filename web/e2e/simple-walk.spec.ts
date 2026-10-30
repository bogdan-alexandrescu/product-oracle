import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * Simple S9: Home's "Walk me through it", in the "simple-chat" mock scenario: the owner has
 * broken links to fix (the roadmap's red flags), decisions waiting, one decision on the agenda of the
 * next meeting (Weekly plan review), and the commenter's three proposals waiting. Every test
 * runs on desktop (1366x820) and on a phone (390x844); one runs in dark.
 */

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

async function startWalk(page: Page): Promise<number> {
  await tap(page.getByRole("button", { name: "Walk me through it" }));
  const progress = page.getByTestId("walk-progress");
  await expect(progress).toHaveText(/^1 of \d+$/);
  return Number((await progress.textContent())!.split(" of ")[1]);
}

const step = (page: Page) => page.getByTestId("walk-step");

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

for (const phone of [false, true]) {
  for (const scheme of phone ? (["light"] as const) : (["light", "dark"] as const)) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.beforeEach(async ({ context, page }) => {
        await context.addInitScript(
          ([key, themeKey, theme]) => {
            localStorage.setItem(key, "simple-chat");
            localStorage.setItem(themeKey, theme);
          },
          [MOCK_SCENARIO_KEY, THEME_KEY, scheme],
        );
        await page.emulateMedia({ colorScheme: scheme });
        if (phone) await page.setViewportSize({ width: 390, height: 844 });
      });

      test(`the walk goes broken links, agenda decisions, proposals, with progress, then Done (${where})`, async ({ page }) => {
        // protects: one step at a time in the order broken links -> decisions waiting for me -> the next meeting's agenda decisions -> proposals, progress "n of N", Accept on a proposal through the change engine, Done returning to Home
        // fails_when: the order differs, progress does not count, Accept does not decide the proposal, or Done leaves the walk on screen
        // no_claim: which broken links the roadmap has (the roadmap's own specs), the decision page behind the agenda link
        await signIn(page);
        if (scheme === "dark") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        const total = await startWalk(page);
        const kinds: string[] = [];
        for (let n = 1; n <= total; n++) {
          await expect(page.getByTestId("walk-progress")).toHaveText(`${n} of ${total}`);
          const kind = (await step(page).getAttribute("data-kind"))!;
          kinds.push(kind);
          if (kind === "proposal" && !kinds.slice(0, -1).includes("proposal")) {
            await tap(step(page).getByRole("button", { name: "Accept" }));
            await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
          } else if (kind === "agenda_decision") {
            await expect(step(page).getByRole("link", { name: "Open the decision" })).toBeVisible();
            await expect(step(page).getByRole("button", { name: "Next" })).toHaveCount(0);
            await tap(page.getByRole("button", { name: "Skip" }));
          } else await tap(page.getByRole("button", { name: "Skip" }));
        }
        const order = ["broken_link", "decision", "agenda_decision", "proposal"];
        expect(kinds.map((k) => order.indexOf(k))).toEqual([...kinds.map((k) => order.indexOf(k))].sort());
        expect(kinds).toContain("broken_link");
        expect(kinds.filter((k) => k === "agenda_decision")).toHaveLength(1);
        expect(kinds.filter((k) => k === "proposal")).toHaveLength(3);
        await expect(page.getByTestId("walk-finished")).toBeVisible();
        await tap(page.getByRole("button", { name: "Done" }));
        await expect(page.getByTestId("walk")).toHaveCount(0);
        await expect(page.getByTestId("home-proposals").getByTestId("home-proposal")).toHaveCount(2);
      });

      if (scheme === "light") {
        test(`Undo undoes the last fix or goes back a step; typing answers too (${where})`, async ({ page }) => {
          // protects: a broken link's one-click fix applies and moves on; Undo undoes that change and comes back to its step, open again; after Skip, Undo goes back a step; typing to Oracle on a step shows the cards it returns
          // fails_when: Undo leaves the fix applied, does not return to the step, or the typed line shows no card
          // no_claim: undoing an accepted proposal (the change engine's own rules)
          await signIn(page);
          const total = await startWalk(page);
          await expect(step(page)).toHaveAttribute("data-kind", "broken_link");
          const title = await step(page).getByTestId("walk-step-title").textContent();
          await tap(step(page).getByTestId("chat-card-fix").first());
          await expect(page.getByTestId("walk-progress")).toHaveText(`2 of ${total}`);
          await tap(page.getByRole("button", { name: "Undo" }));
          await expect(page.getByText("Undone", { exact: true })).toBeVisible();
          await expect(page.getByTestId("walk-progress")).toHaveText(`1 of ${total}`);
          await expect(step(page).getByTestId("walk-step-title")).toHaveText(title!);
          await expect(step(page).getByTestId("chat-card")).toHaveAttribute("data-status", "open");

          await tap(page.getByRole("button", { name: "Skip" }));
          await expect(page.getByTestId("walk-progress")).toHaveText(`2 of ${total}`);
          await tap(page.getByRole("button", { name: "Undo" }));
          await expect(page.getByTestId("walk-progress")).toHaveText(`1 of ${total}`);

          await step(page).getByLabel("Or type what to do").fill("move Weekly alert digest to Q2");
          await tap(step(page).getByTestId("walk-type").getByRole("button", { name: "Send" }));
          const reply = step(page).getByTestId("walk-reply");
          await expect(reply.getByTestId("chat-card")).toContainText("Move Weekly alert digest to Apr 1");
          await expect(reply.getByRole("button", { name: "Apply" })).toBeEnabled();
          await tap(page.getByRole("button", { name: "Done" }));
          await expect(page.getByTestId("home-greeting")).toBeVisible();
        });
      }
    });
  }
}
