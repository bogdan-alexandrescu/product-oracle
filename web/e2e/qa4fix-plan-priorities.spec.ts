import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on /priorities, round qa4, driven through the UI on the mock layer as a person
 * would. Oracle's goal-weighted order: #1 Address lookup service (F-5, ranked higher because
 * Shipping cost shown in the cart, F-2, depends on it), #2 F-2, #3 Saved addresses at
 * checkout (F-1), #4 Bulk export (F-7), #5 Scheduled exports (F-8) ... #8 Dark mode (F-6).
 */

const APPROVER = "approver@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const rowOf = (page: Page, key: string) =>
  page.getByTestId(`priority-row-${key}`);
const rows = (page: Page) => page.locator('tr[data-testid^="priority-row-"]');

async function open(page: Page, email = APPROVER) {
  await login(page, email);
  await page.goto("/priorities");
  await expect(rows(page)).toHaveCount(8);
}

/** ▲ on a row, a reason, Save: the change is stored and the sheet closes. */
async function moveUp(
  page: Page,
  key: string,
  reason = "A launch partner needs it in the first release",
) {
  const row = rowOf(page, key);
  await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await row.getByRole("button", { name: "Move up", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Why?").fill(reason);
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toBeHidden();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-plan-1: after a move the Oracle # column never breaks a feature name mid-word", async ({
    page,
  }) => {
    await open(page);
    await moveUp(page, "F-1");
    await expect(
      page.getByRole("columnheader", { name: "Oracle #" }),
    ).toBeVisible();
    await expect(page.getByTestId("priority-inspector")).toBeVisible();
    const names = rows(page).getByTestId("feature-name");
    await expect(names).toHaveCount(8);
    for (const name of await names.all()) {
      // Every word of the name sits on one line: a word split over two lines has two boxes.
      const split = await name.evaluate((e) => {
        const text = e.firstChild as Text;
        const out: string[] = [];
        for (const m of (text.textContent ?? "").matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(text, m.index!);
          r.setEnd(text, m.index! + m[0].length);
          const lines = new Set(
            [...r.getClientRects()].map((b) => Math.round(b.top)),
          );
          if (lines.size > 1) out.push(m[0]);
        }
        return out;
      });
      expect(
        split,
        `${await name.innerText()}: a word breaks across lines`,
      ).toEqual([]);
    }
  });

  test("qa4-plan-2: a move that leaves the order as it is says why and saves nothing", async ({
    page,
  }) => {
    await open(page);
    const row = rowOf(page, "F-5");
    const sheet = page.getByRole("dialog");
    const menu = page.getByRole("menu", {
      name: "Change Address lookup service",
    });
    await expect(async () => {
      if (!(await sheet.isVisible())) {
        if (!(await menu.isVisible())) {
          await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
          await row
            .getByRole("button", { name: "More actions", exact: true })
            .click();
        }
        await menu
          .getByRole("menuitem", { name: "Move above…" })
          .click({ timeout: 2000 });
      }
      await expect(sheet.getByRole("list", { name: "Features" })).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: 30_000 });
    await sheet
      .getByRole("list", { name: "Features" })
      .getByRole("button", { name: /Saved addresses at checkout/ })
      .click();
    await expect(sheet.getByTestId("move-target")).toHaveText(
      "Move above Saved addresses at checkout",
    );
    await sheet
      .getByLabel("Why?")
      .fill("The address work should wait for checkout");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toContainText(
      "This move leaves Address lookup service where it is: Shipping cost shown in the cart depends on it",
    );
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    // Nothing was stored: no change logged, no Oracle # column, no Moved chip.
    await expect(page.getByTestId("changes-empty")).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Oracle #" }),
    ).toHaveCount(0);
    await expect(row.getByTestId("override-chip")).toHaveCount(0);
  });

  test("qa4-plan-9: 'Ranked higher' looks the same on the selected row and the others", async ({
    page,
  }) => {
    await open(page);
    await expect(rowOf(page, "F-5")).toHaveAttribute("aria-selected", "true");
    const chips = page
      .getByTestId("priority-table")
      .getByTestId("rank-reason")
      .filter({ hasText: "Ranked higher" });
    expect(await chips.count()).toBeGreaterThan(1);
    const looks = await chips.evaluateAll((els) =>
      els.map(
        (e) =>
          `${e.getAttribute("data-kind")} ${getComputedStyle(e).backgroundColor} ${getComputedStyle(e).boxShadow}`,
      ),
    );
    expect(new Set(looks).size, looks.join(" | ")).toBe(1);
  });

  test("qa4-plan-14: saving a snapshot says so in short; the list shows what was saved", async ({
    page,
  }) => {
    await open(page);
    const panel = page.getByTestId("snapshots-panel");
    await panel.getByRole("button", { name: "Save snapshot" }).click();
    await expect(panel.getByRole("status")).toHaveText("Snapshot saved.");
    await expect(
      panel.getByTestId("snapshot-list").getByRole("listitem"),
    ).toHaveCount(1);
    await expect(panel.getByTestId("snapshot-list")).toContainText(
      "Top: Address lookup service",
    );
    await expect(panel.getByRole("status")).not.toContainText(
      "Address lookup service",
    );
  });

  test("qa4-plan-15: the Changes list and Your change name the mover; the email is on hover", async ({
    page,
  }) => {
    await open(page);
    await moveUp(page, "F-1");
    const log = page.getByTestId("change-log");
    await expect(log.getByRole("listitem")).toHaveCount(1);
    await expect(log).toContainText("Priya Raman");
    await expect(log).not.toContainText(APPROVER);
    await expect(log.getByTitle(APPROVER)).toHaveText("Priya Raman");

    await rowOf(page, "F-1").getByTestId("feature-name").click();
    const change = page.getByTestId("your-change");
    await expect(change).toContainText("Priya Raman");
    await expect(change).not.toContainText(APPROVER);
    await expect(change.getByTitle(APPROVER)).toHaveText("Priya Raman");
    await expect(rowOf(page, "F-1").getByTestId("override-chip")).toHaveText(
      "Moved by Priya Raman",
    );
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-plan-17: By goal keeps each goal's ranked count beside its top rank", async ({
    page,
  }) => {
    await open(page);
    const table = page.getByRole("table", { name: "By goal" });
    await table.scrollIntoViewIfNeeded();
    const counts = table.getByTestId("goal-ranked");
    expect(await counts.count()).toBeGreaterThan(0);
    for (const c of await counts.all()) {
      await expect(c).toBeVisible();
      await expect(c).toHaveText(/^\d+ ranked$/);
    }
  });
});
