import { expect, type Locator, type Page, test } from "@playwright/test";

import { login } from "./helpers";

const KEY = "po-mock-sources-v2";
const MESSAGE = "This source changed since you opened it. Reload to see the current picks.";

/** Another tab saved: the mock's stored source now has this config and the next version. */
async function changeUnderneath(page: Page, name: string, config: Record<string, unknown>) {
  await page.evaluate(
    ([key, n, c]) => {
      const db = JSON.parse(localStorage.getItem(key as string)!);
      const s = db.sources.find((x: { name: string }) => x.name === n);
      s.config = c;
      s.config_version += 1;
      localStorage.setItem(key as string, JSON.stringify(db));
    },
    [KEY, name, config] as const,
  );
}

async function openPicker(page: Page): Promise<Locator> {
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit allowlist" }).click();
  await expect(chat.getByRole("group", { name: "Slack channels" }).getByTestId("picked-count")).toHaveText("2 selected");
  return chat;
}

test("a stale save shows the message, nothing is applied, and Reload shows the current picks", async ({ page }) => {
  const chat = await openPicker(page);
  const picker = chat.getByRole("group", { name: "Slack channels" });
  // Another tab narrows the source to one channel while this form still has two.
  await changeUnderneath(page, "Product chat", { channels: ["C0123PRODUCT"] });

  await picker.getByRole("checkbox", { name: "#customer-feedback" }).uncheck();
  await picker.getByRole("checkbox", { name: "#roadmap" }).check();
  await chat.getByRole("button", { name: "Save allowlist" }).click();

  const alert = chat.getByRole("alert");
  await expect(alert).toContainText(MESSAGE);
  await expect(alert).toContainText("discard");
  // The stale save was not applied.
  await expect(chat).not.toContainText("G0789ROADMAP");
  await expect(chat.getByRole("status")).toHaveCount(0);

  await alert.getByRole("button", { name: "Reload" }).click();
  await expect(alert).toHaveCount(0);
  const fresh = chat.getByRole("group", { name: "Slack channels" });
  await expect(fresh.getByTestId("picked-count")).toHaveText("1 selected");
  await expect(fresh.getByRole("checkbox", { name: "#product" })).toBeChecked();
  await expect(fresh.getByRole("checkbox", { name: "#roadmap" })).not.toBeChecked();

  // Saving from the reloaded form works.
  await fresh.getByRole("checkbox", { name: "#roadmap" }).check();
  await chat.getByRole("button", { name: "Save allowlist" }).click();
  await expect(chat.getByRole("status")).toHaveText("Allowlist saved.");
});

test("the meetings editor of a Fireflies source refuses a stale save too", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const calls = page.getByRole("listitem", { name: "Customer calls" });
  await calls.getByRole("button", { name: "More actions for Customer calls" }).click();
  await calls.getByRole("menuitem", { name: "Edit meetings" }).click();
  const form = calls.getByRole("form", { name: "Meetings of Customer calls" });
  await expect(form).toBeVisible();
  await changeUnderneath(page, "Customer calls", { from_date: "2026-10-01", title_contains: ["Customer interview"] });
  await form.getByRole("button", { name: "Save meetings" }).click();
  await expect(calls.getByRole("alert")).toContainText(MESSAGE);
});
