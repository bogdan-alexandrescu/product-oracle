import { expect, test } from "./test";

/*
 * shared-reads-newer-read (lib/api/shared-reads): a shared read's first try that fails after a newer read
 * of the same URL began (one that must see what is there now, `cache: "no-store"`) is never the shared
 * answer: whoever waits on it, and whoever reads the URL next, gets the newer read's answer, or its failure.
 * Runs the module in Node with a stand-in window and transport; no page.
 *
 * fails_when = a read after the first try failed answers that failure (or fetches a third time) while the
 * newer read is still on its way, or the callers waiting on the first try get its failure, or a newer read's
 * failure when a read begun after it gives an answer.
 */

type Pending = { req: Request; answer: (res: Response) => void; fail: (err: Error) => void };

async function setup() {
  (globalThis as { window?: unknown }).window ??= new EventTarget();
  const { sharedReads, forgetReads } = await import("../lib/api/shared-reads");
  forgetReads();
  const calls: Pending[] = [];
  const read = sharedReads(
    (req) =>
      new Promise<Response>((answer, fail) => {
        calls.push({ req, answer, fail });
      }),
  );
  return { read, calls };
}

const URL_A = "http://app.example.com/v1/simple/decisions/waiting";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((ok) => setTimeout(ok, 0));

test("a first read that fails after a newer read began gives every waiting caller the newer answer", async () => {
  const { read, calls } = await setup();
  const first = read(new Request(URL_A));
  const newer = read(new Request(URL_A, { cache: "no-store" }));
  expect(calls).toHaveLength(2);

  calls[0]!.answer(json({ detail: "Example failure" }, 500));
  await settle();
  // Read while the newer read is on its way: it waits for that one, never the failed first try.
  const next = read(new Request(URL_A));
  expect(calls).toHaveLength(2);

  calls[1]!.answer(json({ count: 2 }));
  for (const res of [first, newer, next]) {
    const r = await res;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 2 });
  }
  expect(calls).toHaveLength(2);
});

test("a first read that fails after a newer read began gives the newer read's failure when it fails too", async () => {
  const { read, calls } = await setup();
  const first = read(new Request(URL_A));
  read(new Request(URL_A, { cache: "no-store" })).catch(() => undefined);
  calls[0]!.fail(new Error("first try lost"));
  await settle();
  const next = read(new Request(URL_A));
  expect(calls).toHaveLength(2);

  calls[1]!.fail(new Error("newer try lost"));
  await expect(first).rejects.toThrow("newer try lost");
  await expect(next).rejects.toThrow("newer try lost");
});

test("a first read that fails gives way to the newest read, even one begun after it failed", async () => {
  const { read, calls } = await setup();
  const first = read(new Request(URL_A));
  read(new Request(URL_A, { cache: "no-store" })).catch(() => undefined);
  calls[0]!.fail(new Error("first try lost"));
  await settle();
  // A third read begins after the first failed, while the second is still on its way.
  const newest = read(new Request(URL_A, { cache: "no-store" }));
  expect(calls).toHaveLength(3);

  calls[1]!.fail(new Error("second try lost"));
  calls[2]!.answer(json({ count: 3 }));
  for (const res of [first, newest]) {
    const r = await res;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 3 });
  }
});
