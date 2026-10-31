import { createHmac } from "node:crypto";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { WEBHOOK_RECEIVER, WEBHOOKS_SCENARIO, type ReceivedCall } from "../lib/api/mock/webhooks";
import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/**
 * I1 lane 3: Settings › Webhooks, driven as a person would. The stub receiver is this
 * fixture's: the mock's outbox posts each delivery to it (page.exposeFunction), as the
 * API's guarded transport posts to a receiver, and it answers 200 unless told otherwise.
 */
async function stubReceiver(page: Page, answer: (call: ReceivedCall) => { status: number; body: string } = () => ({ status: 200, body: "ok" })) {
  const calls: ReceivedCall[] = [];
  await page.exposeFunction(WEBHOOK_RECEIVER, (call: ReceivedCall) => {
    calls.push(call);
    return answer(call);
  });
  return calls;
}

/** Standard Webhooks: v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>. */
function signs(call: ReceivedCall, secret: string, body = call.body) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", key).update(`${call.headers["webhook-id"]}.${call.headers["webhook-timestamp"]}.${body}`).digest("base64");
  return call.headers["webhook-signature"].split(" ").includes(`v1,${want}`);
}

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openWebhooks(page: Page, email?: string) {
  await login(page, email);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-webhooks").click();
  await expect(page).toHaveURL(/\/settings\/webhooks$/);
  await expect(page.getByRole("heading", { level: 1, name: "Webhooks" })).toBeVisible();
}

async function createWebhook(page: Page, name: string, url: string, groups: string[] = ["Runs"]) {
  await page.getByRole("button", { name: "New webhook" }).click();
  const form = page.getByRole("dialog", { name: "New webhook" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("URL").fill(url);
  for (const g of groups) await form.getByRole("checkbox", { name: `All ${g}` }).check();
  await form.getByRole("button", { name: "Create" }).click();
  // qa4-settings-29: once made, the dialog says so.
  const sheet = page.getByRole("dialog", { name: "Webhook created" });
  await expect(sheet).toContainText("Copy it now. Oracle won't show it again.");
  const secret = await sheet.getByLabel("Signing secret", { exact: true }).inputValue();
  expect(secret).toMatch(/^whsec_/);
  return { sheet, secret };
}

test("webhooks: an owner creates one, gets the secret once, sends a test event the receiver can verify", async ({ page }) => {
  const calls = await stubReceiver(page);
  await openWebhooks(page);
  // qa-settings-11: the intro is in the page's tip, as on every Settings tab.
  await page.getByRole("button", { name: "About Webhooks" }).click();
  await expect(page.getByRole("tooltip").filter({ hasText: "Tell your other tools when runs, drafts and approvals change." })).toBeVisible();
  await page.getByRole("button", { name: "About Webhooks" }).click();

  // https only, and an event to send.
  await page.getByRole("button", { name: "New webhook" }).click();
  const draft = page.getByRole("dialog", { name: "New webhook" });
  await draft.getByLabel("Name").fill("Tracker bot");
  await draft.getByLabel("URL").fill("http://hooks.example.test/oracle");
  await draft.getByRole("checkbox", { name: "A run started" }).check();
  await draft.getByRole("button", { name: "Create" }).click();
  await expect(draft.getByRole("alert")).toContainText("https://");
  await draft.getByRole("button", { name: "Close New webhook" }).click();

  const { sheet, secret } = await createWebhook(page, "Tracker bot", "https://hooks.example.test/oracle", ["Runs", "Approvals"]);
  await sheet.getByRole("button", { name: "Copy" }).click();
  await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
  await sheet.getByRole("button", { name: "Send test event" }).click();
  await expect(sheet.getByTestId("test-result")).toContainText("✓ 200");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);

  // The receiver got it, signed with the secret; a changed body does not verify.
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://hooks.example.test/oracle");
  expect(calls[0].headers["webhook-id"]).toMatch(/^evt_/);
  expect(JSON.parse(calls[0].body).type).toBe("webhook.test");
  expect(signs(calls[0], secret)).toBe(true);
  expect(signs(calls[0], secret, calls[0].body.replace("Test", "Tset"))).toBe(false);

  // Reopened, it shows only the last 4 characters; the secret is nowhere on the page.
  const row = page.getByTestId("webhook-row").filter({ hasText: "Tracker bot" });
  await expect(row).toContainText("hooks.example.test");
  await expect(row).toContainText("Active");
  await expect(row).toContainText("✓ 200");
  await row.click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector.getByTestId("secret-hint")).toHaveText(`…${secret.slice(-4)}`);
  await expect(page.locator("body")).not.toContainText(secret);

  // The delivery log: the test event, ✓ 200; its row opens the body, headers and response.
  const log = inspector.getByTestId("delivery-log");
  const delivery = log.getByTestId("delivery-row").first();
  await expect(delivery).toContainText("Test event");
  await expect(delivery).toContainText("✓ 200");
  await delivery.click();
  const detail = page.getByRole("dialog", { name: "Delivery" });
  await expect(detail.getByTestId("delivery-body")).toContainText("Test from Product Oracle");
  await expect(detail.getByTestId("delivery-headers")).toContainText(`webhook-id: ${calls[0].headers["webhook-id"]}`);
  await expect(detail.getByTestId("delivery-headers")).toContainText("webhook-signature: v1,…");
  await expect(detail.getByTestId("delivery-response")).toContainText("ok");
  await expect(detail).toContainText("Company time");

  // Redeliver: a new delivery with the same webhook-id, so the receiver dedupes it.
  await detail.getByRole("button", { name: "Redeliver" }).click();
  await expect(detail).toHaveCount(0);
  await expect(log.getByTestId("delivery-row")).toHaveCount(2);
  expect(calls).toHaveLength(2);
  expect(calls[1].headers["webhook-id"]).toBe(calls[0].headers["webhook-id"]);
});

test("webhooks: rotate shows a new secret once and both sign for 24 hours; pause, resume and delete by name", async ({ page }) => {
  const calls = await stubReceiver(page);
  await openWebhooks(page);
  const { sheet, secret } = await createWebhook(page, "Pager", "https://hooks.example.test/pager");
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("webhook-row").filter({ hasText: "Pager" }).click();
  const inspector = page.getByTestId("webhook-inspector");

  await inspector.getByRole("button", { name: "Rotate secret" }).click();
  const confirm = page.getByTestId("rotate-dialog");
  await expect(confirm).toContainText("24 hours");
  await confirm.getByRole("button", { name: "Rotate" }).click();
  const shown = page.getByRole("dialog", { name: "New signing secret" });
  await expect(shown).toContainText("Copy it now. Oracle won't show it again.");
  const rotated = await shown.getByLabel("Signing secret", { exact: true }).inputValue();
  expect(rotated).not.toBe(secret);
  await shown.getByRole("button", { name: "Send test event" }).click();
  await expect(shown.getByTestId("test-result")).toContainText("✓ 200");
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(inspector.getByTestId("secret-hint")).toHaveText(`…${rotated.slice(-4)}`);
  // During the overlap the old and the new secret both sign.
  expect(signs(calls[0], secret)).toBe(true);
  expect(signs(calls[0], rotated)).toBe(true);

  await inspector.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("webhook-row").filter({ hasText: "Pager" })).toContainText("Paused");
  await inspector.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("webhook-row").filter({ hasText: "Pager" })).toContainText("Active");

  await inspector.getByRole("button", { name: "Delete" }).click();
  const del = page.getByTestId("delete-dialog");
  const confirmDelete = del.getByRole("button", { name: "Delete" });
  await expect(confirmDelete).toBeDisabled();
  await del.getByLabel("Type the webhook's name").fill("Pager");
  await confirmDelete.click();
  await expect(page.getByTestId("webhook-row")).toHaveCount(0);
});

test("webhooks: an owner sees who made each, turns on owners-and-approvers content with a reason, and takes over a paused one", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await stubReceiver(page);
  await openWebhooks(page);
  const deploy = page.getByTestId("webhook-row").filter({ hasText: "Deploy notifier" });
  await expect(deploy).toContainText("Approver");
  await expect(deploy).toContainText("Paused: failing");
  // Last delivery reads how long ago, not a day.
  await expect(deploy).toContainText("✕ 500 · 4 h ago");

  // The owners-and-approvers switch needs a why.
  await page.getByRole("button", { name: "New webhook" }).click();
  const sheet = page.getByRole("dialog", { name: "New webhook" });
  await sheet.getByLabel("Name").fill("Leads channel");
  await sheet.getByLabel("URL").fill("https://hooks.example.test/leads");
  await sheet.getByRole("checkbox", { name: "All Approvals" }).check();
  await sheet.getByRole("switch", { name: "Include owners-and-approvers content" }).click();
  await expect(sheet.getByRole("button", { name: "Create" })).toBeDisabled();
  await sheet.getByLabel("Why").fill("The leads channel is owners and approvers only");
  await sheet.getByRole("button", { name: "Create" }).click();
  await page.getByRole("dialog", { name: "Webhook created" }).getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("webhook-row").filter({ hasText: "Leads channel" }).getByTestId("approvers-content-lock")).toBeVisible();

  // Take over the approver's paused webhook: it becomes the owner's.
  await deploy.click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector.getByTestId("delivery-row").first()).toContainText("500");
  // The log: When · Event · Status · HTTP · Time, its times in Company time.
  const log = inspector.getByTestId("delivery-log");
  await expect(log.getByRole("columnheader")).toHaveText(["When", "Event", "Status", "HTTP", "Time"]);
  await expect(log.getByTestId("delivery-row").first().getByTestId("delivery-http")).toHaveText("500");
  await expect(log).toContainText("Times are in Company time");
  await inspector.getByLabel("Status").selectOption("failed");
  await expect(inspector.getByTestId("delivery-row")).toHaveCount(2);
  await inspector.getByRole("button", { name: "Take over" }).click();
  await expect(deploy).toContainText("Admin");
  await expect(inspector.getByRole("button", { name: "Take over" })).toHaveCount(0);
});

test("webhooks: an approver sees only their own and gets no owners-and-approvers switch; a commenter has no tab", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  // The seed's approver made both of its webhooks; the owner's own (none here) are not listed.
  await openWebhooks(page, "approver@example.com");
  await expect(page.getByTestId("webhook-row")).toHaveCount(2);
  await expect(page.getByTestId("webhook-row").nth(0)).toContainText("Deploy notifier");
  await expect(page.getByTestId("webhook-row").nth(1)).toContainText("Release notes");
  await page.getByTestId("webhook-row").filter({ hasText: "Deploy notifier" }).click();
  await expect(page.getByTestId("webhook-inspector").getByRole("button", { name: "Take over" })).toHaveCount(0);
  await page.getByRole("button", { name: "New webhook" }).click();
  const sheet = page.getByRole("dialog", { name: "New webhook" });
  await expect(sheet.getByRole("checkbox", { name: "A run started" })).toBeVisible();
  await expect(sheet.getByRole("switch", { name: "Include owners-and-approvers content" })).toHaveCount(0);
});

test("webhooks: a commenter does not see the Webhooks tab", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-members")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-webhooks")).toHaveCount(0);
});

test("webhooks: the Inbox rows: failing (Open, Resume), a changed address, and paused by an owner", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page);
  await page.goto("/inbox");
  const rows = page.getByTestId("inbox-webhooks");
  const failing = rows.getByRole("row").filter({ hasText: "Webhook Deploy notifier paused: failing for 3 days" });
  await expect(failing).toBeVisible();
  await expect(rows).toContainText("Approver changed where webhook Deploy notifier sends");
  await failing.getByRole("button", { name: "Resume" }).click();
  await expect(failing).toHaveCount(0);
  await page.getByRole("tab", { name: /Done/ }).click();
  await expect(page.getByTestId("inbox-webhooks")).toContainText("Webhook Deploy notifier paused: failing for 3 days");
  await page.getByRole("tab", { name: /New/ }).click();
  await page.getByTestId("inbox-webhooks").getByRole("row").filter({ hasText: "changed where" }).getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/webhooks\?webhook=/);
  await expect(page.getByTestId("webhook-inspector")).toContainText("Deploy notifier");
  await expect(page.getByTestId("webhook-row").filter({ hasText: "Deploy notifier" })).toContainText("Active");
});

test("webhooks: an approver's Inbox says an owner paused their webhook", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page, "approver@example.com");
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-webhooks")).toContainText("Admin paused your webhook Release notes");
});

test("webhooks: on a phone the table shows Name and Status, and the sheet stacks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page);
  await page.goto("/settings/webhooks");
  const row = page.getByTestId("webhook-row").filter({ hasText: "Deploy notifier" });
  await expect(row).toContainText("Paused: failing");
  await expect(row.getByText("hooks.example.test")).toBeHidden();
  await page.getByRole("button", { name: "New webhook" }).click();
  const sheet = page.getByRole("dialog", { name: "New webhook" });
  const name = await sheet.getByLabel("Name").boundingBox();
  const url = await sheet.getByLabel("URL").boundingBox();
  expect(url!.y).toBeGreaterThan(name!.y + name!.height - 1);
  expect(Math.abs(url!.x - name!.x)).toBeLessThan(2);
});

test("webhooks: an owner edits the name, the URL and the events, and turns owners-and-approvers content on and off with a reason", async ({ page }) => {
  await stubReceiver(page);
  await openWebhooks(page);
  const { sheet } = await createWebhook(page, "Leads channel", "https://hooks.example.test/leads");
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("webhook-row").filter({ hasText: "Leads channel" }).click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector.getByTestId("approvers-content")).toHaveText("Off");

  await inspector.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit webhook" });
  await expect(edit.getByLabel("Name")).toHaveValue("Leads channel");
  await expect(edit.getByLabel("URL")).toHaveValue("https://hooks.example.test/leads");
  await expect(edit.getByRole("checkbox", { name: "All Runs" })).toBeChecked();
  await edit.getByLabel("Name").fill("Leads");
  await edit.getByLabel("URL").fill("http://relay.example.test/leads");
  await edit.getByRole("checkbox", { name: "All Approvals" }).check();
  await edit.getByRole("checkbox", { name: "A run started" }).uncheck();
  await edit.getByRole("switch", { name: "Include owners-and-approvers content" }).click();
  await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
  await edit.getByLabel("Why").fill("The leads channel is owners and approvers only");
  await edit.getByRole("button", { name: "Save" }).click();
  // The API's refusal shows in the sheet; nothing changed.
  await expect(edit.getByRole("alert")).toContainText("https://");
  await edit.getByLabel("URL").fill("https://relay.example.test/leads");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);

  const row = page.getByTestId("webhook-row").filter({ hasText: "Leads" });
  await expect(row).toContainText("relay.example.test");
  await expect(row).toContainText("12");
  await expect(row.getByTestId("approvers-content-lock")).toBeVisible();
  await expect(inspector.getByTestId("approvers-content")).toHaveText("On");
  await expect(inspector).toContainText("12 events:");
  await expect(inspector).not.toContainText("A run started ·");

  // Off again, with a reason too.
  await inspector.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("switch", { name: "Include owners-and-approvers content" }).click();
  await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
  await edit.getByLabel("Why").fill("Moved to the approvers' own channel");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row.getByTestId("approvers-content-lock")).toHaveCount(0);
  await expect(inspector.getByTestId("approvers-content")).toHaveText("Off");
});

test("webhooks: an approver re-points their webhook and the owner's Inbox says so", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await openWebhooks(page, "approver@example.com");
  await page.getByTestId("webhook-row").filter({ hasText: "Release notes" }).click();
  const inspector = page.getByTestId("webhook-inspector");
  await inspector.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit webhook" });
  // No owners-and-approvers switch for an approver.
  await expect(edit.getByRole("switch", { name: "Include owners-and-approvers content" })).toHaveCount(0);
  await edit.getByLabel("URL").fill("https://relay.example.test/notes");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId("webhook-row").filter({ hasText: "Release notes" })).toContainText("relay.example.test");

  await signOut(page);
  await login(page);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-webhooks").getByRole("row").filter({ hasText: "Approver changed where webhook Release notes sends" });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page.getByTestId("webhook-inspector")).toContainText("relay.example.test");
});

test("webhooks: AC17, a run's checkpoint waiting, decided and the run succeeding each reach the receiver and the delivery log", async ({ page }) => {
  const calls = await stubReceiver(page);
  await openWebhooks(page);
  const { sheet } = await createWebhook(page, "Run watcher", "https://hooks.example.test/runs");
  await sheet.getByRole("button", { name: "Done" }).click();

  // Build the baseline: the fake runtime's run waits at Confirm the baseline; approve it.
  await page.getByTestId("nav-baseline").filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Build baseline" }).click();
  const build = page.getByRole("dialog", { name: "Build the baseline" });
  await build.getByRole("button", { name: "Start" }).click();
  await expect(build).toHaveCount(0);
  await page.getByTestId("baseline-build-banner").getByRole("link", { name: "Open run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const cp = page.getByTestId("checkpoint-baseline_confirm").filter({ hasText: "Waiting" });
  await cp.getByRole("button", { name: "Approve and continue" }).click();
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Succeeded");

  const sent = calls.map((c) => JSON.parse(c.body).type);
  expect(sent).toEqual(expect.arrayContaining(["run.started", "run.checkpoint_waiting", "run.checkpoint_decided", "run.succeeded"]));
  const decided = calls.map((c) => JSON.parse(c.body)).find((b) => b.type === "run.checkpoint_decided");
  expect(decided.data.checkpoint).toMatchObject({ kind: "baseline_confirm", outcome: "approved" });

  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-webhooks").click();
  await page.getByTestId("webhook-row").filter({ hasText: "Run watcher" }).click();
  const log = page.getByTestId("webhook-inspector").getByTestId("delivery-log");
  // qa4-settings-26: the log names each event as the form does.
  for (const type of ["A run is waiting at a checkpoint for a person", "A checkpoint was approved or sent back with changes", "A run succeeded"]) {
    await expect(log.getByTestId("delivery-row").filter({ hasText: type })).toContainText("✓ 200");
  }
  // The newest first: the run's success above its checkpoint's decision.
  await expect(log.getByTestId("delivery-row").first()).toContainText("A run succeeded");
});
