import { contrast } from "./contrast-helpers";
import { expect, test } from "./test";

// Self-checks of the shared contrast helper: when it cannot read a contrast, it says why.

test("a missing element reports its own error, not two undefined colours", async ({ page }) => {
  await page.setContent(`<p data-testid="here" style="color: #111; background: #fff">Example text</p>`);
  expect(await contrast(page.getByTestId("here"))).toBeGreaterThan(15);

  const err = await contrast(page.getByTestId("not-here"), 1_500).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).not.toBeNull();
  expect(err!.message).not.toContain("undefined");
  expect(err!.message).toContain("not-here");
  expect(err!.cause).toBeInstanceOf(Error);
});

test("an infinite colour animation fails naming it, not with a mid-animation read", async ({ page }) => {
  await page.setContent(`
    <style>
      @keyframes example-glow { from { background-color: #fff } to { background-color: #ddd } }
      .glow { animation: example-glow 0.8s linear infinite alternate; }
    </style>
    <div class="glow"><p data-testid="glowing" style="color: #000">Example text</p></div>
  `);
  const err = await contrast(page.getByTestId("glowing"), 1_500).then(
    (r) => new Error(`read ${r} mid-animation`),
    (e: Error) => e,
  );
  expect(err.message).toContain(`"example-glow"`);
  expect(err.message).toContain("runs forever");
});
