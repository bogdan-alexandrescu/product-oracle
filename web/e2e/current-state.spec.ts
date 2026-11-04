import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Current state beside Desired state (the owner's picks: Proof table, Word pill, Owner confirms
 * each), against the mock (lib/api/mock/currentstate.ts): of the Simple features, three run today
 * (one with proof 41 days old), four are being built (two with every proof in) and the rest are new.
 * Everything is driven through the UI, on a desktop and on a phone.
 */

const PHONE = { width: 390, height: 844 };

/** The pill follows the name, as chips do (owner, Nov 4): to its right on the same line, or on a line under it. */
async function pillAfter(name: Locator, pill: Locator) {
  const n = (await name.boundingBox())!;
  const p = (await pill.boundingBox())!;
  const sameLine = p.y < n.y + n.height && n.y < p.y + p.height;
  expect(sameLine ? p.x >= n.x + n.width - 1 : p.y >= n.y + n.height - 1, "the pill comes after the name").toBe(true);
}

for (const size of ["desktop", "phone"] as const) {
  test.describe(size, () => {
    if (size === "phone") test.use({ viewport: PHONE });

    async function open(page: Page, url: string) {
      await login(page);
      await page.goto(url);
    }

    test("Desired state is the left menu's name; Current state's table puts old proof first and Check again asks the owner", async ({ page }) => {
      await open(page, "/baseline");
      if (size === "desktop") await expect(page.getByTestId("nav-baseline")).toHaveAccessibleName(/Desired state/);
      await expect(page.getByRole("heading", { name: "Desired state" })).toBeVisible();
      const tabs = page.getByTestId("cs-tabs");
      await expect(tabs.getByRole("tab", { name: /Desired state/ })).toHaveAttribute("aria-selected", "true");
      await tabs.getByRole("tab", { name: /Current state 3/ }).click();
      await expect(page).toHaveURL(/\/baseline\?view=current/);
      await expect(page.getByRole("heading", { name: "Current state" })).toBeVisible();
      await expect(page.getByTestId("cs-summary")).toContainText("3 running");
      await expect(page.getByTestId("cs-summary")).toContainText("1 with old proof");
      const rows = page.getByTestId("cs1-row");
      await expect(rows).toHaveCount(3);
      const first = rows.first();
      await expect(first).toContainText("Proof is 41 days old");
      await expect(first).toContainText("9 files");
      await expect(first).toContainText("4 pull requests");
      await expect(first).toContainText("6/6 tasks");
      await first.getByRole("button", { name: "Check again" }).click();
      const check = page.getByTestId("cs1-check");
      await expect(check).toContainText("still true today?");
      await expect(check).toContainText("Code map: 9 files still in place");
      await expect(check).toContainText("not read yet");
      await expect(check.locator('[data-ok="true"]')).toHaveCount(3);
      await expect(check.locator('[data-ok="false"]')).toHaveCount(1);
      // The re-read is done: the row says how old the proof is again, not "Checking now…".
      await expect(first).toContainText("Proof is 41 days old");
      await expect(first).not.toContainText("Checking now");
      await check.getByRole("button", { name: "Yes, still runs" }).click();
      await expect(check).toBeHidden();
      await expect(page.getByTestId("cs-summary")).toContainText("0 with old proof");
      await expect(page.getByText(/Checked \w{3} \d+ · you confirmed/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);
    });

    test("Ready to move: the proof opens, Not yet keeps it, Move to Current state moves it with a note", async ({ page }) => {
      await open(page, "/baseline");
      const band = page.getByTestId("cs3-ready");
      await expect(band).toContainText("2 ready to move");
      const names = await band.locator("button").allTextContents();
      expect(names).toHaveLength(2);
      // Not yet: it stays in Desired state, out of the band.
      await band.getByRole("button", { name: names[1] }).click();
      let dialog = page.getByRole("dialog", { name: `Move ${names[1]} to Current state` });
      await expect(dialog).toContainText("Oracle found proof that it runs today");
      await expect(dialog).toContainText("6 of 6 tracker tasks done");
      await dialog.getByRole("button", { name: "Not yet" }).click();
      await expect(dialog).toBeHidden();
      await expect(band).toContainText("1 ready to move");
      // Move: it joins Current state, with when and how it moved.
      await band.getByRole("button", { name: names[0] }).click();
      dialog = page.getByRole("dialog", { name: `Move ${names[0]} to Current state` });
      await expect(dialog).toContainText("Code map: 10 files");
      await expect(dialog).toContainText("4 pull requests merged");
      await expect(dialog).toContainText("Used by 212 people in the test group");
      await dialog.getByRole("button", { name: "Move to Current state" }).click();
      await expect(dialog).toBeHidden();
      await expect(band).toBeHidden();
      await page.getByTestId("cs-tabs").getByRole("tab", { name: /Current state 4/ }).click();
      const moved = page.getByTestId("cs1-row").filter({ hasText: names[0] });
      await expect(moved.getByTestId("cs-moved-note")).toHaveText(/Moved \w{3} \d+ · you confirmed/);
    });

    test("Priorities: a word pill on every row, the Show filter counts each kind and narrows the list", async ({ page }) => {
      await open(page, "/simple/priorities");
      const rows = page.getByTestId("prio-row");
      await expect(rows.first()).toBeVisible();
      const total = await rows.count();
      await expect(rows.getByTestId("cs-mark")).toHaveCount(total);
      const legend = page.getByTestId("cs-legend");
      await expect(legend.getByRole("button", { name: `All ${total}` })).toHaveAttribute("aria-pressed", "true");
      await expect(legend.getByRole("button", { name: "In progress 4" })).toBeVisible();
      await expect(legend.getByRole("button", { name: "Exists 3" })).toBeVisible();
      const fresh = total - 7;
      await expect(legend.getByRole("button", { name: `New ${fresh}` })).toBeVisible();
      await expect(rows.locator('[data-mark="exists_old"]')).toHaveText("Exists · proof old");
      // The pill follows the title, so every title starts at one x.
      for (const row of (await rows.all()).slice(0, 3)) await pillAfter(row.getByTestId("prio-title"), row.getByTestId("cs-mark"));
      // A pill says what it means and its proof; its card names the feature, then its pill.
      await rows.first().getByRole("button", { name: "What In progress means" }).click();
      const card = page.getByTestId("cs-mark-card");
      await pillAfter(card.locator("span.font-semibold").first(), card.getByTestId("cs-mark"));
      await expect(card).toContainText("Being built");
      await expect(card).toContainText("4 merged pull requests");
      await expect(card).toContainText("7 of 7 tracker tasks done");
      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await legend.getByRole("button", { name: `New ${fresh}` }).click();
      await expect(rows).toHaveCount(fresh);
      await expect(rows.locator('[data-mark="new"]')).toHaveCount(fresh);
      await expect(page.getByText(`${fresh} new features: nothing built for these yet.`)).toBeVisible();
      await legend.getByRole("button", { name: `All ${total}` }).click();
      await expect(rows).toHaveCount(total);
    });

    test("the same pill on the Simple roadmap's Gantt rows (Home's tasks: walkc-roadmap-tasks.spec.ts)", async ({ page }) => {
      await open(page, "/simple/roadmap");
      await page.getByTestId("format-gantt").click();
      const label = (title: string) => page.getByTestId("label-title").filter({ hasText: title }).locator("xpath=..");
      await expect(label("Setup checklist").getByTestId("cs-mark")).toHaveText("In progress");
      await expect(label("Weekly alert digest").getByTestId("cs-mark")).toHaveText("Exists");
      // The pill follows the name; the names start at one x and wrap whole, never cut.
      await pillAfter(label("Setup checklist").getByTestId("label-title"), label("Setup checklist").getByTestId("cs-mark"));
      const names = page.getByTestId("label-title");
      const xs = await names.evaluateAll((els) => els.filter((e) => !e.closest("button")?.querySelector('[data-testid="return-place"]')).map((e) => Math.round(e.getBoundingClientRect().x)));
      expect(new Set(xs).size).toBe(1);
      for (const n of await names.all()) {
        const whole = await n.evaluate((el) => {
          const row = el.closest("button")!.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const pill = el.parentElement?.querySelector('[data-testid="cs-mark"]')?.getBoundingClientRect();
          const inside = (b: DOMRect) => b.top >= row.top - 1 && b.bottom <= row.bottom + 1 && b.right <= row.right + 1;
          return el.scrollHeight <= el.clientHeight + 1 && inside(r) && (!pill || inside(pill));
        });
        expect(whole, `${await n.textContent()} and its pill are whole, inside its row`).toBe(true);
      }
      await expect(page.locator('[data-testid="cs-mark"][data-mark="exists_old"]').first()).toBeVisible();
    });
  });
}
