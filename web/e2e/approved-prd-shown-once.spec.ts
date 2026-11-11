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

  const items = [
    ["Weekly alert digest", "2027-02-19", "Feb 19, 2027"],
    ["Alert history export", "2027-02-26", "Feb 26, 2027"],
  ] as const;

  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
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
  for (const [title, end] of items) {
    const bar = page.locator(`g[data-testid="bar"][aria-label^="${title}:"]`);
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute("data-end", end);
  }

  // The Timeline lists each once too, with the PRD's new end.
  await page.getByTestId("format-timeline").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
  // The Weekly alert digest's new end (Feb 19) is past its milestone Beta (Nov 30), so the strip
  // above the chart names it too (roadmap-home-qa 53098a13e); the Timeline's rows list it once.
  await expect(page.getByTestId("conflict").filter({ hasText: "Weekly alert digest" })).toHaveCount(1);
  for (const [title, , day] of items) {
    await expect(page.getByTestId("timeline-row").getByRole("button", { name: title, exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: new RegExp(`^${title}, .*${day}\\.`) })).toHaveCount(1);
  }
});

test("a copy the draft holds already shows as the one item it copies", async ({ page }) => {
  // hotfix PR 1273: an earlier approval left a copy of Weekly alert digest (same roadmap and PRD,
  // re-keyed, the PRD's key kept as its prd_key) with the PRD's newer end; the roadmap reads it as
  // one item with that end, as the API's drafts.twins (the PRD's key, exactly).
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.evaluate((slug) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === slug);
    const items = db.simple_roadmap.items as { key: string; from_prd?: unknown }[];
    const shown = items.find((it) => it.key === "alert-digest")!;
    shown.from_prd = { slug, title: doc.title };
    items.push({
      ...shown, key: "alert-digest-2", prd_key: "alert-digest", from_prd: { slug, title: doc.title },
      dates: { start: null, end: "2027-02-19", source: "accepted" },
    } as typeof shown);
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, PRD);

  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
  const bar = page.locator('g[data-testid="bar"][aria-label^="Weekly alert digest:"]');
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAttribute("data-end", "2027-02-19");
});

test("an item keyed phase-2 is its own item, never folded into phase", async ({ page }) => {
  // drafts.twins matches the PRD's key exactly: "phase-2" (from the same PRD, same roadmap) is not a
  // copy of "phase", so the roadmap shows both.
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.evaluate((slug) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === slug);
    const items = db.simple_roadmap.items as { key: string; title: string; from_prd?: unknown; prd_key?: string }[];
    const base = items.find((it) => it.key === "alert-digest")!;
    items.push(
      { ...base, key: "phase", title: "Reminder rollout", prd_key: undefined, from_prd: { slug, title: doc.title },
        dates: { start: null, end: "2027-01-15", source: "accepted" } } as typeof base,
      { ...base, key: "phase-2", title: "Reminder rollout two", prd_key: "phase-2", from_prd: { slug, title: doc.title },
        dates: { start: null, end: "2027-03-12", source: "accepted" } } as typeof base,
    );
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, PRD);

  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  // Both are on the roadmap, each by its own name (neither is read as a copy of the other).
  for (const title of ["Reminder rollout", "Reminder rollout two"])
    await expect(page.getByTestId("simple-roadmap").getByRole("button", { name: title, exact: true }).first()).toBeVisible();
});
