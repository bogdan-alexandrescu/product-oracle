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
      // The name as the row shows it (the old-proof glyph draws a "!" before it).
      const name = (await first.locator("span.font-medium").first().textContent())!.replace(/^!/, "").trim();
      await check.getByRole("button", { name: "Yes, still runs" }).click();
      await expect(check).toBeHidden();
      await expect(page.getByTestId("cs-summary")).toContainText("0 with old proof");
      // The confirmed row stays first, in green: Checked <month day> · you confirmed (cs1-a-done).
      await expect(rows.first()).toContainText(name);
      await expect(rows.first().getByTestId("cs-confirmed-note")).toHaveText(/^Checked [A-Z][a-z]{2} \d{1,2} · you confirmed$/);
      await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);
      // A reload keeps it: the note comes from the owner's answer, not from the page's memory.
      await page.reload();
      await expect(page.getByTestId("cs1-row").first().getByTestId("cs-confirmed-note")).toHaveText(/you confirmed/);
    });

    test("Current state lists what is still in Desired state under the table, each feature a chip with its mark", async ({ page }) => {
      await open(page, "/baseline?view=current");
      await expect(page.getByTestId("cs1-row")).toHaveCount(3);
      const desired = Number((await page.getByTestId("cs-tabs").getByRole("tab", { name: /Desired state/ }).textContent())!.replace(/\D+/g, ""));
      const box = page.getByTestId("cs-still-desired");
      await expect(box).toContainText(`Still in Desired state: 4 in progress, ${desired - 4} new`);
      const chips = box.getByTestId("cs-still-chip");
      await expect(chips).toHaveCount(desired);
      // In progress first, then new; each chip names its mark.
      await expect(box.locator('[data-testid="cs-still-chip"][data-mark="in_progress"]')).toHaveCount(4);
      await expect(chips.nth(0)).toHaveAttribute("data-mark", "in_progress");
      await expect(chips.nth(4)).toHaveAttribute("data-mark", "new");
      await expect(chips.nth(0)).toHaveAttribute("title", "In progress");
      await expect(chips.nth(4)).toHaveAttribute("title", "New");
      // The box sits under the table.
      const table = (await page.getByTestId("cs1-table").boundingBox())!;
      expect((await box.boundingBox())!.y).toBeGreaterThanOrEqual(table.y + table.height);
    });

    test("Desired state is one list of every planned feature with its mark; the baseline's tools sit under it", async ({ page }) => {
      await open(page, "/baseline");
      const desired = Number((await page.getByTestId("cs-tabs").getByRole("tab", { name: /Desired state/ }).textContent())!.replace(/\D+/g, ""));
      const list = page.getByTestId("cs-desired");
      const rows = list.getByTestId("cs-desired-row");
      const limit = size === "phone" ? 9 : 14;
      await expect(rows).toHaveCount(Math.min(limit, desired));
      // Ready first (Proof is in), then the rest in progress with their tasks, then new.
      for (const i of [0, 1]) {
        await expect(rows.nth(i).getByTestId("cs-mark")).toHaveAttribute("data-mark", "in_progress");
        await expect(rows.nth(i)).toContainText("Proof is in");
      }
      await expect(rows.nth(2).getByTestId("cs-mark")).toHaveAttribute("data-mark", "in_progress");
      await expect(rows.nth(2)).toContainText(/\d+ of \d+ tasks done/);
      await expect(rows.nth(4).getByTestId("cs-mark")).toHaveAttribute("data-mark", "new");
      await expect(rows.nth(4).getByTestId("cs-mark")).toHaveAttribute("title", "New");
      if (size === "desktop") {
        await expect(rows.nth(0).getByTestId("cs-mark")).toHaveText("In progress");
        await expect(rows.nth(4).getByTestId("cs-mark")).toHaveText("New");
        // Its area of focus.
        await expect(rows.nth(0)).toContainText(/Sign-up and onboarding|Billing|Search|Phone app|Reports|Teams and sharing/);
      }
      // "and N more" opens the rest: every planned feature is on the list.
      if (desired > limit) {
        await list.getByRole("button", { name: `and ${desired - limit} more` }).click();
        await expect(rows).toHaveCount(desired);
      }
      // The header is the title alone; Add item and Build baseline sit with the views under the list.
      await expect(page.getByTestId("confirmed-chip")).toHaveCount(0);
      const end = (await list.boundingBox())!;
      for (const name of ["Add item", "Build baseline"]) {
        const button = page.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        expect((await button.boundingBox())!.y, `${name} is under the list`).toBeGreaterThan(end.y + end.height);
      }
      await expect(page.getByRole("tablist", { name: "Baseline views" })).toBeVisible();
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
      // Kept in Desired state's list, now with its tasks instead of Proof is in.
      const kept = page.getByTestId("cs-desired-row").filter({ hasText: names[1] });
      await expect(kept).toContainText("6 of 6 tasks done");
      await expect(kept).not.toContainText("Proof is in");
      // Move: it joins Current state, with when and how it moved.
      await band.getByRole("button", { name: names[0] }).click();
      dialog = page.getByRole("dialog", { name: `Move ${names[0]} to Current state` });
      await expect(dialog).toContainText("Code map: 10 files");
      await expect(dialog).toContainText("4 pull requests merged");
      await expect(dialog).toContainText("Used by 212 people in the test group");
      await dialog.getByRole("button", { name: "Move to Current state" }).click();
      await expect(dialog).toBeHidden();
      // The move ends on Current state, the moved feature on top: Moved <month day> · you confirmed (cs3-b-done).
      await expect(page).toHaveURL(/\/baseline\?view=current/);
      await expect(page.getByRole("heading", { name: "Current state" })).toBeVisible();
      await expect(page.getByTestId("cs-tabs").getByRole("tab", { name: /Current state 4/ })).toHaveAttribute("aria-selected", "true");
      const moved = page.getByTestId("cs1-row").first();
      await expect(moved).toContainText(names[0]);
      await expect(moved.getByTestId("cs-moved-note")).toHaveText(/^Moved [A-Z][a-z]{2} \d{1,2} · you confirmed$/);
      // Back on Desired state it has left the list and the band.
      await page.getByTestId("cs-tabs").getByRole("tab", { name: /Desired state/ }).click();
      await expect(page.getByTestId("cs-desired")).toBeVisible();
      await expect(page.getByTestId("cs-desired-row").filter({ hasText: names[0] })).toHaveCount(0);
      await expect(band).toBeHidden();
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
      // cs2-b: right next to the name, not pushed to the far right of the row: on the name's last
      // line, a small gap after its last word (or, where the row is narrow, on the line under it).
      for (const row of (await rows.all()).slice(0, 5)) {
        const end = await row.getByTestId("prio-title").evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          const last = [...r.getClientRects()].at(-1)!;
          return { x: last.right, top: last.top, bottom: last.bottom };
        });
        const p = (await row.getByTestId("cs-mark").boundingBox())!;
        const name = (await row.getByTestId("prio-name").boundingBox())!;
        if (p.y < end.bottom && end.top < p.y + p.height) expect(p.x - end.x, "the pill is right after the name's last word").toBeLessThanOrEqual(16);
        else expect(Math.abs(p.x - name.x), "a pill under the name starts at the name's left").toBeLessThanOrEqual(2);
      }
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
