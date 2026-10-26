import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * Why SwarmCloud holds a run's step, in plain words with the Company time zone's moment
 * (the Runs row, the run page's segment), and a run that started no agent 30 minutes
 * after submission as an Inbox row with Cancel and Open. Invented data, seeded the way
 * the API serves it (api/oracle/runs/service.py: queue_wait, stuck).
 */

const RUN_ID = "7a11c0de-0000-4000-8000-0000000000a1";
const QUOTA = "Waiting for a Claude account: the accounts lent to Oracle have no quota left";
// MOCK_NOW (2026-10-22T12:00Z) less 45 minutes, in America/Los_Angeles.
const SINCE_ISO = "2026-10-22T11:15:00Z";
const SINCE_WORDS = "Thu Oct 22, 4:15 AM PDT";
const STUCK =
  "SwarmCloud has started no agent of this run 45 min after it was submitted. " +
  `${QUOTA}, since ${SINCE_WORDS}. It starts on its own once SwarmCloud lets it; Cancel ends the run.`;

async function seedQueuedRun(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, since, stuck, text }) => {
      type R = Record<string, unknown> & { id: string; document_slug: string; segments: Record<string, unknown>[] };
      type Db = { runs: { runs: R[] } };
      const write = (globalThis as { __poMockWrite?: (change: (db: Db) => string) => Promise<string> }).__poMockWrite;
      if (!write) throw new Error("The mock API is not loaded: sign in before seeding");
      return write((db) => {
        const runs = db.runs.runs;
        const base = runs.find((r) => r.document_slug === "team-onboarding")!;
        const run: R = JSON.parse(JSON.stringify(base));
        const wait = { code: "PROVIDER_QUOTA_EXHAUSTED", text, since };
        Object.assign(run, {
          id,
          document_slug: "queued-onboarding",
          status: "running",
          checkpoints: [],
          waiting_on: null,
          created_at: "2026-10-22T11:14:00Z",
          started_at: "2026-10-22T11:14:00Z",
          finished_at: null,
          error: null,
          stuck,
          queue_wait: wait,
        });
        run.segments = run.segments.map((s, i) => ({
          ...s,
          status: i === 0 ? "running" : "pending",
          queue_wait: i === 0 ? wait : null,
          agents: [],
          artifacts: [],
          attempts: [],
          draft_import: null,
          error: null,
          finished_at: null,
        }));
        runs.unshift(run);
        return id;
      });
    },
    { id: RUN_ID, since: SINCE_ISO, stuck: STUCK, text: QUOTA },
  );
}

test("a step SwarmCloud holds reads why and since when on the Runs row and the run page", async ({ page }) => {
  await login(page);
  await seedQueuedRun(page);

  await page.goto("/runs");
  const row = page.locator("tr[data-row]").filter({ hasText: "queued-onboarding" });
  await expect(row.getByTestId("run-queue-wait")).toHaveText(`${QUOTA} · since ${SINCE_WORDS}`);
  // A run SwarmCloud does not hold shows nothing of the kind.
  await expect(page.locator("tr[data-row]").filter({ hasText: "team-onboarding" }).getByTestId("run-queue-wait")).toHaveCount(0);

  await row.getByRole("link", { name: "queued-onboarding" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN_ID}$`));
  await expect(page.getByTestId("segment-queue-wait")).toHaveCount(1);
  await expect(page.getByTestId("segment-queue-wait")).toHaveText(`${QUOTA} · since ${SINCE_WORDS}`);
});

test("a run not started after 30 minutes is an Inbox row with Open and Cancel, counted by the badge", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(badge).toHaveText(/\d+/);
  const before = Number(await badge.textContent());
  await seedQueuedRun(page);

  await page.goto("/inbox");
  await expect(badge).toHaveText(String(before + 1));
  const row = page.getByTestId("inbox-lookups").locator("tr[data-row]").filter({ hasText: "queued-onboarding" });
  await expect(row).toContainText(QUOTA);
  await expect(row).toContainText(`since ${SINCE_WORDS}`);
  await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", `/runs/${RUN_ID}`);

  await row.getByRole("button", { name: "Cancel run" }).click();
  await expect(row).toHaveCount(0);
  await expect(badge).toHaveText(String(before));

  // Cancelled: the run page no longer says it waits.
  await page.goto(`/runs/${RUN_ID}`);
  await expect(page.getByTestId("segment-queue-wait")).toHaveCount(0);
});
