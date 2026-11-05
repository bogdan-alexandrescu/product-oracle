"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import type { Schemas } from "@/lib/api/client";
import { pageNameOnly } from "@/lib/page-context";

/**
 * What is on screen, for the head-of-product panel (G7, 3.3): a discussion subject and its
 * label. A page that says nothing is `{kind: "screen", subject: {path}}`, labelled by its page.
 */
export type ScreenSubject = {
  kind: Schemas["DiscussionCreate"]["subject_kind"];
  subject: Record<string, unknown>;
  label: string;
  /** ask-page-context: what "This page" sends of what the page shows (subjectWithView). */
  view?: PageView | "shown";
};

/**
 * ask-page-context: what the open page shows, sent with a "This page" chat's subject (the API
 * reads it in that private chat only): the page's name, the filters in use and its main
 * content as lines. A page with a provider of its own says it (usePageView, lib/page-context.ts);
 * any other page sends its main region's shown text (`"shown"`, read as the chat starts).
 */
export type PageView = { name?: string; filters?: string[]; lines: string[] };

/** The API's limits (oracle.discussions.service.PageView). */
const VIEW_LINES = 300;
const VIEW_LINE_CHARS = 1000;
const VIEW_CHARS = 16_000;


const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** The view within the API's limits. */
function bounded(v: PageView): PageView {
  const lines: string[] = [];
  let size = 0;
  for (const raw of v.lines) {
    const line = clip(raw.replace(/\s+/g, " ").trim(), VIEW_LINE_CHARS);
    if (!line) continue;
    if (lines.length >= VIEW_LINES || size + line.length > VIEW_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return {
    ...(v.name ? { name: clip(v.name, 200) } : {}),
    ...(v.filters?.length ? { filters: v.filters.slice(0, 20).map((f) => clip(f, 200)) } : {}),
    lines,
  };
}

const shownText = (el: HTMLElement) => el.innerText.replace(/\s+/g, " ").trim();
const isShown = (el: Element) => el.getClientRects().length > 0;

/**
 * A table's rows, one line each, with their columns' names ("Document: Checkout · Status:
 * Draft"): the same whatever the layout (on a phone the header is for screen readers only and
 * each row wraps its cells onto lines of their own).
 */
function tableLines(table: HTMLTableElement): string[] {
  const head = table.tHead?.rows[0];
  // As shown: a phone's header is for screen readers only, but still drawn (a 1 px box).
  const names = head ? Array.from(head.cells, shownText) : [];
  const out: string[] = [];
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      if (!isShown(row) || row.getAttribute("aria-hidden") === "true") continue;
      const cells = Array.from(row.cells).map((cell, i) => {
        if (!isShown(cell)) return "";
        const name = row.cells.length === names.length ? names[i] : "";
        // A phone shows a cell's own label before its value: the column's name says it once.
        const shown = shownText(cell);
        const rest = name && shown.startsWith(name) ? shown.slice(name.length) : "";
        const text = /^[\s\dA-Z]/.test(rest) ? rest.trim() : shown;
        return text && name ? `${name}: ${text}` : text;
      });
      const line = cells.filter(Boolean).join(" · ");
      if (line) out.push(line);
    }
  }
  return out;
}

/** An element's shown text as lines, a table's rows as tableLines. */
function shownLines(el: HTMLElement, out: string[]) {
  if (!isShown(el)) return;
  if (el instanceof HTMLTableElement) {
    out.push(...tableLines(el));
    return;
  }
  if (!el.querySelector("table")) {
    out.push(...el.innerText.split("\n"));
    return;
  }
  for (const node of Array.from(el.childNodes)) {
    if (node instanceof HTMLElement) shownLines(node, out);
    else if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent ?? "");
  }
}

/**
 * The shown page's main content, as text: the app's one <main>, whose hidden routes (Next keeps
 * recent ones mounted, `hidden`) have no shown text. The panel and its sheet are outside it.
 */
export function readShownPage(name: string): PageView {
  const main = typeof document === "undefined" ? null : document.querySelector("main");
  const raw: string[] = [];
  if (main instanceof HTMLElement) shownLines(main, raw);
  const lines = raw.map((l) => l.trim()).filter((l, i, all) => l && l !== all[i - 1]);
  return bounded({ name, lines });
}

/** The subject a "This page" chat starts on: with what the page shows (ask-page-context). */
export function subjectWithView(s: ScreenSubject): Record<string, unknown> {
  if (!s.view) return s.subject;
  return { ...s.subject, view: s.view === "shown" ? readShownPage(s.label) : bounded({ ...s.view, name: s.view.name ?? s.label }) };
}

/** The panel's General chat (G7 3.1). */
export const GENERAL: ScreenSubject = { kind: "screen", subject: { path: "/" }, label: "General" };

/** By first path segment, as the API names them (oracle.discussions.context.page_name). */
const PAGES: Record<string, string> = {
  home: "Home",
  requests: "Requests",
  baseline: "Baseline",
  documents: "PRDs",
  priorities: "Priorities",
  plan: "Plan",
  roadmap: "Plan",
  runs: "Runs",
  inbox: "Inbox",
  company: "Company",
  sources: "Sources",
  settings: "Settings",
};

/** Simple's pages by their segment after /simple (oracle.discussions.context.SIMPLE_PAGES). */
const SIMPLE_PAGES: Record<string, string> = {
  "": "Home",
  roadmap: "Roadmap",
  priorities: "Priorities",
  decisions: "Decisions",
  meetings: "Meetings",
  prds: "One-pager",
  "one-pagers": "One-pager",
};

/** "Settings · Members" for /settings/members, "General" for /, "Home" for /simple. */
export function pageName(path: string): string {
  const parts = path.split("?")[0].split("/").filter(Boolean);
  if (parts.length === 0) return "General";
  if (parts[0] === "simple") {
    const name = SIMPLE_PAGES[parts[1] ?? ""];
    if (name === "One-pager" && !parts[2]) return "One-pagers";
    if (name) return name;
  }
  const name = PAGES[parts[0]];
  if (!name) return path;
  if ((parts[0] === "settings" || parts[0] === "company") && parts[1]) {
    const tab = parts[1].replace(/-/g, " ");
    return `${name} · ${tab[0].toUpperCase()}${tab.slice(1)}`;
  }
  return name;
}

/** A discussion subject's lookup key (oracle.discussions.service.subject_key). */
export function subjectKey(s: ScreenSubject): string | null {
  const v = s.subject as Record<string, string | undefined>;
  switch (s.kind) {
    case "screen":
      return `screen:${v.path}`;
    case "document":
      return `document:${v.document_id}`;
    case "section":
      return `section:${v.document_id}:${v.section_key}`;
    case "entity":
      return `entity:${v.entity_id}`;
    case "track":
      return `track:${v.track_id}`;
    case "priorities":
      return "priorities";
    default:
      return null; // a checkpoint's key needs its kind; the panel lists by run instead
  }
}

type Held<T> = { path: string; value: T } | null;
type Shown = { set: Held<ScreenSubject>; view: Held<PageView>; name: Held<string> };
type Slot = keyof Shown;
const NOTHING: Shown = { set: null, view: null, name: null };

/**
 * What the open page says it shows, held outside React's state: the shell's provider never
 * changes its context, so a page saying it while it still streams (every page names itself as
 * it mounts) never re-renders the shell above the parts still on their way. A context change
 * there makes React drop those parts' server HTML and draw them afresh, leaving the streamed
 * copy (a hidden second rail, user menu and page) in the document. Only the panel reads it.
 */
function shownStore() {
  let now = NOTHING;
  const heard = new Set<() => void>();
  return {
    get: () => now,
    subscribe(hear: () => void) {
      heard.add(hear);
      return () => heard.delete(hear);
    },
    put<K extends Slot>(slot: K, next: (held: Shown[K]) => Shown[K]) {
      const value = next(now[slot]);
      if (value === now[slot]) return;
      now = { ...now, [slot]: value };
      heard.forEach((hear) => hear());
    },
  };
}
type ShownStore = ReturnType<typeof shownStore>;
const Ctx = createContext<ShownStore | null>(null);

export function ScreenSubjectProvider({ children }: { children: ReactNode }) {
  const [store] = useState(shownStore);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** Holds a value for the open path while the calling page is mounted (a hidden route never clears the next page's). */
function useHeld<K extends Slot>(slot: K, value: NonNullable<Shown[K]>["value"] | null) {
  const store = useContext(Ctx);
  const pathname = usePathname();
  const key = value == null ? null : JSON.stringify(value);
  useEffect(() => {
    if (!store || key == null) return;
    const mine = { path: pathname, value: JSON.parse(key) } as Shown[K];
    store.put(slot, () => mine);
    return () => store.put(slot, (now) => (now === mine ? null : now));
  }, [store, slot, key, pathname]);
}

/**
 * ask-page-context: a page says what it shows, for "This page" (its items, the filters in use),
 * when its main region's text would say less (lib/page-context.ts lists every route's provider).
 */
export function usePageView(view: PageView | null) {
  useHeld("view", view);
}

/** The shell's name for the open page, from its heading ("Dates · Plan"): what "This page" is titled. */
export function useShownPageName(name: string | null) {
  useHeld("name", name || null);
}

/**
 * A page says what it shows (G7 3.3): `subject` null keeps the page's own `screen` subject.
 * Cleared when the page goes.
 */
export function useScreenSubject(subject: Pick<ScreenSubject, "kind" | "subject"> | null, label: string | null | undefined) {
  // Only this page's own subject is cleared: a hidden route (Next keeps recent ones mounted) never clears the next page's.
  useHeld("set", subject && label ? { kind: subject.kind, subject: subject.subject, label } : null);
}

/**
 * A Detailed page's own name for "This page" (ask-page-context): the shell's, read from its
 * heading, where the path alone names only its section ("Runs" for a run's review); Simple's
 * pages and a section's own page keep their names (pageName).
 */
function screenLabel(path: string, shown: string | null): string {
  const name = pageName(path);
  const parts = path.split("?")[0].split("/").filter(Boolean);
  if (!shown || parts[0] === "simple" || parts.length < 2 || name.includes(" · ")) return name;
  return shown;
}

const noStore = () => () => {};
const nothing = () => NOTHING;

/** What is on screen now: the page's subject, else its `screen` subject; with what the page shows. */
export function useCurrentScreenSubject(): ScreenSubject {
  const store = useContext(Ctx);
  const ctx = useSyncExternalStore(store?.subscribe ?? noStore, store?.get ?? nothing, nothing);
  const pathname = usePathname();
  const held = ctx.view && ctx.view.path === pathname ? ctx.view.value : null;
  const shown = ctx.name && ctx.name.path === pathname ? ctx.name.value : null;
  const own = ctx.set && ctx.set.path === pathname ? ctx.set.value : null;
  // One object while nothing changes: callers keep it in their hooks' dependencies.
  return useMemo(() => {
    const view: ScreenSubject["view"] = held ?? (pageNameOnly(pathname) ? undefined : "shown");
    const base: ScreenSubject = own ?? { kind: "screen", subject: { path: pathname }, label: screenLabel(pathname, shown) };
    return view ? { ...base, view } : base;
  }, [own, held, shown, pathname]);
}
