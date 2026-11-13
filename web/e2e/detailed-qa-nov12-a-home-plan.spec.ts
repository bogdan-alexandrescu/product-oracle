import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA, Nov 12, 2026, Detailed Home and Plan (docs/qa/2026-11-12/detailed-a.md #12, #14,
 * #15), on the mock build, driven as a person would. The default company has no alignment
 * report; the "launches" scenario seeds launches and changelog entries.
 *
 * Cards:
 * - #12: protects=at 1440 In flight's Next and Needs you's Kind read whole (Next wraps to two
 *   lines); fails_when=either is cut with an ellipsis on one line.
 * - #14 links: protects=Launches and Changelog lead to each other only through the Plan strip's
 *   links; fails_when=a Changelog or Launches button sits in the page header too.
 * - #14 empty: protects=Reports and Latest report say the same thing with no report yet;
 *   fails_when=their empty texts differ.
 * - #15: protects=at 390 Changelog (and Launches) show their own name, and Changelog's header
 *   buttons stay on one row, the exports under More; fails_when=the name is for screen readers
 *   only, or the buttons wrap to a second row. no_claim=the phone header, which says Plan.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const scenario = (page: Page, s: string) =>
  page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    s,
  ] as const);
const links = (page: Page) =>
  page.getByTestId("plan-links").filter({ visible: true });
const action = (page: Page) =>
  page.locator("[data-page-action]").filter({ visible: true });

/** Whether each element's text shows whole: not held on one cut line, nothing past its box. */
async function whole(l: Locator) {
  return l.evaluateAll((els) =>
    els
      .filter((el) => (el.textContent ?? "").trim() !== "")
      .map((el) => {
        const s = getComputedStyle(el);
        return {
          text: (el.textContent ?? "").trim(),
          oneCutLine:
            s.whiteSpace === "nowrap" && s.textOverflow === "ellipsis",
          wider: el.scrollWidth > el.clientWidth,
          taller: el.scrollHeight > el.clientHeight + 1,
        };
      }),
  );
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("#12: at 1440 In flight's Next and Needs you's Kind are not cut", async ({
    page,
  }) => {
    await login(page);
    await expect(page.getByTestId("flight-row").first()).toBeVisible();
    const next = await whole(
      page.getByTestId("home-in-flight-table").getByTestId("flight-next"),
    );
    expect(next.length).toBeGreaterThan(0);
    for (const n of next)
      expect(n, n.text).toEqual({
        text: n.text,
        oneCutLine: false,
        wider: false,
        taller: false,
      });

    const needs = page.getByTestId("home-needs-table");
    await expect(needs.locator("tr[data-row]").first()).toBeVisible();
    const kinds = await whole(
      needs.locator("tr[data-row] td:first-child span.font-medium"),
    );
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds)
      expect(k, k.text).toEqual({
        text: k.text,
        oneCutLine: false,
        wider: false,
        taller: false,
      });
  });

  test("#14: Launches and Changelog have no header button to each other; the Plan strip's links go there", async ({
    page,
  }) => {
    await scenario(page, "launches");
    await login(page);
    await page.goto("/plan");
    await links(page).getByRole("link", { name: "Launches" }).click();
    await expect(page).toHaveURL(/\/roadmap\/launches$/);
    await expect(page.getByTestId("launch-row").first()).toBeVisible();
    await expect(
      action(page).getByRole("link", { name: "Changelog" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("changelog-link")).toHaveCount(0);

    await links(page).getByRole("link", { name: "Changelog" }).click();
    await expect(page).toHaveURL(/\/roadmap\/changelog$/);
    await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
    await expect(
      action(page).getByRole("link", { name: "Launches" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("launches-link")).toHaveCount(0);

    await links(page).getByRole("link", { name: "Launches" }).click();
    await expect(page).toHaveURL(/\/roadmap\/launches$/);
  });

  test("#14: Reports and Latest report say the same with no report yet", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/plan");
    await page
      .getByTestId("plan-tabs")
      .filter({ visible: true })
      .getByRole("link", { name: "Reports" })
      .click();
    await expect(page).toHaveURL(/\/plan\/reports$/);
    const list = page.getByTestId("reports-empty").filter({ visible: true });
    await expect(list).toBeVisible();
    const listText = (await list.locator("p").allInnerTexts()).join(" ").trim();
    expect(listText).not.toBe("");

    await links(page).getByRole("link", { name: "Latest report" }).click();
    await expect(page).toHaveURL(/\/plan\/reports\/latest$/);
    const latest = page.getByTestId("no-report-yet").filter({ visible: true });
    await expect(latest).toBeVisible();
    const latestText = (await latest.locator("p").allInnerTexts())
      .join(" ")
      .trim();
    expect(latestText).toBe(listText);
    await expect(
      latest.getByRole("button", { name: "Generate now" }),
    ).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("#15: at 390 Changelog shows its name and its header buttons on one row", async ({
    page,
  }) => {
    await scenario(page, "launches");
    await login(page);
    await page.goto("/plan");
    await links(page).getByRole("link", { name: "Changelog" }).click();
    await expect(page).toHaveURL(/\/roadmap\/changelog$/);
    await expect(page.getByTestId("changelog-entry").first()).toBeVisible();

    const title = page
      .getByRole("heading", { level: 1, name: "Changelog", exact: true })
      .filter({ visible: true });
    await expect(title).toBeVisible();
    expect(
      (await title.boundingBox())!.height,
      "the name is drawn, not for screen readers only",
    ).toBeGreaterThan(16);

    // The header's buttons stay on one row: the same top for each.
    const buttons = action(page).locator("button, a");
    await expect(buttons.first()).toBeVisible();
    const tops = await buttons.evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    expect(tops.length).toBeGreaterThan(0);
    expect(
      Math.max(...tops) - Math.min(...tops),
      "header buttons on one row",
    ).toBeLessThanOrEqual(2);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);

    // The exports are under More, and work from there.
    await action(page).getByRole("button", { name: "More" }).click();
    const more = page.getByRole("group", { name: "More actions" });
    await expect(
      more.getByRole("button", { name: "Export Markdown" }),
    ).toBeVisible();
    await expect(
      more.getByRole("button", { name: "Export HTML" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toHaveCount(0);

    // Launches, its sibling, names itself the same way.
    await links(page).getByRole("link", { name: "Launches" }).click();
    await expect(page).toHaveURL(/\/roadmap\/launches$/);
    const launches = page
      .getByRole("heading", { level: 1, name: "Launches", exact: true })
      .filter({ visible: true });
    await expect(launches).toBeVisible();
    expect((await launches.boundingBox())!.height).toBeGreaterThan(16);
  });
});
