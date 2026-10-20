import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { openSection, section, selectText } from "../helpers";
import { oracle, stackState } from "./stack";

const DOC = "e2e-team-invoices";
const FIXTURES = path.join(__dirname, "fixtures");

async function login(page: Page) {
  const { email, password } = stackState();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
}

type OpenItem = { id: string; kind: string; section_key: string | null; status: string };

test("full loop: push, review, pull, push v2 with resolutions, diff, publish, export", async ({ page }) => {
  const work = await mkdtemp(path.join(tmpdir(), "oracle-e2e-"));

  // The agent track imports v1.
  expect(await oracle("push", path.join(FIXTURES, "draft_v1.md"))).toContain(`Imported ${DOC} version 1`);

  // The reviewer comments inline and gives two section verdicts.
  await login(page);
  await page.getByRole("link", { name: "Team invoices PRD" }).click();
  await page.getByRole("link", { name: "Version 1" }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/v/1$`));

  // One section is open at a time: open each from the outline before using it.
  await openSection(page, "solution");
  await selectText(page, "solution", "Each row has a download link");
  await page.getByRole("button", { name: /^Comment/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Finance leads need many invoices at once. Can they download in bulk?");
  await dialog.getByRole("button", { name: /^Comment/ }).click();
  await expect(dialog).toBeHidden();
  await expect(section(page, "solution").locator("mark.hl-comment")).toHaveText("Each row has a download link");

  const goal = (await openSection(page, "goal")).getByTestId("review-bar");
  await goal.getByRole("button", { name: "Approve" }).click();
  await goal.getByRole("button", { name: /^Save/ }).click();
  await expect(goal.getByTestId("verdict-state")).toContainText("Locked");

  const metrics = (await openSection(page, "metrics")).getByTestId("review-bar");
  await metrics.getByRole("button", { name: "Request changes" }).click();
  await metrics.getByLabel(/What should change/).fill("Give the ticket metric a number and a deadline.");
  await metrics.getByRole("button", { name: /^Save/ }).click();
  await expect(metrics.getByTestId("verdict-state")).toContainText("Changes requested");

  // Both survive a reload, i.e. they are stored by the API.
  // The open section is kept in the hash, so the reload reopens metrics.
  await page.reload();
  await expect(page).toHaveURL(/#metrics$/);
  await expect(section(page, "metrics").getByTestId("verdict-state")).toContainText("Changes requested");
  await expect((await openSection(page, "solution")).locator("mark.hl-comment")).toHaveText(
    "Each row has a download link",
  );
  await expect((await openSection(page, "goal")).getByTestId("verdict-state")).toContainText("Locked");

  // The agent track pulls the feedback package: two open items, the goal locked.
  const pulled = await oracle("pull", DOC, "--version", "1", "--out", work);
  expect(pulled).toContain("2 open item(s), 1 locked section(s) (goal)");
  const items: OpenItem[] = JSON.parse(await readFile(path.join(work, `${DOC}-v1.open-items.json`), "utf8"));
  expect(items.map((i) => [i.kind, i.section_key, i.status]).sort()).toEqual([
    ["comment", "solution", "open"],
    ["section_review", "metrics", "open"],
  ]);
  expect(JSON.parse(await readFile(path.join(work, `${DOC}-v1.locked.json`), "utf8"))).toEqual(["goal"]);

  // Home on the real API: the open feedback needs the reviewer; a fresh company has no goals yet.
  await page.goto("/home");
  await expect(page.getByTestId("home-needs-table")).toContainText("Team invoices PRD");
  await expect(page.getByTestId("home-goals-empty")).toContainText("No goals yet");
  await expect(page.getByTestId("home-inspector").getByRole("img", { name: "1 of 5 sections approved" })).toBeVisible();
  // Error notices are <p role="alert">; Next's route announcer is the only other alert.
  await expect(page.locator("main p[role=alert], [data-testid^=home] p[role=alert]")).toHaveCount(0);

  // One Inbox row per item (owner, 2026-10-20); each opens the review panel on the open items, at its section.
  await page.goto("/inbox");
  const inboxRows = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: "Team invoices PRD" });
  await expect(inboxRows).toHaveCount(2);
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("2");
  await inboxRows.filter({ hasText: "Finance leads need" }).getByRole("link", { name: /^Review comments/ }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/v/1\\?feedback=open#solution$`));
  const review = page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
  await expect(review.getByRole("tab", { name: /^Feedback\s*2$/ })).toHaveAttribute("aria-selected", "true");
  await expect(review.getByTestId("feedback-state").getByRole("button", { name: /^Open/ })).toHaveAttribute("aria-pressed", "true");
  const open = review.getByTestId("feedback-item");
  await expect(open).toHaveCount(2);
  await expect(open.first().getByRole("button", { name: "Resolve", exact: true })).toBeInViewport();

  // v2 answers both items.
  const byKind = (kind: string) => items.find((i) => i.kind === kind)!.id;
  const v2 = (await readFile(path.join(FIXTURES, "draft_v2.md"), "utf8"))
    .replace("{{COMMENT_ITEM}}", byKind("comment"))
    .replace("{{VERDICT_ITEM}}", byKind("section_review"));
  await writeFile(path.join(work, "draft_v2.md"), v2);
  const pushed = await oracle("push", path.join(work, "draft_v2.md"));
  expect(pushed).toContain(`Imported ${DOC} version 2`);
  expect(pushed).toContain("No warnings");

  // The diff shows the changed sections, word by word.
  await page.goto(`/documents/${DOC}/v/2`);
  await page.getByRole("link", { name: "Compare with v1" }).click();
  await expect(page).toHaveURL(/\/diff\?from=1&to=2$/);
  const diffOf = (k: string) => page.getByTestId("diff-section").filter({ hasText: `#${k}` });
  await expect(diffOf("solution")).toHaveAttribute("data-status", "changed");
  await expect(diffOf("solution").getByTestId("word-diff").locator("ins").first()).toContainText("zip archive");
  await expect(diffOf("metrics")).toHaveAttribute("data-status", "changed");
  await expect(diffOf("goal")).toHaveCount(0);

  // The resolution report on v2 shows both items addressed.
  await page.goto(`/documents/${DOC}/v/2`);
  // History holds the resolution report (Resolutions, Reports and Jobs), every section.
  await page.getByRole("tab", { name: /^History/ }).click();
  const report = page.getByTestId("history-resolutions");
  const rows = report.getByTestId("feedback-item");
  await expect(rows).toHaveCount(2);
  for (const note of ["bulk download as a zip archive", "numeric target for support tickets"]) {
    const row = rows.filter({ hasText: note });
    await expect(row).toContainText("Addressed");
    await expect(row).toContainText("Addressed in v2");
  }

  // Publish v2 (the PRD has no blocks: the API's publish gate lets it through), then export it.
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await page.getByTestId("doc-header").getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/publish$`));
  await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v2");
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog", { name: "Publish v2?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v2");
  await page.goto(`/documents/${DOC}/v/2`);
  await expect(page.getByText(/✓ Approved/)).toBeVisible();
  await expect(page.getByText(/review is closed/)).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${DOC}-v2.pdf`);
  const pdf = await readFile((await file.path())!);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");
  expect(pdf.length).toBeGreaterThan(2_000);
});
