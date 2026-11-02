import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * ah-prd-milestones-once (the owner's pick: 'Read-only from the PRD'): publishing (approving) a
 * PRD with two dated milestones adds its items to the roadmap's working draft and no key dates;
 * Simple › Roadmap shows each milestone once, as a read-only key date from the PRD (no Edit, no
 * Remove), in Key dates and on the Timeline. Driven through the UI against the mock
 * (web/lib/api/mock/server.ts approve, simple-roadmap.ts approvedPrdToDraft): the invented
 * "Visit reminders" PRD, given a dated item for the Alerts roadmap and a milestones table
 * (M1 Pilot clinics ends Dec 18, M2 All clinics ends Feb 12); desktop and phone.
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const PRD = "visit-reminders";
const MILESTONES = [
  ["M1 · Pilot clinics", "Pilot clinics", "Dec 18"],
  ["M2 · All clinics", "All clinics", "Feb 12"],
] as const;

const rows = (page: Page): Locator => page.getByTestId("key-dates-editor").getByTestId("key-date-row");
const row = (page: Page, name: string): Locator =>
  page.getByTestId("key-dates-editor").locator(`[data-testid="key-date-row"][data-name="${name}"]`);

/** The PRD's derived item and milestones table, as a run and the PRD's writer left them. */
async function givePrd(page: Page) {
  await page.evaluate((slug) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === slug);
    const v = db.versions.find((x: { document_id: string; number: number }) => x.document_id === doc.id && x.number === 1);
    const solution = v.sections.find((s: { section_key: string }) => s.section_key === "solution");
    solution.body_md +=
      "\n\n| Milestone | Name | Start | End |\n|---|---|---|---|\n| M1 | Pilot clinics | 2026-11-16 | 2026-12-18 |\n| M2 | All clinics | 2027-01-04 | 2027-02-12 |";
    db.draft_roadmaps ??= { rows: [], off: [] };
    db.draft_roadmaps.rows.push({
      document_id: doc.id, version: 1, status: "ready", requested_via: "auto", requested_by: null,
      requested_at: "2026-10-11T09:01:00Z", run_id: null, ready_at: "2026-10-11T09:06:00Z", error: null,
      depth: "standard", check: null, roadmap: "alerts-roadmap",
      items: [{
        id: crypto.randomUUID(), item_key: "reminder-texts", title: "Reminder texts", outcome: null,
        horizon: "now", position: 0, milestone: { name: "Ready", date: "2026-12-11", basis_ids: [] },
      }],
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

for (const [label, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(label, () => {
    test.use(use);

    test("an approved PRD's milestones show once, read-only from the PRD", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await givePrd(page);
      await publishPrd(page);

      await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      // The draft holds the PRD's item, and no key dates of its own from the PRD.
      await expect(page.getByTestId("draft-from-prd")).toHaveText(/1 item came from Visit reminders \(version 1\)/);

      await page.getByTestId("key-dates-open").click();
      await expect(page.getByTestId("key-dates-editor")).toBeVisible();
      for (const [name, plain, day] of MILESTONES) {
        // Once, read-only, from the PRD.
        await expect(rows(page).filter({ hasText: plain })).toHaveCount(1);
        await expect(row(page, plain)).toHaveCount(0);
        await expect(row(page, name).getByTestId("key-date-day")).toContainText(day);
        await expect(row(page, name).getByTestId("key-date-from-prd")).toHaveText("From the PRD");
        await expect(row(page, name).getByTestId("key-date-where")).toHaveText("Change it in the PRD, Visit reminders");
        await expect(row(page, name).getByRole("button", { name: `Edit ${name}` })).toHaveCount(0);
        await expect(row(page, name).getByRole("button", { name: `Remove ${name}` })).toHaveCount(0);
      }
      await page.screenshot({ path: test.info().outputPath(`ah-prd-milestones-once-${label}.png`) });
      await page.getByTestId("key-dates-open").click();

      // The Timeline marks each milestone once.
      await page.getByTestId("format-timeline").click();
      for (const [name, plain] of MILESTONES) {
        await expect(page.locator(`[data-testid="key-date-marker"][data-name="${name}"]`)).toHaveCount(1);
        await expect(page.locator(`[data-testid="key-date-marker"][data-name="${plain}"]`)).toHaveCount(0);
      }
    });
  });
}
