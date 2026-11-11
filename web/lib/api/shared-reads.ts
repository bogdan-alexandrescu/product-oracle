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
 * - A failed answer is never shared: the next read tries again. A read again of an answer shared
 *   before that fails says so (`onReadFailed`), so what shows the older answer reads it again
 *   itself and shows that it failed, never the last answer.
 * - Answers older than STALE_MS are dropped, at most MAX_ENTRIES are kept (the oldest go first),
 *   and only text and JSON answers are kept (never a file such as a PDF).
 */

export const STALE_OK = "x-po-stale-ok";

const FRESH_MS = 2000;
const RAIL_MS = 10_000;
const STALE_MS = 5 * 60_000;
const MAX_ENTRIES = 200;
const CHANGED = "po:read-changed";
const FAILED = "po:read-failed";
// The request headers that change an answer, besides the URL (any x- header too, but the stale-ok mark).
const KEY_HEADERS = ["accept", "accept-language", "authorization"];

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

/** Calls `fn` with the URL's path and query whenever a read again of an answer shared before it fails. */
export function onReadFailed(fn: (url: string) => void): () => void {
  const on = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(FAILED, on);
  return () => window.removeEventListener(FAILED, on);
}

/** The URL's path and query, and the request headers that change its answer. */
export function readKey(req: Request): string {
  const url = new URL(req.url);
  const headers = [...req.headers]
    .filter(([name]) => name !== STALE_OK && (KEY_HEADERS.includes(name) || name.startsWith("x-")))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `\n${name}: ${value}`);
  return `${url.pathname}${url.search}${headers.join("")}`;
}

/** Drops the answers older than STALE_MS (no read takes them), keeping any read again on its way. */
function dropOld(now: number) {
  for (const [key, e] of entries) if (e.at !== null && now - e.at >= STALE_MS && !e.next) entries.delete(key);
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
    const key = readKey(req);
    const now = Date.now();
    dropOld(now);
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
  // The URL as listeners know it (onReadChanged, onReadFailed): the key without its headers.
  const url = key.split("\n")[0]!;
  const drop = () => {
    if (gen === generation && entries.get(key) === entry) entries.delete(key);
  };
  const failed = () => {
    drop();
    // An answer was shared before: whatever shows it reads it again and shows that it failed.
    if (entry.at !== null) window.dispatchEvent(new CustomEvent(FAILED, { detail: url }));
  };
  const done = (body: string) => {
    if (gen !== generation || entries.get(key) !== entry) return;
    const changed = entry.body !== null && entry.body !== body;
    entry.res = res;
    entry.at = Date.now();
    entry.body = body;
    entry.next = null;
    // The newest answer goes last, so the oldest go first past MAX_ENTRIES.
    entries.delete(key);
    entries.set(key, entry);
    for (const old of entries.keys()) {
      if (entries.size <= MAX_ENTRIES) break;
      entries.delete(old);
    }
    if (changed) window.dispatchEvent(new CustomEvent(CHANGED, { detail: url }));
  };
  res.then(
    (r) => {
      if (!r.ok) return failed();
      // A file (a PDF, an image, a download) is never kept: only text and JSON answers are.
      const type = r.headers.get("content-type") ?? "";
      if ((type && !/json|^text\//i.test(type)) || /attachment/i.test(r.headers.get("content-disposition") ?? "")) return drop();
      r.clone().text().then(done, failed);
    },
    failed,
  );
  return res;
}
