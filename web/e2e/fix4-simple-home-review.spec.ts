import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * The fix4-simple-home review's minors on Simple's Home (mock-backed, through the UI only):
 * the greeting names what waits and leaves the counts to the tiles (qa-simple-home-15), a goal's
 * share line sits with its name, the phone tab bar's labels are whole, and a question's "Blocks"
 * line shows no code. Each test fails without its fix.
 * no_claim: the welcome's dismissal (fix4-simple-home-welcome.spec.ts), Move the dependents' words
 * (fix4-simple-home.spec.ts).
 */

async function signIn(page: Page, email: string, scenario: string) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-home-review")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-home-review", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, scenario] as const,
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(home(page).getByTestId("home-sentence")).toBeVisible();
}

const home = (page: Page) => page.getByTestId("simple-page");

/** Each goal's share line starts where its name starts, or right after its guardrail tag. */
async function shareBesideName(page: Page) {
  const goals = home(page).getByTestId("home-goal").filter({ has: page.getByTestId("home-goal-weight") });
  await expect(goals.first()).toBeVisible();
  for (const goal of await goals.all()) {
    const share = (await goal.getByTestId("home-goal-weight").boundingBox())!;
    const name = (await goal.getByTestId("home-goal-link").boundingBox())!;
    const tag = goal.locator(".simple-tag");
    const t = (await tag.count()) ? await tag.boundingBox() : null;
    // On the tag's line it follows the tag; on its own line it starts with the name.
    const start = t && Math.abs(t.y - share.y) < t.height ? t.x + t.width : name.x;
    expect(share.x - start).toBeLessThan(16);
  }
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-simple-home-15: the greeting names what waits; the counts are the tiles' alone", async ({ page }) => {
    // fails_when: the sentence repeats the tiles' numbers ("9 decisions and 5 broken links wait on you")
    await signIn(page, ADMIN.email, "simple-home");
    const decisions = home(page).getByTestId("home-summary-decisions").locator(".simple-number");
    await expect(decisions).toHaveText(/^\d+$/);
    const sentence = home(page).getByTestId("home-sentence");
    await expect(sentence).toHaveText(/^[A-Z][^\d]* wait on you\./);
    await expect(sentence).toContainText(/decisions/i);
    await expect(sentence).toContainText("broken links");
  });

  test("fix4 review: a goal's share line sits with its name (desktop)", async ({ page }) => {
    await signIn(page, ADMIN.email, "simple-home");
    await shareBesideName(page);
  });

  test("fix4 review: a question's Blocks line on Home names the feature and milestone, no code", async ({ page }) => {
    // fails_when: a code (F-03, M1) shows in the Blocks line
    await signIn(page, ADMIN.email, "simple-home");
    const blocks = home(page).getByTestId("home-decisions").locator(".simple-meta").filter({ hasText: "Blocks " }).first();
    await expect(blocks).toBeVisible();
    await expect(blocks).toHaveText(/Blocks [A-Z][a-z][^:]*, \w+ milestone$/);
    await expect(blocks).not.toHaveText(/\b[A-Z]{1,3}-?\d/);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fix4 review: a goal's share line sits with its name, at the card's start", async ({ page }) => {
    // fails_when: "Counts for N% of each feature's score" is pushed to the card's right edge, away from the name
    await signIn(page, ADMIN.email, "simple-home");
    await shareBesideName(page);
  });

  test("fix4 review: the phone tab bar shows every label whole", async ({ page }) => {
    // fails_when: "One-pagers" is cut to "One-page…" at 390 px
    await signIn(page, ADMIN.email, "simple-home");
    const tab = page.getByTestId("simple-tab-one-pagers");
    await expect(tab).toBeVisible();
    for (const id of ["simple-tab-home", "simple-tab-one-pagers", "simple-tab-roadmap", "simple-tab-decisions"]) {
      const label = page.getByTestId(id).locator(":scope > span:not(.simple-count)");
      // The text's own width (fractional), laid out unclipped in the label's font, against the label's room.
      const [text, room] = await label.evaluate((el) => {
        const probe = el.cloneNode(true) as HTMLElement;
        probe.style.cssText = "position:absolute;visibility:hidden;max-width:none;width:auto;overflow:visible;white-space:nowrap";
        el.parentElement!.appendChild(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return [w, el.parentElement!.getBoundingClientRect().width];
      });
      expect(text, id).toBeLessThan(room - 1);
    }
  });
});
