import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ONE_ROADMAP_SCENARIO } from "../lib/api/mock/one-roadmap";
import { login } from "./helpers";

// The rebuild sign (owner's pick A, PR 1232's status chip): a live chip beside a PRD's or
// roadmap's version while a run will make its next version (GET /v1/rebuilds), opening the
// run's steps, who started it, its next stop or who it waits on, what will change, and
// Open run. On the Simple one-pager, the One-pagers list, the Simple Roadmap, the Detailed
// PRD page and Home. Each state is a run in the mock's store, as the API would list it.

type State = "scheduled" | "running" | "waiting" | "failed" | "done";
/** `title`: a run writing a new PRD (no document yet, its slug only on the run), so named. */
type Seed = { slug: string; state: State; step?: number; minutes?: number; startAt?: string; error?: string; flow?: string; source?: string; title?: string };

/**
 * Puts runs in the mock's store (a run the API lists), each cloned from a seeded run. With
 * `open`, it seeds on a blank page of the app's origin (no app running to write its own
 * store back over the seed), then opens `open`: the first load reads the seed.
 */
async function seedRuns(page: Page, seeds: Seed[], { clear = [], open, only = false }: { clear?: string[]; open?: string; only?: boolean } = {}): Promise<{ ids: string[]; latest: Record<string, number> }> {
  if (open) {
    await page.route("**/__rebuild-seed", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>seed</title>" }));
    await page.goto("/__rebuild-seed");
  }
  const out = await write(page, seeds, clear, only);
  if (open) await page.goto(open);
  return out;
}

/** `only`: the seeded runs are the store's only ones (Home lists every document's). */
async function write(page: Page, seeds: Seed[], clear: string[], only: boolean): Promise<{ ids: string[]; latest: Record<string, number> }> {
  return page.evaluate(([seeds, clear, only]) => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type Seg = Record<string, unknown> & { seq: number; status: string; checkpoint: string | null; checkpoint_on: boolean };
    const base = JSON.parse(JSON.stringify(db.runs.runs.find((r: { flow: string }) => r.flow === "baseline_to_prd")));
    // Pinned clock: e2e/test.ts starts every context at MOCK_NOW (Oct 22, 2026, 12:00 PM UTC).
    // A stopped run is listed for 7 days after it finished (FAILED_DAYS), so this moment must
    // stay within those 7 days of MOCK_NOW; move it with MOCK_NOW.
    const at = "2026-10-22T18:20:00Z";
    // A clean scene: no other run on the documents seeded (the default seed has one on some).
    const slugs = new Set([...seeds.map((s) => s.slug), ...clear]);
    db.runs.runs = db.runs.runs.filter((r: { document_slug: string | null }) => !only && !slugs.has(r.document_slug ?? ""));
    const ids: string[] = [];
    const latest: Record<string, number> = {};
    for (const s of seeds) {
      const doc = s.title ? { id: null, slug: s.slug, title: s.title, kind: "prd" } : db.documents.find((d: { slug: string }) => d.slug === s.slug);
      const versions = db.versions.filter((v: { document_id: string }) => doc.id && v.document_id === doc.id);
      const top = versions.length ? versions.reduce((a: { number: number }, b: { number: number }) => (b.number > a.number ? b : a)) : { number: 0 };
      const id = crypto.randomUUID();
      const run = JSON.parse(JSON.stringify(base));
      const segs: Seg[] = run.segments.filter((g: Seg) => g.status !== "skipped");
      const step = s.step ?? 2;
      const status = { scheduled: "awaiting_approval", running: "running", waiting: "awaiting_checkpoint", failed: "failed", done: "succeeded" }[s.state];
      const source = s.source ? db.documents.find((d: { slug: string }) => d.slug === s.source) : null;
      const sourceTop = source ? db.versions.filter((v: { document_id: string }) => v.document_id === source.id).reduce((a: number, v: { number: number }) => Math.max(a, v.number), 0) : 0;
      Object.assign(run, {
        id,
        ...(s.flow ? { flow: s.flow, flow_title: s.flow === "prd_to_roadmap" ? "Roadmap from a PRD" : s.flow } : {}),
        ...(source ? { source: { document_id: source.id, slug: source.slug, title: source.title, kind: source.kind, version: sourceTop, version_id: crypto.randomUUID(), approved_at: at } } : {}),
        document_id: doc.id,
        document_slug: doc.slug,
        document_title: s.title ?? run.document_title ?? null,
        status,
        segments: segs,
        knobs: { ...run.knobs, minutes_left: s.minutes ?? null, start_at: s.startAt ?? null },
        created_at: at,
        started_at: s.state === "scheduled" ? null : at,
        finished_at: s.state === "failed" || s.state === "done" ? at : null,
        error: s.error ?? null,
        review_link: null,
        checkpoints: [],
      });
      segs.forEach((g, i) => {
        const n = i + 1;
        g.status =
          s.state === "scheduled" ? "pending"
          : s.state === "done" ? "succeeded"
          : n < step ? "succeeded"
          : n === step ? (s.state === "running" ? "running" : s.state === "failed" ? "failed" : "succeeded")
          : "pending";
        g.draft_import = null;
      });
      if (s.state === "waiting") {
        const g = segs[step - 1];
        run.checkpoints = [{ id: crypto.randomUUID(), run_id: id, kind: g.checkpoint ?? "prd_review", status: "pending", approver_role: "approver", segment_seq: g.seq, decided_by: null, decided_at: null, note: null, payload: {}, created_at: at, can_decide: true }];
        run.waiting_on = g.checkpoint ?? "prd_review";
      }
      if (s.state === "done") {
        // The run's draft landed as the document's next version, not approved yet.
        const made = { ...JSON.parse(JSON.stringify(top)), id: crypto.randomUUID(), number: top.number + 1, approved_at: null, approved_by: null, created_at: at };
        db.versions.push(made);
        segs[segs.length - 1].draft_import = { document_id: doc.id, slug: doc.slug, kind: doc.kind, version: made.number, created: false, warnings: [], error: null, problems: [], summary: null, source: null, prd_links: null };
      }
      latest[s.slug] = Math.max(latest[s.slug] ?? 0, top.number);
      db.runs.runs.push(run);
      ids.push(id);
    }
    localStorage.setItem(key, JSON.stringify(db));
    return { ids, latest };
  }, [seeds, clear, only] as const);
}

/** Moves a seeded running run to its next step, as the run does between two reads. */
async function nextStep(page: Page, id: string) {
  await page.evaluate((id) => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    const run = db.runs.runs.find((r: { id: string }) => r.id === id);
    const i = run.segments.findIndex((g: { status: string }) => g.status === "running");
    run.segments[i].status = "succeeded";
    run.segments[i + 1].status = "running";
    localStorage.setItem(key, JSON.stringify(db));
  }, id);
}

async function start(page: Page, scenario?: string) {
  if (scenario) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
}

const chip = (page: Page) => page.getByTestId("rb-chip").filter({ visible: true });

test("a running rebuild: the chip beside the version says its step and time left, opens the run's steps and updates by itself", async ({ page }) => {
  await start(page);
  const { ids, latest } = await seedRuns(page, [{ slug: "checkout-redesign", state: "running", step: 2, minutes: 40 }], { open: "/simple/one-pagers/checkout-redesign" });
  const v = latest["checkout-redesign"] + 1;
  await expect(chip(page)).toHaveText(new RegExp(`^Rebuilding v${v} · step 2 of \\d+ · about 40 min$`));
  await chip(page).click();
  const pop = page.getByTestId("rb-popover");
  await expect(pop).toContainText("Started by");
  await expect(pop.getByTestId("rb-steps").locator("li")).not.toHaveCount(0);
  await expect(pop).toContainText("Next stop:");
  // The mock's PRD has no approved version yet: nobody reads the draft until it is.
  await expect(pop).toContainText(`It makes a new draft, v${v}. Nobody reads it until it is approved.`);
  await expect(pop.getByRole("link", { name: "Open run" })).toHaveAttribute("href", `/runs/${ids[0]}`);
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  // Live: the run moves on, and the chip says so without a reload.
  await nextStep(page, ids[0]);
  await expect(chip(page)).toContainText("step 3 of", { timeout: 15_000 });
  await expect(chip(page)).toContainText("just now");
});

test("a scheduled rebuild says when it starts", async ({ page }) => {
  await start(page);
  await seedRuns(page, [{ slug: "checkout-redesign", state: "scheduled", startAt: "2026-10-29T16:00:00Z" }], { open: "/simple/one-pagers/checkout-redesign" });
  await expect(chip(page)).toHaveText(/^Rebuild scheduled Thu, Oct 29, \d{1,2}:00 [AP]M/);
  await chip(page).click();
  await expect(page.getByTestId("rb-popover")).toContainText("Set up by");
});

test("a rebuild at a stop says who it waits on and their action", async ({ page }) => {
  await start(page);
  await seedRuns(page, [{ slug: "checkout-redesign", state: "waiting", step: 3 }], { open: "/simple/one-pagers/checkout-redesign" });
  await expect(chip(page)).toHaveText(/^Waiting on .+ · step 3 of \d+$/);
  await chip(page).click();
  const pop = page.getByTestId("rb-popover");
  await expect(pop).toContainText(/Waiting on .+ to [a-z]/);
  await expect(pop.getByRole("link").first()).toBeVisible();
});

test("a rebuild that stopped says where", async ({ page }) => {
  await start(page);
  await seedRuns(page, [{ slug: "checkout-redesign", state: "failed", step: 3, error: "Two sections came back empty" }], { open: "/simple/one-pagers/checkout-redesign" });
  await expect(chip(page)).toHaveText(/^Rebuild stopped at step 3 of \d+$/);
  await chip(page).click();
  await expect(page.getByTestId("rb-popover")).toContainText("Two sections came back empty at");
  await expect(page.getByTestId("rb-popover")).toContainText("Nothing changed");
});

test("the new version lands: 'ready: review it' until it is opened", async ({ page }) => {
  await start(page);
  const { latest } = await seedRuns(page, [{ slug: "checkout-redesign", state: "done" }], { open: "/simple/one-pagers" });
  const v = latest["checkout-redesign"] + 1;
  const row = page.getByRole("listitem").filter({ hasText: "Checkout redesign PRD" });
  await expect(row.getByTestId("rb-chip")).toHaveText(`v${v} ready: review it`);
  await row.getByTestId("rb-chip").click();
  await page.getByTestId("rb-popover").getByRole("link", { name: `Review v${v}` }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/checkout-redesign/v/${v}`));
  await page.goto("/simple/one-pagers");
  await expect(row).toBeVisible();
  await expect(row.getByTestId("rb-chip")).toHaveCount(0);
});

test("the one-pager and the Detailed page say 'ready: review it' while the new version waits for review; viewing it ends it elsewhere", async ({ page }) => {
  // Frames a-one-pager-done and a-detailed-done: the document's own pages keep saying it
  // until the version is approved, though they show it.
  await start(page);
  const { latest } = await seedRuns(page, [{ slug: "checkout-redesign", state: "done" }], { open: "/simple/one-pagers/checkout-redesign" });
  const v = latest["checkout-redesign"] + 1;
  await expect(page.getByText(`Version ${v}`).first()).toBeVisible();
  await expect(chip(page)).toHaveText(`v${v} ready: review it`);
  await page.goto("/documents/checkout-redesign");
  await expect(chip(page)).toHaveText(`v${v} ready: review it`);
  await chip(page).click();
  await expect(page.getByTestId("rb-popover").getByRole("link", { name: `Review v${v}` })).toBeVisible();
  // Seen: the list and Home have nothing new for this person.
  await page.goto("/simple/one-pagers");
  const row = page.getByRole("listitem").filter({ hasText: "Checkout redesign PRD" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("rb-chip")).toHaveCount(0);
});

test("a new PRD being written: Home names it 'New PRD', links its run while no version of it exists", async ({ page }) => {
  await start(page);
  // The mock's own: Team onboarding at the baseline stop, Usage alerts v2 waiting for an owner's approval.
  const runs = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const id = (slug: string) => db.runs.runs.find((r: { document_slug: string; document_id: string | null }) => r.document_slug === slug && !r.document_id).id as string;
    return { onboarding: id("team-onboarding"), alerts: id("usage-alerts-v2") };
  });
  await seedRuns(page, [{ slug: "billing-exports-example", title: "Billing exports", state: "running", step: 2, minutes: 40 }], { open: "/simple" });
  const home = page.getByTestId("rb-home");
  const onboarding = home.getByRole("listitem").filter({ hasText: "New PRD: Team onboarding" });
  await expect(onboarding).toContainText(/being written · waiting on/i);
  await expect(onboarding.getByRole("link", { name: "New PRD: Team onboarding" })).toHaveAttribute("href", `/runs/${runs.onboarding}`);
  const alerts = home.getByRole("listitem").filter({ hasText: "New PRD: Usage alerts v2" });
  await expect(alerts).toContainText(/being written · not started yet/i);
  await expect(alerts.getByRole("link", { name: "New PRD: Usage alerts v2" })).toHaveAttribute("href", `/runs/${runs.alerts}`);
  const exports = home.getByRole("listitem").filter({ hasText: "New PRD: Billing exports" });
  await expect(exports).toContainText(/being written · step 2 of \d+ · about 40 min/i);
  // The popover says what it writes, and opens the run.
  await exports.getByTestId("rb-chip").click();
  await expect(page.getByTestId("rb-popover")).toContainText("It writes a new PRD, Billing exports.");
  await onboarding.getByRole("link", { name: "New PRD: Team onboarding" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runs.onboarding}$`));
});

test("a run at a stop or not started re-reads once a minute, not every 5 s", async ({ page }) => {
  await start(page);
  const { ids } = await seedRuns(page, [{ slug: "checkout-redesign", state: "waiting", step: 3 }], { open: "/simple/one-pagers/checkout-redesign" });
  await expect(chip(page)).toContainText("Waiting on");
  // It moves on between two reads: the sign, at a stop, reads again only after a minute.
  await page.evaluate((id) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const run = db.runs.runs.find((r: { id: string }) => r.id === id);
    run.status = "running";
    run.checkpoints = [];
    run.waiting_on = null;
    run.segments.find((g: { status: string }) => g.status === "pending").status = "running";
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, ids[0]);
  await page.clock.runFor(30_000);
  await expect(chip(page)).toContainText("Waiting on");
  await page.clock.runFor(31_000);
  await expect(chip(page)).toContainText("Rebuilding", { timeout: 3000 });
});

test("two runs on one PRD: the chip counts the other, the popover shows both", async ({ page }) => {
  await start(page);
  await seedRuns(page, [
    { slug: "checkout-redesign", state: "running", step: 2, minutes: 40 },
    { slug: "checkout-redesign", state: "scheduled" },
  ], { open: "/simple/one-pagers/checkout-redesign" });
  await expect(chip(page)).toContainText("+1 run");
  await chip(page).click();
  await expect(page.getByTestId("rb-popover").getByTestId("rb-run")).toHaveCount(2);
});

test("the One-pagers list, the Detailed PRD page and Home carry the chip", async ({ page }) => {
  await start(page);
  const { latest } = await seedRuns(page, [{ slug: "checkout-redesign", state: "running", step: 2, minutes: 40 }], { open: "/simple/one-pagers" });
  const v = latest["checkout-redesign"] + 1;
  const row = page.getByRole("listitem").filter({ hasText: "Checkout redesign PRD" });
  await expect(row.getByTestId("rb-chip")).toHaveText(new RegExp(`^Rebuilding v${v} · 2/\\d+$`));
  await page.goto("/documents/checkout-redesign");
  await expect(chip(page)).toHaveText(new RegExp(`^Rebuilding v${v} · step 2 of`));
  await page.goto("/simple");
  const home = page.getByTestId("rb-home");
  await expect(home.getByRole("heading", { name: "Being rebuilt" })).toBeVisible();
  await expect(home.getByRole("link", { name: "Checkout redesign PRD" })).toHaveAttribute("href", "/simple/one-pagers/checkout-redesign");
  await expect(home.getByRole("listitem").filter({ hasText: "Checkout redesign PRD" }).getByTestId("rb-chip")).toContainText(`Rebuilding v${v}`);
});

test("the Simple Roadmap: PRDs that feed it rebuilding, then its own run", async ({ page }) => {
  await start(page, ONE_ROADMAP_SCENARIO);
  await page.goto("/simple/roadmap");
  const prds = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const withVersions = new Set(db.versions.map((v: { document_id: string }) => v.document_id));
    return db.documents.filter((d: { kind: string; id: string }) => d.kind === "prd" && withVersions.has(d.id)).map((d: { slug: string }) => d.slug);
  });
  await seedRuns(page, [
    { slug: prds[0], state: "running", step: 2, minutes: 30 },
    { slug: prds[1], state: "waiting", step: 3 },
  ], { clear: ["product-roadmap"], open: "/simple/roadmap" });
  await expect(chip(page)).toHaveText(/^2 of \d+ PRDs rebuilding · the roadmap updates after them$/);
  await chip(page).click();
  await expect(page.getByTestId("rb-popover").getByTestId("rb-run")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await seedRuns(page, [{ slug: "product-roadmap", state: "running", step: 2, minutes: 55 }]);
  await expect(chip(page)).toHaveText(/^Rebuilding Product roadmap v\d+ · step 2 of \d+ · about 55 min/, { timeout: 15_000 });
});

/** The one-roadmap scenario's PRDs that have a version, in the mock's order. */
async function prdsWithVersions(page: Page): Promise<string[]> {
  await page.goto("/simple/roadmap");
  return page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const withVersions = new Set(db.versions.map((v: { document_id: string }) => v.document_id));
    return db.documents.filter((d: { kind: string; id: string }) => d.kind === "prd" && withVersions.has(d.id)).map((d: { slug: string }) => d.slug);
  });
}

test("a PRD regenerated while a roadmap run reads it: '+1 run', both in the popover (a-one-pager-running-rbcasetwo)", async ({ page }) => {
  await start(page, ONE_ROADMAP_SCENARIO);
  const [prd] = await prdsWithVersions(page);
  await seedRuns(page, [
    { slug: prd, state: "running", step: 2, minutes: 40 },
    { slug: "product-roadmap", state: "scheduled", flow: "prd_to_roadmap", source: prd },
  ], { open: `/simple/one-pagers/${prd}` });
  await expect(chip(page)).toContainText(/^Rebuilding v\d+ · step 2 of \d+ · about 40 min/);
  await expect(chip(page)).toContainText("+1 run");
  await chip(page).click();
  const runs = page.getByTestId("rb-popover").getByTestId("rb-run");
  await expect(runs).toHaveCount(2);
  await expect(runs.nth(1)).toContainText("Roadmap run · Product roadmap");
});

test("the company roadmap's chip says only its own run while one PRD rebuilds", async ({ page }) => {
  await start(page, ONE_ROADMAP_SCENARIO);
  const [prd] = await prdsWithVersions(page);
  await seedRuns(page, [
    { slug: prd, state: "running", step: 2, minutes: 30 },
    { slug: "product-roadmap", state: "running", step: 2, minutes: 55 },
  ], { open: "/simple/roadmap" });
  await expect(chip(page)).toHaveText(/^Rebuilding Product roadmap v\d+ · step 2 of \d+ · about 55 min$/);
  await chip(page).click();
  await expect(page.getByTestId("rb-popover").getByTestId("rb-run")).toHaveCount(1);
});

test("Approve ends 'ready: review it', though the version was never opened", async ({ page }) => {
  await start(page);
  // A PRD with no blocker holding its publish.
  const slug = "saved-carts";
  const { latest } = await seedRuns(page, [{ slug, state: "done" }], { open: "/simple", only: true });
  const v = latest[slug] + 1;
  const home = page.getByTestId("rb-home");
  await expect(home.getByRole("heading", { name: "New versions ready" })).toBeVisible();
  await expect(home.getByTestId("rb-chip")).toHaveText(`v${v} ready: review it`);
  // Publish approves the latest version (C5).
  await page.goto(`/documents/${slug}/publish`);
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog").getByRole("button", { name: /^Publish/ }).click();
  await expect(page.getByTestId("publish-inspector").getByText(`Version v${v} approved with its evidence`)).toBeVisible();
  // Never opened, only approved: Home has nothing new to review.
  await page.getByRole("link", { name: "Home" }).first().click();
  await expect(page).toHaveURL(/\/(simple|home)$/);
  // Give the sign its read (the mock answers in a few ms), then: nothing.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("rb-home")).toHaveCount(0);
});

test("a hidden tab stops reading; shown again, it reads at once", async ({ page }) => {
  await start(page);
  const { ids } = await seedRuns(page, [{ slug: "checkout-redesign", state: "running", step: 2, minutes: 40 }], { open: "/simple/one-pagers/checkout-redesign" });
  await expect(chip(page)).toContainText("step 2 of");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await nextStep(page, ids[0]);
  // Two polls' worth: a hidden tab reads nothing, so the chip still says step 2.
  await page.waitForTimeout(11_000);
  await expect(chip(page)).toContainText("step 2 of");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(chip(page)).toContainText("step 3 of", { timeout: 2000 });
});

test("a commenter reads no sign for a document only approvers see", async ({ page }) => {
  await page.route("**/__rebuild-seed", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>seed</title>" }));
  await login(page, "commenter@example.com");
  await page.goto("/__rebuild-seed");
  await seedRuns(page, [
    { slug: "checkout-redesign", state: "running", step: 2, minutes: 40 },
    { slug: "saved-carts", state: "running", step: 2, minutes: 20 },
  ], { only: true });
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    db.documents.find((d: { slug: string }) => d.slug === "saved-carts").visibility = "approvers";
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  });
  await page.goto("/simple");
  const home = page.getByTestId("rb-home");
  await expect(home.getByRole("listitem")).toHaveCount(1);
  await expect(home).toContainText("Checkout redesign PRD");
  await expect(home).not.toContainText("Saved carts");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the chip fits and its popover sits inside the screen", async ({ page }) => {
    await start(page);
    await seedRuns(page, [{ slug: "checkout-redesign", state: "waiting", step: 3 }], { open: "/simple/one-pagers/checkout-redesign" });
    await expect(chip(page)).toBeVisible();
    await chip(page).click();
    const box = await page.getByTestId("rb-popover").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
