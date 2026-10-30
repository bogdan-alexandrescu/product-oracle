import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/**
 * fix4 shell, the Ask Oracle panel (desktop): a chat started on a page is titled by the page's
 * name, never its route (qa-shell-2); a viewer is told in the panel why there is no box
 * (qa-shell-3); Detailed lays the panel out as Simple does: New chat in the head, Recent chats,
 * the box at the bottom with Send beside it (qa-shell-12); a just-you-and-Oracle chat has no
 * Ask Oracle box to tick (qa-shell-14); Enter sends and the About line is words, not a link to
 * the page you are on (qa-shell-15).
 */
const panel = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The panel's layout as one reads it: what the head holds, and where the box and Send are. */
async function layout(p: Locator, textbox: Locator) {
  const [panelBox, field, send] = [await box(p), await box(textbox), await box(p.getByRole("button", { name: "Send" }))];
  return {
    newChat: await p.getByRole("button", { name: "New chat" }).isVisible(),
    recent: await p.getByRole("button", { name: /Recent chats/ }).isVisible(),
    // Send beside the box, on its row; the box at the panel's foot.
    sendBeside: send.x >= field.x + field.width - 1 && Math.abs(send.y + send.height / 2 - (field.y + field.height / 2)) <= 4,
    atBottom: panelBox.y + panelBox.height - (field.y + field.height) <= 40,
  };
}

test("qa-shell-2, qa-shell-15: Enter sends from Detailed Home, and the chat is titled Home, not its route", async ({ page }) => {
  await login(page);
  await page.getByTestId("hop-strip").click();
  const about = panel(page).getByTestId("hop-about");
  await expect(about).toHaveText("New chat about Home");
  // The page you are on is words, not a link back to it.
  await expect(panel(page).getByRole("link", { name: /Home/ })).toHaveCount(0);
  const ask = panel(page).getByRole("textbox", { name: "Ask Oracle" });
  await ask.fill("What should we cut first?");
  await ask.press("Enter");
  const thread = panel(page).getByTestId("discussion-thread");
  await expect(thread).toBeVisible();
  await expect(thread.getByRole("heading", { level: 3 }).first()).toHaveText("Home");
  await expect(panel(page)).not.toContainText("/home");
});

test("qa-shell-14: a just-you-and-Oracle chat has no Ask Oracle box to tick", async ({ page }) => {
  await login(page);
  await page.getByTestId("hop-strip").click();
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill("Why is checkout first?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  const thread = panel(page).getByTestId("discussion-thread");
  await expect(thread.getByTestId("oracle-reply").last()).toHaveAttribute("data-status", "complete");
  const composer = thread.getByTestId("discussion-composer");
  await expect(composer.getByTestId("oracle-rule")).toHaveText("Oracle will reply");
  await expect(composer.getByRole("checkbox", { name: "Ask Oracle" })).toHaveCount(0);
});

test("qa-shell-3: a viewer reads chats in the panel and is told why there is no box", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.getByTestId("hop-strip").click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("textbox", { name: "Ask Oracle" })).toHaveCount(0);
  await expect(panel(page).getByTestId("hop-cannot")).toHaveText("You can read chats here, but starting one needs comment access. Ask an owner for it.");
  await expect(panel(page)).not.toContainText("Ask why something is ranked");
});

test("qa-shell-12: the panel is laid out the same in Simple and Detailed", async ({ page }) => {
  await login(page);
  await page.getByTestId("hop-strip").click();
  const detailed = await layout(panel(page), panel(page).getByRole("textbox", { name: "Ask Oracle" }));
  // Recent chats opens the reader's chats over the panel, as Simple's does.
  await panel(page).getByRole("button", { name: /Recent chats/ }).click();
  await expect(panel(page).getByRole("region", { name: "Recent chats" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page).getByRole("region", { name: "Recent chats" })).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  await page.goto("/simple");
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  await expect(panel(page).getByTestId("ask-chat")).toBeVisible();
  const simple = await layout(panel(page), panel(page).getByRole("textbox", { name: "Message Oracle" }));

  expect(simple).toEqual({ newChat: true, recent: true, sendBeside: true, atBottom: true });
  expect(detailed).toEqual(simple);
});
