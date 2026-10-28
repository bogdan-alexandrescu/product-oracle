import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 1, docs lane: the Publish page. Saved carts v2 (a PRD: no section reviewed, one
// critical advisory check, two hard checks N/A) and the Usage alerts roadmap v1 (its date
// Dec 15, 2026 lost its schedule basis, so its approve is refused).

type Role = "viewer" | "commenter" | "approver" | "owner";

async function open(page: Page, slug: string, role: Role = "owner", scenario?: string) {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [
    MOCK_ROLE_KEY,
    role,
  ] as const);
  if (scenario)
    await page.addInitScript(([sk, s]) => localStorage.setItem(sk, s), [
      MOCK_SCENARIO_KEY,
      scenario,
    ] as const);
  await login(page);
  await page.goto(`/documents/${slug}/publish`);
  await expect(page.getByTestId("publish-readiness")).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("qa-docs-2: a roadmap's publish page lists the date that blocks it, before Publish", async ({
      page,
    }) => {
      await open(page, "usage-alerts-roadmap");
      await expect(page.getByTestId("blocks-chip")).toHaveText("1 block");
      const block = page.getByTestId("block-row");
      await expect(block).toHaveCount(1);
      await expect(block).toContainText("Dec 15, 2026");
      await expect(block).not.toContainText("2026-12-15");
      await expect(page.getByTestId("publish-button")).toBeDisabled();
      await expect(page.getByTestId("publish-ready")).toHaveCount(0);
    });

    test("review: a published roadmap lists no blocks, though a date's basis was withdrawn since", async ({
      page,
    }) => {
      // "approved-plan": usage-alerts-roadmap v1 is published; its Dec 15, 2026 date has
      // since lost its schedule basis.
      await open(page, "usage-alerts-roadmap", "owner", "approved-plan");
      await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
      await expect(page.getByTestId("blocks-chip")).toHaveText("0 blocks");
      await expect(page.getByTestId("block-row")).toHaveCount(0);
    });

    test("qa-docs-3: the headline says what is still open, as the dialog does", async ({
      page,
    }) => {
      await open(page, "saved-carts");
      await expect(page.getByTestId("blocks-chip")).toHaveText("0 blocks");
      const headline = page.getByTestId("publish-ready");
      await expect(headline).toHaveText(
        /^Publishable, but (\d+) sections are not reviewed and 1 advisory check is critical$/,
      );
      const n = (await headline.innerText()).match(/(\d+) sections/)![1];
      await page.getByTestId("publish-button").click();
      const dialog = page.getByRole("dialog", { name: "Publish v2?" });
      await expect(dialog.getByTestId("unreviewed-sections")).toHaveText(
        `${n} of ${n} sections are not reviewed`,
      );
    });

    test("qa-docs-23: a viewer is told who can publish, not 'Ready to publish'", async ({
      page,
    }) => {
      await open(page, "saved-carts", "viewer");
      await expect(page.getByTestId("publish-ready")).toHaveText(
        "Only an approver or owner can publish v2",
      );
      await expect(page.getByTestId("publish-button")).toHaveCount(0);
      await expect(page.getByText("Ready to publish")).toHaveCount(0);
    });

    test("qa-docs-57: check names wrap in full; a hard check that does not apply shows N/A, not a tick", async ({
      page,
    }) => {
      await open(page, "saved-carts");
      const name = page
        .getByText("Validation plan, success metrics and decision thresholds", {
          exact: true,
        })
        .first();
      await expect(name).toBeVisible();
      expect(
        await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      const na = page.getByTestId("hard-check").filter({ hasText: "N/A" });
      expect(await na.count()).toBeGreaterThan(0);
      for (const row of await na.all()) {
        await expect(row.getByTestId("hard-na")).toBeVisible();
      }
    });
  });
}
