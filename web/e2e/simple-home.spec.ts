import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY, MOCK_SLOW_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * #723 S1 restyle and Simple's Home ("Brief as cards", the owner's picks of 2026-10-26), in the
 * "simple-home" mock scenario: Simple's roadmap items serve three confirmed goals (Grow
 * retention, Faster activation, and the guardrail Keep alerts quiet); the commenter proposed two
 * line edits and a new task (routed to the owners); the approver decides usage caps.
 *
 * Every test runs on desktop and on a phone (390 px), in light and dark.
 *
 * Card simple-home: protects = the 232 px rail with labels, yellow counts only where something
 * waits, Ask Oracle and the person; the goal band's statuses, target paths and guardrail tag;
 * the summary card's counts and working-draft line; Decide with the proposed option and with
 * another; Accept and Decline a proposal; a broken link's Move dependents (applied, Undo) and
 * Accept as risk; a commenter's proposals waiting, no Accept and fixes as proposals; a viewer
 * reading only; a failed block with Retry; loading; the empty company; a long list's "more";
 * the flow thumbnail widening in place; fails_when = any of those is missing, an action does
 * not reach the API through the UI, or a role sees an action its permissions refuse;
 * no_claim = the real API's answers (api/tests cover them), S4-S9's pages (Roadmap, Meetings,
 * Decisions, "Walk me through it"), S10's flow bundles (none is served yet: "No flow yet").
 */

const EMAILS = { owner: ADMIN.email, approver: "approver@example.com", commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

const card = (page: Page, id: string) => page.getByTestId(`home-${id}`);

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;

    test.describe(where, () => {
      test.beforeEach(async ({ page, context }) => {
        await context.addInitScript(
          ([key, themeKey, theme]) => {
            localStorage.setItem(key, "simple-home");
            localStorage.setItem(themeKey, theme);
          },
          [MOCK_SCENARIO_KEY, THEME_KEY, scheme],
        );
        await page.emulateMedia({ colorScheme: scheme });
        if (phone) await page.setViewportSize({ width: 390, height: 844 });
      });

      test(`the rail and the goal band (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.owner);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        if (phone) {
          // Phone: a top bar with Ask and the avatar, a bottom tab bar Home · One-pagers · Roadmap · Decisions · More.
          await expect(page.getByTestId("phone-ask")).toBeVisible();
          await expect(page.getByTestId("phone-user-menu")).toBeVisible();
          await expect(page.getByTestId("simple-tab-bar").getByRole("link")).toHaveText(["Home", "One-pagers", "Roadmap", "Decisions"]);
          await page.getByTestId("simple-tab-more").click();
          await expect(page.getByRole("dialog", { name: "More" }).getByRole("radio", { name: "Detailed" })).toBeVisible();
          await page.getByTestId("simple-tab-more").click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        } else {
          const rail = page.getByTestId("simple-nav");
          expect((await rail.boundingBox())!.width).toBe(232);
          await expect(rail.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
          // Labels beside the icons at 18 px.
          const home = page.getByTestId("simple-nav-home");
          expect(await home.evaluate((el) => getComputedStyle(el).fontSize)).toBe("18px");
          // A yellow count only where something waits on me: the commenter's three proposals on the Roadmap.
          await expect(page.getByTestId("simple-nav-roadmap-count")).toHaveText("3");
          await expect(page.getByTestId("simple-nav-one-pagers-count")).toHaveCount(0);
          await expect(page.getByTestId("simple-nav-priorities-count")).toHaveCount(0);
          await expect(page.getByTestId("simple-person")).toContainText(/owner/i);
          await page.getByTestId("simple-ask").click();
          await expect(page.getByTestId("hop-drawer")).toBeVisible();
        }

        await expect(page.getByTestId("home-sentence")).toContainText("3 proposals");
        const goals = page.getByTestId("home-goal");
        await expect(goals).toHaveCount(3);
        const retention = goals.filter({ hasText: "Grow retention" });
        await expect(retention).toContainText("G-R");
        await expect(retention).toContainText("weight 3");
        await expect(retention.getByTestId("home-goal-path")).toHaveText("From 50 teams · now 100 teams · target 200 teams with weekly alerts on");
        await expect(retention.getByTestId("home-goal-status")).toHaveText("At risk");
        await expect(retention.getByTestId("home-goal-need")).toContainText("need you");
        await expect(goals.filter({ hasText: "Faster activation" }).getByTestId("home-goal-status")).toHaveText("Not measured yet");
        const quiet = goals.filter({ hasText: "Keep alerts quiet" });
        await expect(quiet.getByTestId("home-goal-status")).toHaveText("Not counted yet");
        await expect(quiet).toContainText("guardrail");
        // The plan strip: the PRD in play by month, its rows with their item counts (no per-item bars), today's line.
        await expect(card(page, "plan").getByTestId("home-strip-today")).toHaveCount(1);
        await expect(card(page, "plan").getByTestId("home-strip-label").first()).toHaveText(/ · \d+ items?$/);
        await expect(card(page, "plan").getByTestId("home-strip-bar")).toHaveCount(0);
        await expect(card(page, "plan").getByTestId("home-strip-month").first()).toBeVisible();
      });

      test(`an owner accepts and declines proposals, fixes a broken link with Undo, and sees the draft (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.owner);
        const proposals = card(page, "proposals");
        await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
        await expect(card(page, "summary").getByTestId("home-summary-proposals")).toContainText("3");
        const retitle = proposals.getByTestId("home-proposal").filter({ hasText: "Retitle" });
        await expect(retitle.getByTestId("home-row-change")).toContainText("Alert history export");
        await expect(retitle.getByTestId("home-row-change")).toContainText("Alert history as CSV");
        // A new task carries its flow thumbnail; it widens in place ("No flow yet": S10 draws them).
        const task = proposals.getByTestId("home-proposal").filter({ hasText: "Add a task" });
        await task.getByTestId("home-flow-thumb").click();
        await expect(task.getByTestId("home-flow-wide")).toContainText("No flow yet");

        await retitle.getByRole("button", { name: "Accept" }).click();
        await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
        await expect(proposals.getByTestId("home-proposal")).toHaveCount(2);
        // Accepting applied it to the roadmap's working draft: the summary says so.
        await expect(page.getByTestId("home-draft")).toContainText("Your working draft of Alerts roadmap has 1 change.");
        await expect(page.getByTestId("home-draft")).toContainText("It publishes as v");
        await proposals.getByTestId("home-proposal").filter({ hasText: "Move to another horizon" }).getByRole("button", { name: "Decline" }).click();
        await expect(proposals.getByTestId("home-proposal")).toHaveCount(1);
        if (!phone) await expect(page.getByTestId("simple-nav-roadmap-count")).toHaveText("1");

        // A broken dependency: Move dependents applies into the roadmap's working draft, with Undo.
        const broken = card(page, "plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" });
        await expect(broken).toContainText("which it depends on, ends");
        await broken.getByRole("button", { name: "Move dependents" }).click();
        await expect(page.getByText("Move dependents: applied to your working draft")).toBeVisible();
        await expect(card(page, "plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" })).toHaveCount(0);
        await expect(page.getByTestId("home-draft")).toContainText("Your working draft of Alerts roadmap has 2 changes");
        await expect(page.getByTestId("home-draft").getByRole("link", { name: "Open draft" })).toBeVisible();
        await expect(card(page, "since").getByTestId("home-since-row").filter({ hasText: "Dependents moved after" })).toBeVisible();
        await page.getByRole("button", { name: "Undo" }).click();
        await expect(card(page, "plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" })).toBeVisible();

        // Accept as risk asks for its one-line note.
        const mobile = card(page, "plan").getByTestId("home-broken").filter({ hasText: "Mobile alert push" });
        await mobile.getByRole("button", { name: "Accept as risk" }).click();
        await mobile.getByLabel("Why the risk is acceptable").fill("Push ships behind a flag");
        await mobile.getByRole("button", { name: "Accept the risk" }).click();
        await expect(page.getByText("Accept as a risk: applied to your working draft")).toBeVisible();
        await expect(card(page, "plan").getByTestId("home-broken").filter({ hasText: "Mobile alert push" })).toHaveCount(0);
      });

      test(`an approver decides with the proposed option or chooses another (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.approver);
        const decisions = card(page, "decisions");
        const caps = decisions.getByTestId("home-decision").filter({ hasText: "Ship usage caps before anomaly detection" });
        await expect(caps).toContainText("Proposed: Caps first");
        await caps.getByRole("button", { name: "Choose another option" }).click();
        await expect(caps.getByRole("group", { name: "Other options" }).getByRole("button", { name: "Ship together" })).toBeVisible();
        await caps.getByRole("button", { name: "Decide: Caps first" }).click();
        await expect(page.getByText("Decided: Caps first")).toBeVisible();
        await expect(decisions.getByTestId("home-decision").filter({ hasText: "Ship usage caps" })).toHaveCount(0);
      });

      test(`a commenter sees their proposals waiting, no Accept, and proposes fixes (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.commenter);
        const proposals = card(page, "proposals");
        await expect(proposals.getByRole("heading", { name: "Your proposals waiting" })).toBeVisible();
        await expect(proposals.getByTestId("home-proposal")).toHaveCount(3);
        await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
        const broken = card(page, "plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" });
        await expect(broken).toContainText("Admin decides");
        await broken.getByRole("button", { name: "Propose: Move dependents" }).click();
        await expect(page.getByText(/^Proposed: .+ decides?$/)).toBeVisible();
        // A long list: the top three, the rest behind "more".
        await expect(proposals.getByTestId("home-proposal")).toHaveCount(3);
        await expect(proposals.getByTestId("home-more")).toHaveText("1 more ->");
        await expect(page.getByTestId("home-summary-proposals")).toContainText("4");
      });

      test(`a viewer reads only (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.viewer);
        await expect(page.getByTestId("home-sentence")).toHaveText("Here is where the plan stands.");
        await expect(page.getByTestId("home-goal")).toHaveCount(3);
        await expect(page.getByTestId("home-summary")).toHaveCount(0);
        await expect(card(page, "next-milestone")).toContainText("Weekly alert digest");
        await expect(card(page, "decided").getByTestId("home-decided-row").first()).toBeVisible();
        await expect(card(page, "read").getByRole("link").first()).toBeVisible();
        await expect(page.locator("main").getByRole("button", { name: /Accept|Decline|Decide|Move|Propose/ })).toHaveCount(0);
      });

      test(`one block fails and Retries while the rest shows; loading (${where})`, async ({ page, context }) => {
        await context.addInitScript(
          ([fail, slow]) => {
            if (!sessionStorage.getItem("e2e-once")) {
              localStorage.setItem(fail, "/v1/simple/meetings");
              localStorage.setItem(slow, "/v1/simple/roadmap");
              sessionStorage.setItem("e2e-once", "1");
            }
          },
          [MOCK_FAIL_KEY, MOCK_SLOW_KEY],
        );
        await signIn(page, EMAILS.owner);
        // The roadmap answers late: its card says it is loading meanwhile.
        await expect(card(page, "plan").getByRole("status")).toHaveText("Loading…");
        await expect(card(page, "meeting").getByTestId("home-meeting-failed")).toContainText("could not load");
        await expect(card(page, "proposals").getByTestId("home-proposal").first()).toBeVisible();
        await page.evaluate((fail) => localStorage.removeItem(fail), MOCK_FAIL_KEY);
        await card(page, "meeting").getByRole("button", { name: "Retry" }).click();
        await expect(card(page, "meeting").getByTestId("home-meeting-next")).toBeVisible();
        await expect(card(page, "meeting").getByRole("link", { name: "Start meeting" })).toBeVisible();
      });
    });
  }
}

test("a new company's Home says what it has not got yet", async ({ page, context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
  await signIn(page, EMAILS.owner);
  await expect(page.getByTestId("home-goals-empty")).toBeVisible();
  await expect(page.getByTestId("home-proposals-empty")).toBeVisible();
  await expect(page.getByTestId("home-decisions-empty")).toBeVisible();
  await expect(page.getByTestId("home-since-empty")).toBeVisible();
});
