/**
 * A server-sent event stream read with `fetch` (G2 Live replies): Oracle's reply as it is
 * written. Not `EventSource`, which cannot carry the session cookie through the `/v1/*`
 * proxy reliably or be aborted cleanly. A dropped connection is reopened once: the server
 * tails or finishes the reply, so nothing is lost (it sends the text again from the start of
 * what it has, so the reader resets the text on reconnect).
 */
import { MOCK_MODE } from "@/lib/api/client";
import { mockFetch } from "@/lib/api/mock/server";

export type StreamError = {
  reason: string;
  /** What to show the reader; absent when the server gave none. */
  message?: string | null;
  retry: boolean;
};

export type StreamHandlers = {
  onDelta: (text: string) => void;
  onCitations?: (citations: Record<string, unknown>[]) => void;
  /** G3: the changes the reply proposed (ChangeOut[]), just before `done`. */
  onChanges?: (changes: unknown[]) => void;
  onDone: (message: unknown) => void;
  onError: (error: StreamError) => void;
  /** The connection dropped and is being reopened: forget the text so far. */
  onReset?: () => void;
  signal?: AbortSignal;
};

/** Each complete event in `buffer`, and what is left of it. */
export function parseEvents(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const events: { event: string; data: string }[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

export async function openStream(url: string, h: StreamHandlers): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) h.onReset?.();
    let ended = false;
    try {
      // Same-origin by default, so the session cookie goes with it.
      const init: RequestInit = {
        headers: { accept: "text/event-stream" },
        signal: h.signal,
        cache: "no-store",
      };
      // Mock mode: the in-browser API answers, as for every other call.
      const res = MOCK_MODE ? await mockFetch(new Request(new URL(url, window.location.origin), init)) : await fetch(url, init);
      if (!res.ok || !res.body) {
        h.onError({
          reason: res.status === 403 || res.status === 404 ? "forbidden" : "failed",
          retry: true,
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseEvents(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          const data = JSON.parse(e.data);
          if (e.event === "delta") h.onDelta(String(data.text ?? ""));
          else if (e.event === "citations") h.onCitations?.(data);
          else if (e.event === "changes") h.onChanges?.(data);
          else if (e.event === "done") {
            ended = true;
            h.onDone(data);
          } else if (e.event === "error") {
            ended = true;
            h.onError(data as StreamError);
          }
        }
      }
      if (ended) return;
    } catch (err) {
      if (h.signal?.aborted) return;
      if (attempt > 0) throw err;
    }
  }
  h.onError({ reason: "interrupted", retry: true });
}
