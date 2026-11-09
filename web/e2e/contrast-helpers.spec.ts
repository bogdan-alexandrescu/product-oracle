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

test("an endless colour animation is read at the keyframe it rests on, and keeps running", async ({ page }) => {
  await page.setContent(`
    <style>
      @keyframes example-glow { from { background-color: #fff } to { background-color: #333 } }
      .glow { animation: example-glow 0.8s linear infinite alternate; }
    </style>
    <div class="glow"><p data-testid="glowing" style="color: #000">Example text</p></div>
  `);
  // Mid-glow the background is grey; at rest (its first keyframe) it is white: black on white is 21.
  await page.waitForTimeout(300);
  expect(await contrast(page.getByTestId("glowing"), 1_500)).toBeCloseTo(21, 1);
  expect(await page.locator(".glow").evaluate((n) => n.getAnimations()[0].playState)).toBe("running");
});

test("an endless opacity pulse (a loading dot) is read at rest, not reported as running forever", async ({ page }) => {
  await page.setContent(`
    <style>
      @keyframes example-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.2 } }
      .dot { animation: example-pulse 1s ease-in-out -0.3s infinite; }
    </style>
    <p data-testid="loading" class="dot" style="color: #111; background: #fff">Loading example</p>
  `);
  expect(await contrast(page.getByTestId("loading"), 1_500)).toBeGreaterThan(15);
});

test("a locator that matches two elements fails at once, naming the strict mode violation", async ({ page }) => {
  await page.setContent(`
    <p data-testid="twice" style="color: #111; background: #fff">Example one</p>
    <p data-testid="twice" style="color: #111; background: #fff">Example two</p>
  `);
  const start = Date.now();
  const err = await contrast(page.getByTestId("twice"), 5_000).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).not.toBeNull();
  expect(err!.message).toContain("strict mode violation");
  expect(err!.cause).toBeInstanceOf(Error);
  expect(Date.now() - start).toBeLessThan(1_500);
});

test("a read that never succeeds gives up within its time limit, keeping its cause", async ({ page }) => {
  await page.setContent(`<p>Example text</p>`);
  for (const timeout of [300, 1_000, 1_500]) {
    const start = Date.now();
    const err = await contrast(page.getByTestId("not-here"), timeout).then(
      () => null,
      (e: Error) => e,
    );
    expect(Date.now() - start).toBeLessThan(timeout + 250);
    expect(err).not.toBeNull();
    expect(err!.message).toContain("not-here");
    expect(err!.message).not.toContain("undefined");
  }
});
