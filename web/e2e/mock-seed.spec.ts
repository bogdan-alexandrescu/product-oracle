import { expect, test } from "@playwright/test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, seedRoadmapReview } from "./helpers";

/*
 * The e2e seeds (helpers.ts) write the mock's data in the page. The app's own calls each read
 * that data, answer, then save it: a seed written while one of them is in flight was lost when
 * it saved (openSeeded used to seed up to three times for it). A seed now takes its turn with
 * the app's calls, so it is never written over.
 */

type Held = { __poMockFetch?: (r: Request) => Promise<Response>; __release?: () => void; __held?: Promise<number> };

// Card seed-turn: protects = a seed written while the app's own write is in flight is kept,
// so openSeeded seeds once; fails_when = the in-flight write saves over the seed (the run
// page then says "run … not found"); no_claim = the real API (no seeds there).
test("a seed written while the app's own write is in flight is kept", async ({ page }) => {
  await login(page);
  // The app's write, held open: a PATCH whose body is still arriving, so the mock has read
  // its data and not saved it yet.
  await page.evaluate(async () => {
    const w = globalThis as unknown as Held;
    let reading!: () => void;
    const read = new Promise<void>((r) => (reading = r));
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          w.__release = () => {
            c.enqueue(new TextEncoder().encode("{}"));
            c.close();
          };
        },
        pull: () => reading(),
      },
      { highWaterMark: 0 },
    );
    const req = new Request(new URL("/v1/me/preferences", location.origin), {
      method: "PATCH",
      body,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    w.__held = w.__poMockFetch!(req).then((r) => r.status);
    await read;
  });

  const seeding = seedRoadmapReview(page);
  await page.evaluate(() => (globalThis as unknown as Held).__release!());
  await seeding;
  expect(await page.evaluate(() => (globalThis as unknown as Held).__held)).toBe(200);

  await page.goto(`/runs/${ROADMAP_REVIEW_RUN.run.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  await expect(page.getByText(/^run [0-9a-f-]+ not found$/)).toHaveCount(0);
});
