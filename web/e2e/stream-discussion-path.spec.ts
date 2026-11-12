import { expect, test } from "./test";

/*
 * stream-discussion-path (lib/stream): when a reply is done, the shared reads of its own discussion are dropped,
 * by the discussion's path, so the next read of it fetches, whether the reply's stream URL was given relative
 * (/v1/discussions/<id>/messages/<id>/stream) or absolute (with its origin). Runs the modules in Node with a
 * stand-in window and transport; no page, and no stream opened (in the mock build the stream goes to the in-page
 * mock API, which a Node test has no page for); that openStream drops them is checked through the UI in
 * ask-reply-discussion-read.spec.ts.
 *
 * fails_when = the path taken from an absolute stream URL keeps its origin or query, so dropping the reads of it
 * leaves the answer shared before the reply in place.
 */

const ORIGIN = "http://app.example.com";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const settle = () => new Promise((ok) => setTimeout(ok, 0));

async function setup() {
  (globalThis as { window?: unknown }).window ??= new EventTarget();
  const { sharedReads, forgetReads, forgetReadsOf } = await import("../lib/api/shared-reads");
  const { discussionPath } = await import("../lib/stream");
  forgetReads();
  let calls = 0;
  const read = sharedReads(async () => {
    calls++;
    return json({ messages: calls });
  });
  return { read, forgetReadsOf, discussionPath, calls: () => calls };
}

for (const [name, stream] of [
  ["relative", "/v1/discussions/example-d1/messages/example-m1/stream"],
  ["absolute", `${ORIGIN}/v1/discussions/example-d1/messages/example-m1/stream?from=0`],
] as const) {
  test(`a reply done on ${name === "absolute" ? "an" : "a"} ${name} stream URL drops its discussion's shared reads`, async () => {
    const { read, forgetReadsOf, discussionPath, calls } = await setup();
    expect(discussionPath(stream)).toBe("/v1/discussions/example-d1");
    const discussion = `${ORIGIN}/v1/discussions/example-d1`;
    await (await read(new Request(discussion))).json();
    await settle();
    await read(new Request(discussion));
    expect(calls()).toBe(1);

    // What openStream does when the reply is done.
    forgetReadsOf(discussionPath(stream));

    await read(new Request(discussion));
    expect(calls()).toBe(2);
  });
}
