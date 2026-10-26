import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * #589 review: a piece of evidence opens its source only when its ref is an http(s) URL.
 * protects = an upload's evidence, whose ref is its file name, has no "Open source" link in
 * its card, while a web source's evidence still links to it;
 * fails_when = the card puts any ref in an href (a file name, or a javascript: ref);
 * no_claim = citations in documents (citationHref, their own specs).
 */

test("an evidence card links only an http(s) source; an upload's file name is no link", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await page.getByTestId("priority-row-F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const ex = page.getByTestId("explanation-F-1");
  const card = page.getByTestId("code-card");

  const upload = ex.getByTestId("evidence-chip").filter({ hasText: "Interview 11" });
  await upload.click();
  await expect(card).toContainText("Interview 11");
  await expect(card).toContainText("ev-6");
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  const linked = ex.getByTestId("evidence-chip").filter({ hasText: "Interview 07" });
  await linked.click();
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveAttribute(
    "href",
    "https://example.com/research/interview-07",
  );
});
