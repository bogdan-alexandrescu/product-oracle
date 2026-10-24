import { expect, type Page } from "@playwright/test";

import { stackState } from "./stack";

/** Signs in as the seeded admin (an owner: the stack's only member, so also the approver). */
export async function login(page: Page) {
  const { email, password } = stackState();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/**
 * Starting data: a confirmed Baseline entity (goals and features start proposed and are
 * confirmed), seeded through the API as publish.spec.ts seeds its blocker. Specs share one
 * database in file order: feedback-loop.spec.ts expects no goals, so seed them after it.
 */
export async function confirmedEntity(page: Page, data: Record<string, unknown>): Promise<{ id: string; title: string }> {
  const created = await page.request.post("/v1/baseline/entities", { data });
  expect(created.status(), await created.text()).toBe(201);
  const { entity } = await created.json();
  if (entity.status === "confirmed") return entity;
  const confirmed = await page.request.post(`/v1/baseline/entities/${entity.id}/confirm`);
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  return confirmed.json();
}

/** A Company tab from the rail, as a person gets there. */
export async function openCompanyTab(page: Page, tab: "metrics" | "market") {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId(`company-tab-${tab}`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/company/${tab}$`));
}

/** A tab of Company › Market. */
export async function openMarketTab(page: Page, tab: "alternatives" | "changes" | "positioning" | "pricing" | "win-loss") {
  await page.getByTestId(`market-tab-${tab}`).click();
  await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
}
