import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * approved-prd-shown-once (hotfix): publishing (approving) a PRD whose items the roadmap already
 * shows (from an older version of the PRD) updates those items in the roadmap's working draft and
 * never adds them again; Simple › Roadmap shows each item once. Driven through the UI against the
 * mock (web/lib/api/mock/server.ts approve, simple-roadmap.ts approvedPrdToDraft): the invented
 * "Visit reminders" PRD already holds two Alerts roadmap items, Weekly alert digest and Alert
 * history export; its version 1 gives Weekly alert digest (same key) a new end and Alert history
 * export under a new key (same title).
 */

const PRD = "visit-reminders";

/** The roadmap's items from an older version of the PRD, and the PRD's derived items now. */
async function givePrd(page: Page) {
  await page.evaluate((slug) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === slug);
    for (const it of db.simple_roadmap.items as { key: string; from_prd?: unknown }[])
      if (it.key === "alert-digest" || it.key === "alert-export") it.from_prd = { slug, title: doc.title };
    db.draft_roadmaps ??= { rows: [], off: [] };
    const item = (key: string, title: string, position: number, date: string) => ({
      id: crypto.randomUUID(), item_key: key, title, outcome: null, horizon: "now", position,
      milestone: { name: "Ready", date, basis_ids: [] },
    });
    db.draft_roadmaps.rows.push({
      document_id: doc.id, version: 1, status: "ready", requested_via: "auto", requested_by: null,
      requested_at: "2026-10-11T09:01:00Z", run_id: null, ready_at: "2026-10-11T09:06:00Z", error: null,
      depth: "standard", check: null, roadmap: "alerts-roadmap",
      items: [
        item("alert-digest", "Weekly alert digest", 0, "2027-02-19"),
        item("history-export", "Alert history export", 1, "2027-02-26"),
      ],
    });
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, PRD);
}

async function publishPrd(page: Page) {
  await page.goto(`/documents/${PRD}/publish`);
  const publish = page.getByTestId("publish-button");
  await expect(publish).toBeEnabled();
  await publish.click();
  await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
}

test("an approved PRD's items show once on the Simple roadmap", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await givePrd(page);
  await publishPrd(page);

  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("draft-from-prd")).toHaveText(/2 items came from Visit reminders \(version 1\)/);

  for (const f of ["gantt", "timeline"] as const) {
    await page.getByTestId(`format-${f}`).click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
    const bars = page.locator('g[data-testid="bar"]');
    await expect(bars.first()).toBeVisible();
    // No item twice: every bar is its own item, by key and by title.
    const shown = await bars.evaluateAll((els) =>
      els.map((e) => ({ key: e.getAttribute("data-item"), title: (e.getAttribute("aria-label") ?? "").split(":")[0] })),
    );
    const keys = shown.map((s) => s.key);
    const titles = shown.map((s) => s.title);
    expect(keys.length, keys.join(", ")).toBe(new Set(keys).size);
    expect(titles.length, titles.join(", ")).toBe(new Set(titles).size);
    for (const [title, end] of [["Weekly alert digest", "2027-02-19"], ["Alert history export", "2027-02-26"]] as const) {
      const bar = page.locator(`g[data-testid="bar"][aria-label^="${title}:"]`);
      await expect(bar).toHaveCount(1);
      await expect(bar).toHaveAttribute("data-end", end);
    }
  }
});
