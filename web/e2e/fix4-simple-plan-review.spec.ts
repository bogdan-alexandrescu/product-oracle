import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix4-simple-plan review (/simple/priorities): the minors the review left, driven through the
 * UI as a person would on the mock: the score's confidence on every row (qa-simple-plan-3), a
 * goal value down to 0 (-6), a proposer withdrawing a proposal (-30), a look-alike's link to its
 * own row and a plain "Same as this" (-34), and a tab picked early surviving a reload (-42).
 */

const PHONE = { width: 390, height: 844 };
const COMMENTER = "commenter@example.com";

async function setUp(page: Page, opts: { scheme?: "light" | "dark"; scenario?: string; email?: string; phone?: boolean } = {}) {
  const { scheme = "light", scenario = null, email = ADMIN.email, phone = false } = opts;
  await page.setViewportSize(phone ? PHONE : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

const rowByTitle = (page: Page, title: string): Locator => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title, { exact: true }) });
const toast = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });

test.describe("fix4-simple-plan review: Priorities", () => {
  /* qa-simple-plan-3: each scored row shows Oracle's confidence, and value × confidence ÷ effort gives its score. */
  for (const v of [
    { name: "desktop, light", phone: false, scheme: "light" as const },
    { name: "phone, dark", phone: true, scheme: "dark" as const },
  ])
    test(`every score can be worked out from the row (${v.name})`, async ({ page }) => {
      await setUp(page, { phone: v.phone, scheme: v.scheme });
      await open(page);
      const rows = page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-score") });
      await expect(rows.first()).toBeVisible();
      for (const r of await rows.all()) {
        const conf = Number(/^confidence ([\d.]+)$/.exec((await r.getByTestId("prio-confidence").textContent()) ?? "")?.[1]);
        const m = /^value ([\d.]+) · ([\d.]+) wk · score ([\d.]+)$/.exec((await r.getByTestId("prio-numbers").textContent()) ?? "");
        expect(m, (await r.textContent()) ?? "").not.toBeNull();
        const [, value, effort, score] = m!.map(Number);
        expect(conf).toBeGreaterThan(0);
        expect(conf).toBeLessThanOrEqual(1);
        expect(Math.abs((value * conf) / effort - score)).toBeLessThan(0.011);
      }
      // Nothing spills sideways, even on a phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

  /* qa-simple-plan-6: ArrowDown takes a goal value all the way to 0. */
  test("a goal value goes down to 0 with the arrow keys", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=value-effort");
    const mark = page.locator('[data-testid="vxe-point"][data-code="setup-checklist"]');
    await expect(mark).toBeVisible();
    for (let n = 0; n < 40; n++) {
      const label = (await mark.getAttribute("aria-label")) ?? "";
      if (/goal value 0,/.test(label)) break;
      await mark.focus();
      await page.keyboard.press("ArrowDown");
      await expect(mark).not.toHaveAttribute("aria-label", label);
    }
    await expect(mark).toHaveAttribute("aria-label", /goal value 0,/);
    await mark.click();
    await expect(page.locator('[data-testid="side-row"][data-code="setup-checklist"]').getByTestId("side-numbers")).toHaveText(/^goal value 0 · confidence [\d.]+ · [\d.]+ wk · score 0$/);
  });

  /* qa-simple-plan-30: the person who proposed a move takes it back; nothing changes. */
  test("a proposer withdraws their proposal", async ({ page }) => {
    await setUp(page, { email: COMMENTER });
    await open(page);
    const rank = await rowByTitle(page, "Setup checklist").getByTestId("prio-rank").textContent();
    await page.getByRole("button", { name: "Drag Setup checklist (SC) to reorder" }).focus();
    await page.keyboard.press("ArrowDown");
    const dialog = page.getByRole("dialog", { name: /Why move Setup checklist/ });
    await dialog.getByLabel(/Reason/).fill("Setup first");
    await dialog.getByRole("button", { name: "Propose" }).click();
    const proposal = rowByTitle(page, "Setup checklist").getByTestId("prio-proposal");
    await expect(proposal).toBeVisible();
    await expect(proposal.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await proposal.getByRole("button", { name: "Withdraw" }).click();
    await expect(toast(page, "Withdrew your proposal for Setup checklist")).toBeVisible();
    await expect(rowByTitle(page, "Setup checklist").getByTestId("prio-proposal")).toHaveCount(0);
    await expect(rowByTitle(page, "Setup checklist").getByTestId("prio-rank")).toHaveText(rank!);
  });

  /* qa-simple-plan-34: a look-alike links to its own row (marked there); its button says what it does. */
  test("a look-alike opens its own row and says it declines the suggestion", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page, "?tab=buckets");
    await page.getByTestId("goal-ask-oracle").first().click();
    const drawer = page.getByTestId("goal-panel");
    const looks = drawer.getByTestId("suggestion-looks-like");
    await expect(looks.first()).toBeVisible({ timeout: 15_000 });
    await expect(looks.first().getByTestId("looks-like-merge")).toHaveText("Same as this: decline the suggestion");
    const link = looks.first().getByTestId("looks-like-link");
    const title = ((await link.textContent()) ?? "").trim();
    await link.click();
    await expect(page).toHaveURL(/show=/);
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Ranked list" })).toHaveAttribute("aria-selected", "true");
    const shown = page.locator('[data-shown="true"]');
    await expect(shown).toHaveCount(1);
    await expect(shown).toBeInViewport();
    await expect(shown).toContainText(title.replace(/^[A-Z]{1,3}-\d+ /, ""));
  });

  /* qa-simple-plan-42: a tab clicked while the remembered line is put back stays after a reload. */
  test("a tab picked as the page loads survives a reload", async ({ page }) => {
    await setUp(page);
    await open(page);
    const select = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
    const kd = (await select.locator("option").nth(1).getAttribute("value"))!;
    await select.selectOption(kd);
    await expect(page).toHaveURL(/line=/);
    // Remembered (the mock keeps the person's pick in this browser's storage) before leaving.
    await expect.poll(() => page.evaluate((v) => (localStorage.getItem("po-mock-db-v2") ?? "").includes(v), kd)).toBe(true);
    await page.goto("/home");
    await page.goto("/simple/priorities");
    await page.getByRole("tab", { name: "Value / effort" }).click();
    await expect(page).toHaveURL(/line=/);
    await expect(page).toHaveURL(/tab=value-effort/);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Value / effort" })).toHaveAttribute("aria-selected", "true");
  });
});
