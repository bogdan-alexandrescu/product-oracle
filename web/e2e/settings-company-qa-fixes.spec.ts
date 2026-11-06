import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * Pre-demo visual QA on Publish, Settings (Members, API tokens, Sources) and Company (Metrics,
 * Strategy): D-1, D-7 to D-11. Driven through the UI on the mock, as the owner and as a
 * viewer, at 1440 in light and dark. Each test names the finding it protects.
 */

type Role = "owner" | "viewer";

async function setUp(page: Page, role: Role, scheme: "light" | "dark", scenario?: string) {
  await page.addInitScript(
    ([roleKey, r, themeKey, theme, scenarioKey, s]) => {
      if (r !== "owner") localStorage.setItem(roleKey, r);
      localStorage.setItem(themeKey, theme);
      if (s) localStorage.setItem(scenarioKey, s);
    },
    [MOCK_ROLE_KEY, role, THEME_KEY, scheme, MOCK_SCENARIO_KEY, scenario ?? ""] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  if (scheme === "dark") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

/** Whether the text is cut: wider than its own box, or past the edge of a clipping box around it. */
async function isCut(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const e = node as HTMLElement;
    if (e.scrollWidth > e.clientWidth + 1) return true;
    const r = e.getBoundingClientRect();
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "visible" && s.textOverflow !== "ellipsis") continue;
      const b = p.getBoundingClientRect();
      if (r.right > b.right + 1 || r.left < b.left - 1) return true;
      if (p.scrollWidth > p.clientWidth + 1 && s.overflowX !== "auto" && s.overflowX !== "scroll") return true;
      if (p.matches("td, [role=cell], li")) break;
    }
    return false;
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop 1440, ${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test(`D-1: a viewer sees no Resolve and no On publish; the owner sees both (${scheme})`, async ({ page }) => {
      await setUp(page, "viewer", scheme);
      await page.goto("/documents/online-deposits/publish");
      const rows = page.getByTestId("block-row");
      await expect(rows.first()).toContainText("Critical blocker");
      await expect(page.getByTestId("publish-role")).toContainText("Only an approver or owner can publish");
      await expect(rows.getByRole("link", { name: "Resolve" })).toHaveCount(0);
      const inspector = page.getByTestId("publish-inspector");
      await expect(inspector).toBeVisible();
      await expect(inspector).not.toContainText("On publish");
    });

    test(`D-1: the owner keeps Resolve and On publish (${scheme})`, async ({ page }) => {
      await setUp(page, "owner", scheme);
      await page.goto("/documents/online-deposits/publish");
      const rows = page.getByTestId("block-row");
      await expect(rows.first().getByRole("link", { name: "Resolve" })).toBeVisible();
      await expect(page.getByTestId("publish-inspector")).toContainText("On publish");
    });

    test(`D-7: Members shows whole emails and no sign-in prose (${scheme})`, async ({ page }) => {
      await setUp(page, "owner", scheme);
      await page.goto("/settings/members");
      const emails = page.getByTestId("member-email").filter({ visible: true });
      await expect(emails.first()).toBeVisible();
      await expect(page.getByText("Who may sign in from Google", { exact: false })).toBeHidden();
      for (const e of await emails.all()) expect(await isCut(e), await e.innerText()).toBe(false);
    });

    test(`D-8: API tokens: where tokens come from is behind the (i); names are whole (${scheme})`, async ({ page }) => {
      await setUp(page, "owner", scheme);
      await page.goto("/settings/api-tokens");
      const rows = page.getByTestId("token-row");
      await expect(rows.first()).toBeVisible();
      await expect(page.getByTestId("tokens-made-where")).toBeHidden();
      for (const r of await rows.all()) {
        const name = r.locator("td").first().locator("span.font-medium").first();
        expect(await isCut(name), await name.innerText()).toBe(false);
      }
    });

    for (const role of ["owner", "viewer"] as const) {
      test(`D-9: each metric shows Result or Driver beside its name, as its panel does (${role}, ${scheme})`, async ({ page }) => {
        await setUp(page, role, scheme, "metrics");
        await page.goto("/company/metrics");
        const row = page.getByTestId("metric-row").filter({ hasText: "Weekly active teams" });
        await expect(row.getByTestId("metric-kind")).toHaveText("Result");
        await expect(page.getByTestId("metric-row").filter({ hasText: "Invites sent per team" }).getByTestId("metric-kind")).toHaveText("Driver");
        // The panel open beside the list: the chip stays.
        await row.click();
        await expect(page.getByTestId("metric-inspector").filter({ visible: true })).toContainText("Result");
        await expect(row.getByTestId("metric-kind")).toBeVisible();
      });
    }

    test(`D-10: Sources rows carry a short badge, the sentence behind the (i) (${scheme})`, async ({ page }) => {
      await setUp(page, "owner", scheme);
      await page.goto("/settings/sources");
      const skipped = page.getByRole("listitem", { name: "Skipped: #partner-launch" });
      await expect(skipped.getByText("Skipped", { exact: true })).toBeVisible();
      await expect(skipped.getByText("shared from outside the company", { exact: false })).toBeHidden();
      await expect(page.getByText("Nothing to do", { exact: false }).filter({ visible: true })).toHaveCount(0);
      await expect(page.getByText("can’t read it with your account", { exact: false }).filter({ visible: true })).toHaveCount(0);
      await skipped.getByRole("button", { name: /why #partner-launch is skipped/ }).click();
      await expect(page.getByRole("tooltip").filter({ visible: true })).toContainText("Shared from outside the company");
    });

    for (const role of ["owner", "viewer"] as const) {
      test(`D-11: Strategy's empty cards keep only the (i) and the action (${role}, ${scheme})`, async ({ page }) => {
        await setUp(page, role, scheme);
        await page.goto("/company/strategy");
        const vision = page.getByTestId("vision-empty").filter({ visible: true });
        await expect(vision).toContainText("No vision yet");
        for (const line of ["to start the strategy stack", "to line up the goals under it", "Start one on the Product strategy card", "An owner writes it"]) {
          await expect(page.getByText(line, { exact: false }).filter({ visible: true })).toHaveCount(0);
        }
        await expect(vision.getByRole("button", { name: /the vision/ })).toBeVisible();
        if (role === "owner") await expect(page.getByTestId("vision-card").getByRole("button", { name: /vision/i }).last()).toBeVisible();
      });
    }
  });
}
