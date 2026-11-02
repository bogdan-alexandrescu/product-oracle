import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * approved-prd-roadmap (the owner's pick: 'Add them as a roadmap draft'): publishing (approving)
 * a PRD version puts its dated items and its milestones (as key dates) on its roadmap's working
 * draft, marked as from the PRD; no run. Simple › Roadmap's PRD filter then lists the PRD and
 * the working draft says how many items came from it, with Review. Driven through the UI
 * against the mock (web/lib/api/mock/server.ts approve, simple-roadmap.ts approvedPrdToDraft):
 * the invented "Visit reminders" PRD, its v1 given derived items for the Alerts roadmap
 * (Reminder texts and Rebook link dated, end only; Reminder settings undated) and a milestones
 * table (M1 Pilot clinics, M2 All clinics); desktop (1366x820) and phone (390x844).
 */

const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const PRD = "visit-reminders";

const boardCard = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const kdRow = (page: Page, name: string): Locator =>
  page
    .getByTestId("key-dates-editor")
    .locator(`[data-testid="key-date-row"][data-name="${name}"]`);

/** The PRD's derived items and milestones table, as a run and the PRD's writer left them. */
async function givePrdItems(page: Page) {
  await page.evaluate((slug) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === slug);
    const v = db.versions.find(
      (x: { document_id: string; number: number }) =>
        x.document_id === doc.id && x.number === 1,
    );
    const solution = v.sections.find(
      (s: { section_key: string }) => s.section_key === "solution",
    );
    solution.body_md +=
      "\n\n| Milestone | Name | Start | End |\n|---|---|---|---|\n| M1 | Pilot clinics | 2026-11-16 | 2026-12-18 |\n| M2 | All clinics | 2027-01-04 | 2027-02-12 |";
    const item = (
      key: string,
      title: string,
      horizon: string,
      date: string | null,
      start_date?: string,
    ) => ({
      id: crypto.randomUUID(),
      item_key: key,
      title,
      outcome: null,
      horizon,
      position: 0,
      milestone: date
        ? { name: "Ready", date, start_date, basis_ids: [] }
        : null,
    });
    db.draft_roadmaps ??= { rows: [], off: [] };
    db.draft_roadmaps.rows.push({
      document_id: doc.id,
      version: 1,
      status: "ready",
      requested_via: "auto",
      requested_by: null,
      requested_at: "2026-10-11T09:01:00Z",
      run_id: null,
      ready_at: "2026-10-11T09:06:00Z",
      error: null,
      depth: "standard",
      check: null,
      roadmap: "alerts-roadmap",
      items: [
        item("reminder-texts", "Reminder texts", "now", "2026-12-11"),
        item("rebook-link", "Rebook link", "next", "2027-01-22", "2026-12-14"),
        item("reminder-settings", "Reminder settings", "later", null),
      ],
    });
    // The engineering lead accepted Dec 18 for Reminder texts: its end, not the item's own.
    if (!db.roadmap) throw new Error("the mock's roadmap is not stored yet");
    db.roadmap.bases.push({
      id: crypto.randomUUID(),
      kind: "estimate",
      reference: "Lead estimate",
      supports_date: "2026-12-18",
      detail: null,
      prd_document_id: doc.id,
      item_key: "reminder-texts",
      tracker_key: null,
      tracker_record_id: null,
      status: "verified",
      note: null,
      proposed_by: null,
      proposed_at: null,
      verified_by: null,
      verified_at: "2026-10-12T09:00:00Z",
      withdrawn_by: null,
      withdrawn_at: null,
      withdrawn_reason: null,
      rejected_by: null,
      rejected_at: null,
      rejected_reason: null,
      created_at: "2026-10-12T09:00:00Z",
    });
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, PRD);
}

async function publishPrd(page: Page) {
  await page.goto(`/documents/${PRD}/publish`);
  const publish = page.getByTestId("publish-button");
  await expect(publish).toBeEnabled();
  await publish.click();
  await page
    .getByRole("dialog", { name: "Publish v1?" })
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
}

async function openBoard(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
}

async function showPickers(page: Page) {
  if ((page.viewportSize()?.width ?? 1366) > 600) return;
  const toggle = page.getByTestId("filters-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await expect(page.getByTestId("filter-pickers")).toBeVisible();
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(label, () => {
    test.use(use);

    test("publishing a PRD puts its dated items and milestones on the roadmap's working draft", async ({
      page,
    }) => {
      await login(page);
      await openBoard(page);
      // Before: the PRD is on no roadmap, and the draft holds nothing from it.
      await showPickers(page);
      await expect(
        page
          .getByRole("combobox", { name: "PRD", exact: true })
          .locator("option", { hasText: "Visit reminders" }),
      ).toHaveCount(0);
      await expect(page.getByTestId("draft-from-prd")).toHaveCount(0);

      await givePrdItems(page);
      await publishPrd(page);
      await openBoard(page);

      const from = page.getByTestId("draft-from-prd");
      await expect(from).toHaveCount(1);
      await expect(from).toContainText(
        "2 items and 2 key dates came from Visit reminders (version 1)",
      );
      // The dated items are on the board; the undated one is not.
      await expect(boardCard(page, "reminder-texts")).toBeVisible();
      await expect(boardCard(page, "rebook-link")).toBeVisible();
      await expect(boardCard(page, "reminder-settings")).toHaveCount(0);
      // The dates are the API's: the lead's accepted end, else the item's own start and end.
      await expect(
        boardCard(page, "reminder-texts").getByTestId("board-dates"),
      ).toContainText("Dec 18");
      await expect(
        boardCard(page, "rebook-link").getByTestId("board-dates"),
      ).toContainText("Dec 14");

      // Review narrows the roadmap to the PRD: its two items only.
      await from
        .getByRole("button", { name: "Review the items from Visit reminders" })
        .click();
      await showPickers(page);
      await expect(
        page.getByRole("combobox", { name: "PRD", exact: true }),
      ).toHaveValue(PRD);
      await expect(page.getByTestId("board-card")).toHaveCount(2);

      // Its milestones are key dates in the draft, noted as from the PRD.
      await page.getByTestId("key-dates-open").click();
      for (const [name, day] of [
        ["Pilot clinics", "Dec 18"],
        ["All clinics", "Feb 12"],
      ]) {
        const row = kdRow(page, name);
        await expect(row).toBeVisible();
        await expect(row.getByTestId("key-date-day")).toContainText(day);
        await expect(row.getByTestId("key-date-in-draft")).toBeVisible();
        await expect(row).toContainText("From Visit reminders");
      }
      await page.screenshot({
        path: test.info().outputPath(`approved-prd-roadmap-${label}.png`),
      });
    });
  });
}
