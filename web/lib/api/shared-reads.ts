/**
 * simple-call-budget: one shared read per URL for the whole tab, under every API call
 * (lib/api/client wraps its transport with it), so a page and the rail, or two parts of a
 * page, asking for the same thing share one call instead of each fetching it.
 *
 * - A GET still on its way is shared, however long it takes; its answer is shared for
 *   FRESH_MS after it lands, then the next read fetches again.
 * - A read marked stale-ok (`STALE_OK`: the rail's counts) takes an answer up to RAIL_MS old
 *   as it is, so moving between pages does not read the rail's lists again; older than that
 *   (up to STALE_MS), it takes the last answer at once and reads it again behind it.
 * - Any answer that differs from the one shared before it says so (`onReadChanged`), so what
 *   shows an older answer reads it again.
 * - Any write (a non-GET, or a GET that marks something seen) drops every shared answer, and
 *   an answer to a read begun before it is never shared, so after an action every read fetches.
 * - A failed answer is never shared: the next read tries again.
 */

export const STALE_OK = "x-po-stale-ok";

const FRESH_MS = 2000;
const RAIL_MS = 10_000;
const STALE_MS = 5 * 60_000;
const CHANGED = "po:read-changed";

type Entry = {
  /** When the shared answer landed; null while the first read is on its way. */
  at: number | null;
  /** The shared answer (never read itself: each caller gets a clone). */
  res: Promise<Response> | null;
  /** Its body, to tell a changed answer from the same one. */
  body: string | null;
  /** A read of it again on its way. */
  next: Promise<Response> | null;
};

const entries = new Map<string, Entry>();
// Bumped by every write: a read begun under an older one is never shared.
let generation = 0;

/** Drops every shared answer without telling anyone: the next read of each fetches. */
export function forgetReads() {
  generation += 1;
  entries.clear();
}

// A change said to the whole page (use-query's dataChanged, a chat card's sendCardChanged)
// drops them too, before the reads it starts.
if (typeof window !== "undefined") for (const e of ["po:data-changed", "simple:card-changed"]) window.addEventListener(e, forgetReads);

/** Calls `fn` with the URL's path and query whenever a read's answer differs from the one shared before it. */
export function onReadChanged(fn: (url: string) => void): () => void {
  const on = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(CHANGED, on);
  return () => window.removeEventListener(CHANGED, on);
}

function isWrite(req: Request): boolean {
  return req.method !== "GET" || new URL(req.url).searchParams.has("mark_seen");
}

/** The caller's copy of a shared answer, given up when the caller's own signal aborts. */
function copy(res: Promise<Response>, signal: AbortSignal | null): Promise<Response> {
  const mine = res.then((r) => r.clone());
  if (!signal) return mine;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    mine.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function sharedReads(base: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  if (typeof window === "undefined") return base;
  return (req: Request) => {
    const staleOk = req.headers.get(STALE_OK) === "1";
    if (staleOk) req.headers.delete(STALE_OK);
    if (isWrite(req)) {
      forgetReads();
      // An answer to a read begun while the write was on its way is not shared either.
      return base(req).finally(forgetReads);
    }
    const url = new URL(req.url);
    const key = `${url.pathname}${url.search}`;
    const now = Date.now();
    const hit = entries.get(key);
    const age = hit?.at == null ? null : now - hit.at;
    if (hit?.res && (hit.at === null || (age !== null && age < (staleOk ? RAIL_MS : FRESH_MS)))) return copy(hit.res, req.signal);
    // Read again: shared by every caller while it is on its way.
    const next = hit?.next ?? fetchShared(base, req, key);
    // The rail's counts show the last answer at once while it is read again behind them.
    if (staleOk && hit?.res && age !== null && age < STALE_MS) return copy(hit.res, req.signal);
    return copy(next, req.signal);
  };
}

function fetchShared(base: (req: Request) => Promise<Response>, req: Request, key: string): Promise<Response> {
  const gen = generation;
  // One caller aborting (the rail leaving a page) never aborts the read the others share.
  const res = base(new Request(req.url, { method: "GET", headers: req.headers, credentials: req.credentials }));
  const entry: Entry = entries.get(key) ?? { at: null, res: null, body: null, next: null };
  if (!entry.res) entry.res = res;
  entry.next = res;
  entries.set(key, entry);
  const done = (keep: boolean, body: string | null) => {
    if (gen !== generation || entries.get(key) !== entry) return;
    if (!keep) {
      entries.delete(key);
      return;
    }
    const changed = entry.body !== null && entry.body !== body;
    entry.res = res;
    entry.at = Date.now();
    entry.body = body;
    entry.next = null;
    if (changed) window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
  };
  res.then(
    (r) => {
      if (!r.ok) return done(false, null);
      r.clone()
        .text()
        .then((body) => done(true, body), () => done(false, null));
    },
    () => done(false, null),
  );
  return res;
}
