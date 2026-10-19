import { expect, type Locator, type Page } from "@playwright/test";

import { MOCK_LOGIN } from "../lib/api/mock/fixtures";

export const ADMIN = MOCK_LOGIN;

/** Signs in as the mock owner, or as the mock member with `email` (one per role). */
export async function login(page: Page, email: string = ADMIN.email) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
}

/** A section of the visible version (Next keeps recently visited routes mounted but hidden). */
export function section(page: Page, key: string): Locator {
  return page.locator(`section[data-section-key="${key}"]`).filter({ visible: true });
}

/** Selects `text` inside a section body, the way a reader would by dragging. */
export async function selectText(page: Page, key: string, text: string) {
  await page.evaluate(
    ({ key, text }) => {
      const body = [...document.querySelectorAll<HTMLElement>(`[data-section-body="${key}"]`)].find(
        (el) => el.checkVisibility(),
      )!;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const at = node.data.indexOf(text);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
      throw new Error(`"${text}" not found in section ${key}`);
    },
    { key, text },
  );
}

/** The version view's section strip (one section is open at a time). */
export function sectionStrip(page: Page): Locator {
  return page.getByRole("navigation", { name: "Sections" }).filter({ visible: true });
}

/** Opens a section of the current Brief / Full mode from the strip, and waits for its panel. */
export async function openSection(page: Page, key: string): Promise<Locator> {
  await sectionStrip(page).locator(`a[data-strip-key="${key}"]`).click();
  const s = section(page, key);
  await expect(s).toBeVisible();
  return s;
}

/** The review panel's comments, feedback and resolutions for every section, not only the open one. */
export async function showAll(page: Page) {
  await page.getByTestId("inspector-scope").filter({ visible: true }).getByRole("button", { name: "All", exact: true }).click();
}

/** Picks an item from the open section's ⋯ menu. */
export async function sectionAction(scope: Locator, heading: string, item: string | RegExp) {
  await scope.getByRole("button", { name: `Actions for ${heading}` }).click();
  await scope.getByRole("menuitem", { name: item }).click();
}
