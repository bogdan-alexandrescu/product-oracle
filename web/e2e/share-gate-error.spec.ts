import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * QA V-9: on the passcode gate of a shared link (/s/<token>), a wrong passcode shows its
 * message as the app's other field errors look: the error colour, the alert icon, tied to
 * the field (aria-invalid, aria-describedby) and announced (role="alert"), in light and dark,
 * on a desktop and on a phone.
 */

const DOC = "/documents/example-labs-roadmap";

async function openGate(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Label").fill("Board, example meeting");
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  const holder = await page.context().newPage();
  await holder.goto(new URL(url).pathname);
  await expect(holder.getByRole("heading", { name: "Enter the passcode" })).toBeVisible();
  return { holder, code };
}

for (const size of [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
]) {
  for (const theme of ["light", "dark"]) {
    test(`a wrong passcode reads as a field error, ${size.name} wide, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const { holder, code } = await openGate(page);
      await holder.setViewportSize({ width: size.width, height: size.height });
      await holder.evaluate((t) => localStorage.setItem("oracle-theme", t), theme);
      await holder.reload();
      await expect(holder.locator("html")).toHaveAttribute("data-theme", theme);
      const field = holder.getByLabel("Passcode");
      await expect(field).not.toHaveAttribute("aria-invalid", "true");

      await field.fill("wrong-pass-code");
      await holder.getByRole("button", { name: "Open" }).click();
      const alert = holder.getByRole("alert").filter({ hasText: "That did not open the link." });
      await expect(alert).toBeVisible();

      // Tied to the field, and heard.
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const id = await alert.getAttribute("id");
      expect(id).toBeTruthy();
      await expect(field).toHaveAttribute("aria-describedby", id!);

      // The error icon, in the error colour (not the body's grey).
      await expect(alert.locator("svg")).toHaveCount(1);
      const colours = await alert.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--crit)";
        document.body.append(probe);
        const crit = getComputedStyle(probe).color;
        probe.remove();
        const body = document.createElement("span");
        body.style.color = "var(--text2)";
        document.body.append(body);
        const grey = getComputedStyle(body).color;
        body.remove();
        return { text: getComputedStyle(el).color, icon: getComputedStyle(el.querySelector("svg")!).color, crit, grey };
      });
      expect(colours.crit).not.toBe(colours.grey);
      expect(colours.text).toBe(colours.crit);
      expect(colours.icon).toBe(colours.crit);

      // No side scroll on the phone.
      expect(await holder.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // Typing again takes the mark off; the right passcode opens the link.
      await field.fill(code);
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
      await holder.getByRole("button", { name: "Open" }).click();
      await expect(holder.frameLocator('iframe[title="Shared roadmap"]').getByText(/^Shared with you/)).toBeVisible();
    });
  }
}
