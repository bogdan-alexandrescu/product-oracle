// Visual QA capture (vqa-simple-runs): the picked mock-up frames (static HTML, ?theme=) and the
// built app driven to the same states, light and dark. Run with e2e/vqa/vqa.config.ts.
// VQA_FRAMES: folder holding mockups-out/<mk>/frames; VQA_OUT: where the PNGs go.
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../test";
import { MOCK_SCENARIO_KEY } from "../../lib/api/mock/server";
import { PRIORITY_RUN } from "../../lib/api/mock/runs";
import { login } from "../helpers";

const OUT = process.env.VQA_OUT ?? path.join(process.env.TMPDIR ?? ".", "vqa-shots");
const MK = process.env.VQA_FRAMES ?? "";
const ONLY = process.env.VQA_ONLY ? new RegExp(process.env.VQA_ONLY) : null;
const SIDE = process.env.VQA_SIDE ?? "both";

type Go = (page: Page) => Promise<void>;
type Frame = { file: string; mk: string; w: number; h: number; go: Go };

const D = { w: 1440, h: 900 };
const W = { w: 1512, h: 982 };
const W9 = { w: 1512, h: 900 };
const P = { w: 390, h: 844 };

const settle = async (page: Page) => {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
};
const center = async (page: Page, l: ReturnType<Page["getByText"]>) => {
  await l.first().evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
};
const top = async (page: Page, l: ReturnType<Page["getByText"]>, off = 24) => {
  await l.first().evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.evaluate((o) => scrollBy(0, -o), off);
  await page.waitForTimeout(300);
};
const scenario = async (page: Page, s: string) => page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, s] as const);

/* RP1 'Scored with the rest': the run's order stop. */
const order = (after?: Go): Go => async (page) => {
  await scenario(page, "priority-order");
  await login(page, "approver@example.com");
  await page.goto(`/runs/${PRIORITY_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page).toHaveURL(/\/priorities\?snapshot=/);
  await expect(page.locator('[data-testid^="priority-row-"]').first()).toBeVisible();
  await settle(page);
  if (after) await after(page);
};
const openN4: Go = async (page) => {
  await page.getByTestId("priority-row-N-4").getByRole("button", { name: /Import addresses from a spreadsheet/ }).first().click();
  await page.waitForTimeout(600);
};

/* RP2 'Meeting step as draft': the review meeting's Roadmap step. */
const meeting = (after?: Go): Go => async (page) => {
  await scenario(page, "meeting-draft-dates");
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await page.getByRole("button", { name: "Start review" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Saved carts" });
  await sheet.getByRole("checkbox", { name: "Priya Raman" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Saved carts" })).toBeVisible();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
  await expect(page.getByRole("region", { name: "Roadmap slice" })).toBeVisible();
  await settle(page);
  if (after) await after(page);
};
const slice = (page: Page) => page.getByRole("region", { name: "Roadmap slice" });
const moveQuote: Go = async (page) => {
  await slice(page).locator("li").filter({ hasText: "Turn a cart into a quote" }).getByRole("button", { name: "Change dates for Turn a cart into a quote" }).click();
  await slice(page).getByRole("textbox", { name: "Start", exact: true }).fill("2027-05-03");
  await slice(page).getByRole("textbox", { name: "End", exact: true }).fill("2027-06-25");
  await slice(page).getByRole("button", { name: "Save dates" }).click();
  await page.waitForTimeout(500);
};
const openApprove: Go = async (page) => {
  await moveQuote(page);
  await slice(page).getByRole("button", { name: "Approve these 6 dates" }).click();
  await page.waitForTimeout(400);
  await center(page, slice(page).getByRole("dialog", { name: "Approve dates" }).getByRole("button", { name: "Approve dates" }) as never);
};
const approved: Go = async (page) => {
  await slice(page).getByRole("button", { name: "Approve these 6 dates" }).click();
  await slice(page).getByRole("dialog", { name: "Approve dates" }).getByRole("button", { name: "Approve dates" }).click();
  await page.waitForTimeout(800);
};

/* RD1 'A Runs group': Simple › Decisions, the Runs card. */
const decisions = (s: string, after?: Go): Go => async (page) => {
  await scenario(page, s);
  await login(page);
  await page.goto("/simple/decisions");
  await settle(page);
  const runs = page.getByRole("region", { name: "Runs", exact: true });
  await expect(runs).toBeVisible();
  await top(page, runs as never);
  if (after) await after(page);
};
const showWhat: Go = async (page) => {
  await page.getByRole("button", { name: /Show what happened/ }).first().click();
  await page.waitForTimeout(500);
};

/* RD2 'Separate Approve step': the run's PRD review on the one-pager. */
const runReview = (after?: Go): Go => async (page) => {
  await scenario(page, "run-review");
  await login(page);
  await page.goto("/simple/one-pagers/usage-alerts");
  await expect(page.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible();
  await settle(page);
  if (after) await after(page);
};
const rdOpen: Go = async (page) => {
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await page.waitForTimeout(400);
};
const rdMid: Go = async (page) => {
  await rdOpen(page);
  await page.getByRole("textbox", { name: "Note for the run (optional)" }).fill("Good to build from version 3.");
  await page.waitForTimeout(300);
};
const rdNext: Go = async (page) => {
  await rdMid(page);
  await page.getByRole("button", { name: "Approve review" }).click();
  await page.waitForTimeout(600);
};
const rdDone: Go = async (page) => {
  await rdNext(page);
  await page.getByRole("button", { name: "Approve the PRD" }).click();
  await page.waitForTimeout(600);
};

/* RD3 'Waiting for you + agenda': Home's PRD card and the review meeting's agenda. */
const home = (after?: Go): Go => async (page) => {
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("home-sentence")).toBeVisible();
  await settle(page);
  if (after) await after(page);
};
const prdCard = (page: Page) => page.getByRole("region", { name: /^Waiting for you: / }).first();
const rd3Open: Go = async (page) => {
  await top(page, prdCard(page) as never, 120);
  await prdCard(page).getByRole("button", { name: "Another answer" }).first().click();
  await page.waitForTimeout(300);
};
const rd3Done: Go = async (page) => {
  await rd3Open(page);
  await prdCard(page).getByRole("group", { name: /^Answers for / }).first().getByRole("button").first().click();
  await page.waitForTimeout(600);
};
const agenda: Go = async (page) => {
  await login(page);
  await page.goto("/simple/prds/guided-setup");
  await page.getByRole("button", { name: "Start a review meeting" }).click();
  await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: /Decisions/ }).first().click();
  await settle(page);
};

/* SW1 'A card per stop': Simple Home's run stop cards. */
const waits = (s: string | null, after?: Go): Go => async (page) => {
  if (s) await scenario(page, s);
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("home-sentence")).toBeVisible();
  await settle(page);
  if (after) await after(page);
};
const stops = (page: Page) => page.getByTestId("home-run-stop");
const toStops: Go = async (page) => top(page, stops(page) as never);
const hover2: Go = async (page) => {
  await toStops(page);
  await stops(page).nth(1).getByRole("link").hover();
  await page.waitForTimeout(300);
};
const result: Go = async (page) => {
  await stops(page).nth(1).getByRole("link").click();
  await page.waitForURL(/\/runs\//);
  await settle(page);
  await page.waitForTimeout(800);
};

const RP = "mk-runplan";
const RD = "mk-rundecide";
const SW = "mk-simplewaits";
const ALL: Frame[] = [
  { file: "rp1-a-rest", mk: RP, ...D, go: order() },
  { file: "rp1-a-open", mk: RP, ...D, go: order(openN4) },
  { file: "rp1-a-done", mk: RP, ...D, go: order(async (p) => { await p.getByTestId("snapshot-band").getByRole("button", { name: "Approve order" }).click(); await p.waitForTimeout(800); }) },
  { file: "rp1-a-rest-1512", mk: RP, ...W, go: order(openN4) },
  { file: "rp1-a-rest-390", mk: RP, ...P, go: order() },
  { file: "rp2-c-rest", mk: RP, ...D, go: meeting() },
  { file: "rp2-c-mid", mk: RP, ...D, go: meeting(moveQuote) },
  { file: "rp2-c-open", mk: RP, ...D, go: meeting(openApprove) },
  { file: "rp2-c-done", mk: RP, ...D, go: meeting(approved) },
  { file: "rp2-c-rest-1512", mk: RP, ...W, go: meeting() },
  { file: "rp2-c-rest-390", mk: RP, ...P, go: meeting() },
  { file: "rd1-a-rest", mk: RD, ...D, go: decisions("run-decisions") },
  { file: "rd1-a-open", mk: RD, ...D, go: decisions("run-decisions", showWhat) },
  { file: "rd1-a-many-1512", mk: RD, ...W9, go: decisions("run-decisions-many") },
  { file: "rd1-a-rest-390", mk: RD, ...P, go: decisions("run-decisions") },
  { file: "rd2-b-rest", mk: RD, ...D, go: runReview() },
  { file: "rd2-b-open", mk: RD, ...D, go: runReview(rdOpen) },
  { file: "rd2-b-mid", mk: RD, ...D, go: runReview(rdMid) },
  { file: "rd2-b-next", mk: RD, ...D, go: runReview(rdNext) },
  { file: "rd2-b-done", mk: RD, ...D, go: runReview(rdDone) },
  { file: "rd2-b-next-1512", mk: RD, ...W9, go: runReview(rdNext) },
  { file: "rd2-b-open-390", mk: RD, ...P, go: runReview(rdMid) },
  { file: "rd3-a-rest", mk: RD, ...D, go: home(async (p) => top(p, prdCard(p) as never, 120)) },
  { file: "rd3-a-open", mk: RD, ...D, go: home(rd3Open) },
  { file: "rd3-a-done", mk: RD, ...D, go: home(rd3Done) },
  { file: "rd3-a-agenda", mk: RD, ...D, go: agenda },
  { file: "rd3-a-rest-1512", mk: RD, ...W9, go: home() },
  { file: "rd3-a-rest-390", mk: RD, ...P, go: home(async (p) => top(p, prdCard(p) as never)) },
  { file: "sw1-a-zero", mk: SW, ...D, go: waits("simple-waits", async (p) => { await scenario(p, "simple-waits"); }) },
  { file: "sw1-a-one", mk: SW, ...D, go: waits(null) },
  { file: "sw1-a-rest", mk: SW, ...D, go: waits("simple-waits") },
  { file: "sw1-a-hover", mk: SW, ...D, go: waits("simple-waits", hover2) },
  { file: "sw1-a-result", mk: SW, ...D, go: waits("simple-waits", result) },
  { file: "sw1-a-rest-1512", mk: SW, ...W, go: waits("simple-waits", async (p) => top(p, p.getByTestId("home-summary") as never)) },
  { file: "sw1-a-rest-390", mk: SW, ...P, go: waits("simple-waits", toStops) },
];
// sw1-a-zero: the built app has no 'nothing waits' scenario for runs; a viewer sees Home with no card.
ALL.find((f) => f.file === "sw1-a-zero")!.go = async (page) => {
  await scenario(page, "simple-waits");
  await login(page, "viewer@example.com");
  await page.goto("/simple");
  await expect(page.getByTestId("home-sentence")).toBeVisible();
  await settle(page);
};

for (const f of ALL.filter((x) => !ONLY || ONLY.test(x.file))) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${f.file} ${theme}`, () => {
      test.use({ viewport: { width: f.w, height: f.h }, colorScheme: theme, ...(f.w < 600 ? { isMobile: true, hasTouch: true } : {}) });
      if (SIDE !== "built")
        test("picked", async ({ page }) => {
          const html = path.join(MK, "mockups-out", f.mk, "frames", `${f.file}.html`);
          test.skip(!MK || !fs.existsSync(html), "no frame");
          await page.goto(`file://${html}?theme=${theme}`);
          await page.waitForTimeout(800);
          fs.mkdirSync(OUT, { recursive: true });
          await page.screenshot({ path: path.join(OUT, `${f.file}__picked__${theme}.png`) });
        });
      if (SIDE !== "picked")
        test("built", async ({ page }) => {
          const errors: string[] = [];
          page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
          await page.addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
          await f.go(page);
          await page.waitForTimeout(400);
          const sw = await page.evaluate(() => document.documentElement.scrollWidth);
          fs.mkdirSync(OUT, { recursive: true });
          await page.screenshot({ path: path.join(OUT, `${f.file}__built__${theme}.png`) });
          fs.appendFileSync(path.join(OUT, "built-notes.txt"), `${f.file} ${theme} scrollWidth=${sw} errors=${JSON.stringify(errors)}\n`);
        });
    });
  }
}
