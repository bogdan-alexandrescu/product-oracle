import { expect, type Locator, type Page } from "@playwright/test";

import { MOCK_LOGIN } from "../lib/api/mock/fixtures";

export const ADMIN = MOCK_LOGIN;

export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
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
