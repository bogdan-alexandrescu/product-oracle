import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * CLD's production walk (#723, 2026-10-27): how plans and one-pagers read with real data,
 * driven through the UI on a desktop (1366x820) and a phone (390x844), light and dark,
 * against the mock's "simple-walk" scenario (invented data).
 *
 * Card walk-home-strip: protects = Home's "The plan this quarter" draws one row per milestone
 * when its items' milestone texts carry notes ("M1 · Measure it, make it safe (baseline needs
 * the export); ..."): "M1 · Measure it, make it safe · 3 items" once, "M2 · Ship to beta · 2
 * items" once, the items with no milestone in their own row, no note in any label;
 * fails_when = a row per distinct milestone text (the same truncated label repeated) or a
 * note in a label; no_claim = which PRD Home picks (simple-plan-strip.spec.ts).
 *
 * Card walk-one-pager-timeline: protects = the one-pager's Timeline strip groups the same way
 * (M1 · 3, M2 · 2, No milestone · 1) and a row still opens the roadmap filtered to the PRD;
 * fails_when = five noted milestone texts draw five rows; no_claim = the PDF's drawing (the
 * API's plan_strip cases, api/tests/test_simple_one_pager_review.py).
 *
 * Card walk-problem-line: protects = a long "Problem and who has it" line folds at a sentence
 * end (the owner's P5, prd-timeline), "Show all" expands it in place to the whole text and
 * "Show less" folds it back; fails_when = the line is cut mid-sentence, or the whole text
 * cannot be read;
 * no_claim = where the API cuts (its pytest).
 *
 * Card walk-skeleton: protects = a PRD started from an empty skeleton shows no template
 * guidance on its one-pager (no HTML comment, no "<Milestone>: <Feature>" or
 * "<Risk>: <mitigation>" placeholder, no bare "→") and each empty block reads "Not written
 * yet"; fails_when = a template's guidance shows as a line or an empty block reads "—";
 * no_claim = the job's answer (the API's pytest).
 *
 * Card walk-milestone-record (walk-plan review): protects = items a track milestone record
 * links share its row ("Beta launch · 3 items") on Home and on the one-pager, whatever their
 * own milestone texts say ("Beta launch, two teams first", "Beta launch - after legal") and
 * with none; fails_when = the texts split into rows or the linked item with no text of its
 * own counts under "No milestone"; no_claim = which record wins when two link an item.
 *
 * Card walk-edit-whole-line (walk-plan review): protects = editing a shortened line starts
 * from its whole text, so saving it keeps the rest; fails_when = the editor holds the "…"
 * text; no_claim = the save itself (simple-one-pager.spec.ts).
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;

async function setUp(page: Page, scheme: "light" | "dark", email: string) {
  await page.context().addInitScript(
    ([key, themeKey, theme]) => {
      localStorage.setItem(key, "simple-walk");
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      for (const role of ["owner", "viewer"] as const) {
        test(`Home's plan has one row per milestone, notes left out, as ${role} (${where})`, async ({ page }) => {
          await setUp(page, scheme, EMAILS[role]);
          await page.goto("/simple");
          const plan = page.getByTestId("home-plan");
          const labels = plan.getByTestId("home-strip-label");
          await expect(labels.first()).toBeVisible();
          const texts = await labels.allTextContents();
          expect(texts.slice(0, 2)).toEqual(["M1 · Measure it, make it safe · 3 items", "M2 · Ship to beta · 2 items"]);
          expect(texts).toContain("Beta launch · 3 items");
          for (const t of texts) expect(t).not.toMatch(/two teams first|after legal/);
          expect(texts.at(-1)).toMatch(/^No milestone · \d+ items?$/);
          expect(new Set(texts).size).toBe(texts.length);
          for (const t of texts) expect(t).not.toMatch(/[(;]/);
          await plan.getByTestId("home-strip-row").first().click();
          await expect(page).toHaveURL(/\/simple\/roadmap\?prd=guided-setup$/);
        });

        test(`the one-pager's timeline and its problem line, as ${role} (${where})`, async ({ page }) => {
          await setUp(page, scheme, EMAILS[role]);
          await page.goto("/simple/prds/guided-setup");
          const strip = page.getByLabel("Timeline strip");
          await expect(strip.getByTestId("plan-strip-label")).toHaveText(["M1 · Measure it, make it safe · 3 roadmap items", "M2 · Ship to beta · 2 roadmap items", "Beta launch · 3 roadmap items", "No milestone · 1 roadmap item"]);
          await expect(strip).not.toContainText("dry run");

          const problem = page.getByRole("region", { name: "Problem and who has it" });
          const line = problem.getByTestId("one-pager-line-text");
          await expect(line).toHaveText(/hides the invite step\.$/);
          await expect(line).not.toContainText("weekend signup");
          await problem.getByRole("button", { name: "Show all of “New workspace admins stall during" }).click();
          await expect(line).toHaveText(/after a weekend signup\.$/);
          await expect(line).not.toContainText("…");
          await problem.getByRole("button", { name: "Show less of “New workspace admins stall during" }).click();
          await expect(line).toHaveText(/invite step\.$/);
          if (role === "owner") {
            // The editor starts from the whole line, not its "…" text.
            await problem.getByRole("button", { name: "Edit “New workspace admins stall during" }).click();
            await expect(problem.getByLabel("New wording for")).toHaveValue(/after a weekend signup\.$/);
            await problem.getByRole("button", { name: "Cancel" }).click();
          }
          if (!phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
          else expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

          await strip.getByTestId("plan-strip-row").filter({ hasText: "M1 · Measure it, make it safe · 3 roadmap items" }).click();
          await expect(page).toHaveURL(/\/simple\/roadmap\?prd=guided-setup$/);
        });

        test(`a skeleton PRD's one-pager shows no template guidance, as ${role} (${where})`, async ({ page }) => {
          await setUp(page, scheme, EMAILS[role]);
          await page.goto("/simple/one-pagers/checkout-redesign");
          await expect(page.getByRole("heading", { level: 1, name: "Checkout redesign PRD" })).toBeVisible();
          const article = page.locator("article");
          await expect(page.getByTestId("one-pager-empty-block")).toHaveCount(5);
          await expect(page.getByTestId("one-pager-empty-block").first()).toHaveText("Not written yet");
          await expect(article.locator("[data-line]")).toHaveCount(0);
          for (const junk of ["<!--", "Brief:", "<Milestone>", "<Feature>", "<Risk>", "<mitigation>"]) await expect(article).not.toContainText(junk);
          for (const title of ["Problem and who has it", "What we will build", "Outcomes and how we measure them", "Not doing", "Risks and open decisions"]) {
            await expect(page.getByRole("region", { name: title }).getByText("Not written yet")).toBeVisible();
            await expect(page.getByRole("region", { name: title }).locator("ul")).not.toContainText("→");
          }
        });
      }
    });
  }
}
