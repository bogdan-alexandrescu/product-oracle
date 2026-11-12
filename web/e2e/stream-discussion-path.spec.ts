import { expect, test } from "./test";

/*
 * stream-discussion-path (lib/stream): when a reply is done, the shared reads of its own discussion are dropped,
 * by the discussion's path, so the next read of it fetches, whether the reply's stream URL was given relative
 * (/v1/discussions/<id>/messages/<id>/stream) or absolute (with its origin). Runs the modules in Node with a
 * stand-in window, transport and fetch; no page.
 *
 * fails_when = after a reply streamed from an absolute URL is done, a read of its discussion still takes the
 * answer shared before the reply.
 */

const ORIGIN = "http://app.example.com";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const settle = () => new Promise((ok) => setTimeout(ok, 0));
const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup() {
  (globalThis as { window?: unknown }).window ??= new EventTarget();
  const { sharedReads, forgetReads } = await import("../lib/api/shared-reads");
  const { openStream } = await import("../lib/stream");
  forgetReads();
  let calls = 0;
  const read = sharedReads(async () => {
    calls++;
    return json({ messages: calls });
  });
  // The reply's stream: done at once.
  globalThis.fetch = async () => new Response("event: done\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  return { read, openStream, calls: () => calls };
}

for (const [name, stream] of [
  ["relative", "/v1/discussions/example-d1/messages/example-m1/stream"],
  ["absolute", `${ORIGIN}/v1/discussions/example-d1/messages/example-m1/stream?from=0`],
] as const) {
  test(`a reply done on a ${name} stream URL drops its discussion's shared reads`, async () => {
    const { read, openStream, calls } = await setup();
    const discussion = `${ORIGIN}/v1/discussions/example-d1`;
    await (await read(new Request(discussion))).json();
    await settle();
    await read(new Request(discussion));
    expect(calls()).toBe(1);

    let done = false;
    await openStream(stream, { onDelta: () => undefined, onDone: () => (done = true), onError: () => undefined });
    expect(done).toBe(true);

    await read(new Request(discussion));
    expect(calls()).toBe(2);
  });
}
