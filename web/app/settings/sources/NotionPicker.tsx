"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, Icon } from "@/components/ds";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { errorMessage, useAuthRedirect } from "@/lib/use-query";

import { INPUT } from "../_components/fields";
import { pickedLabels, sameLabels } from "./_browse-list";

export type NotionPage = Schemas["NotionPageOut"];

// Pages fetched on open before "Load more" (100 each).
const AUTO_PAGES = 3;
const SHARE_HELP = "https://www.notion.com/help/add-and-manage-connections-with-the-api";

/** A page or database id from a dashed or undashed id, or a Notion URL (as the connector reads it). */
export function notionId(value: string): string | null {
  const last = value.trim().split("?")[0].split("#")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const match = /([0-9a-f]{32})$/i.exec(last.replaceAll("-", ""));
  if (!match) return null;
  const h = match[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The ids of a Notion source's roots. */
export function notionRoots(config: Record<string, unknown>): string[] {
  const ids = Array.isArray(config.roots) ? (config.roots as unknown[]).map(String) : [];
  return [...new Set(ids.map((v) => notionId(v) ?? v))];
}

// Where Notion serves page icons from: its own sites and its file CDN.
const ICON_HOSTS = ["notion.so", "notion.site", "notion-static.com"];
const ICON_EXACT_HOSTS = ["prod-files-secure.s3.us-west-2.amazonaws.com"];

/** A page icon's URL if it is safe to load: https, on a Notion host. Anything else (a tracking
 * pixel, plain http) gets the default glyph instead. */
export function notionIconUrl(icon: string | null | undefined): string | null {
  if (!icon || !/^https:\/\//i.test(icon)) return null;
  let host: string;
  try {
    const url = new URL(icon);
    if (url.username || url.password) return null;
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  const ok = ICON_EXACT_HOSTS.includes(host) || ICON_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? icon : null;
}

/** An emoji icon (not a URL of any kind). */
function isEmoji(icon: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(icon) && icon.length <= 16;
}

/** The parent this picker can place: a page or database it has seen. */
function parentOf(p: NotionPage, known: Map<string, NotionPage>): NotionPage | undefined {
  return p.parent_id && (p.parent_type === "page" || p.parent_type === "database") ? known.get(p.parent_id) : undefined;
}

/** The nearest picked ancestor of `id`, if any. */
function pickedAncestor(id: string, known: Map<string, NotionPage>, picked: Set<string>): NotionPage | undefined {
  const seen = new Set<string>();
  let p = known.get(id);
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    const parent = parentOf(p, known);
    if (parent && picked.has(parent.id)) return parent;
    p = parent;
  }
  return undefined;
}

function PageIcon({ page }: { page: NotionPage }) {
  const box = "grid size-6 flex-none place-items-center rounded-md";
  const src = notionIconUrl(page.icon);
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" referrerPolicy="no-referrer" className={`${box} object-cover`} />;
  }
  if (page.icon && isEmoji(page.icon))
    return <span aria-hidden className={`${box} text-[16px] leading-none`}>{page.icon}</span>;
  return (
    <span aria-hidden className={`${box} bg-surface2 text-text2`}>
      <Icon name={page.type === "database" ? "priorities" : "doc"} size={16} />
    </span>
  );
}

function useNotionPages(connectionId: string, search: string) {
  const onAuth = useAuthRedirect();
  const [items, setItems] = useState<NotionPage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped by every fetch, so an answer to an older search is dropped.
  const loads = useRef(0);
  // Everything seen so far, across searches: parents, ancestry and the titles of picks.
  const [known, setKnown] = useState<Map<string, NotionPage>>(new Map());

  function remember(pages: NotionPage[]) {
    setKnown((prev) => {
      const next = new Map(prev);
      for (const p of pages) next.set(p.id, p);
      return next;
    });
  }

  async function fetchPage(from: string | null) {
    return unwrap(
      api.GET("/v1/connections/{connection_id}/notion/pages", {
        params: { path: { connection_id: connectionId }, query: { search, ...(from ? { cursor: from } : {}) } },
      }),
    );
  }

  // A fresh list per connection and search: the first pages at once, so the tree has its parents.
  useEffect(() => {
    const generation = ++loads.current;
    const live = () => generation === loads.current;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        let all: NotionPage[] = [];
        let next: string | null = null;
        try {
          for (let n = 0; n < AUTO_PAGES; n++) {
            const page: Schemas["NotionPagesOut"] = await fetchPage(next);
            if (!live()) return;
            all = [...all, ...page.items];
            next = page.next_cursor;
            remember(page.items);
            setItems(all);
            setCursor(next);
            if (!next) break;
          }
        } catch (e) {
          if (!live()) return;
          // A failed fresh list leaves nothing to page through: Retry runs it again.
          setItems([]);
          setCursor(null);
          if (!onAuth(e)) setError(errorMessage(e));
        } finally {
          if (live()) setLoading(false);
        }
      },
      search ? 300 : 0,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, search, attempt]);

  // "Load more": the next page after the cursor, unless the search changed meanwhile.
  async function loadMore() {
    if (!cursor) return;
    const generation = ++loads.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(cursor);
      if (generation !== loads.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
      remember(page.items);
    } catch (e) {
      if (generation === loads.current && !onAuth(e)) setError(errorMessage(e));
    } finally {
      if (generation === loads.current) setLoading(false);
    }
  }

  return {
    items,
    known,
    cursor,
    loading,
    error,
    retry: () => (items.length && cursor ? void loadMore() : setAttempt((n) => n + 1)),
    loadMore: () => void loadMore(),
  };
}

/**
 * Choose pages: the pages and databases the person shared with Product Oracle in Notion,
 * as a tree by parent, to tick roots. A ticked page brings its sub-pages and databases, so
 * those show as included and cannot be ticked on their own. `labels` are the picks' saved
 * titles; `onLabels` gets the picks' titles whenever the picks change or a loaded page
 * titles a pick that had none.
 */
export function NotionPicker({
  connectionId,
  value,
  onChange,
  labels = {},
  onLabels,
}: {
  connectionId: string;
  value: string[];
  onChange: (roots: string[]) => void;
  labels?: Record<string, string>;
  onLabels?: (labels: Record<string, string>) => void;
}) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const list = useNotionPages(connectionId, search.trim());

  const known = list.known;

  const picked = useMemo(() => new Set(value), [value]);

  const labelsRef = useRef({ labels, onLabels });
  useEffect(() => {
    labelsRef.current = { labels, onLabels };
  });
  useEffect(() => {
    const { labels: saved, onLabels: report } = labelsRef.current;
    if (!report) return;
    const next = pickedLabels(value, (id) => known.get(id)?.title, saved);
    if (!sameLabels(next, saved)) report(next);
    // Reports only a change, so a new array of the same picks settles at once.
  }, [value, known]);

  const tree = useMemo(() => {
    const ids = new Set(list.items.map((p) => p.id));
    const children = new Map<string, NotionPage[]>();
    const top: NotionPage[] = [];
    for (const p of list.items) {
      const parent = p.parent_id && ids.has(p.parent_id) ? p.parent_id : null;
      if (parent && (p.parent_type === "page" || p.parent_type === "database")) {
        children.set(parent, [...(children.get(parent) ?? []), p]);
      } else top.push(p);
    }
    // Shared at the top of the workspace first, then pages whose parent was not shared.
    top.sort((a, b) => Number(b.parent_type === "workspace") - Number(a.parent_type === "workspace"));
    const counts = new Map<string, number>();
    const count = (id: string, seen: Set<string>): number => {
      if (counts.has(id)) return counts.get(id)!;
      seen.add(id);
      const n = (children.get(id) ?? []).reduce((sum, c) => sum + (seen.has(c.id) ? 0 : 1 + count(c.id, seen)), 0);
      counts.set(id, n);
      return n;
    };
    for (const p of list.items) count(p.id, new Set());
    return { top, children, counts };
  }, [list.items]);

  function toggle(page: NotionPage) {
    if (picked.has(page.id)) return onChange(value.filter((id) => id !== page.id));
    // Picking a parent covers its children: drop the picks it now includes.
    onChange([...value.filter((id) => !isUnder(id, page.id)), page.id]);
  }

  function isUnder(id: string, ancestor: string): boolean {
    const seen = new Set<string>();
    let p = known.get(id);
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      const parent = parentOf(p, known);
      if (parent?.id === ancestor) return true;
      p = parent;
    }
    return false;
  }

  function addLink() {
    const id = notionId(link);
    if (!id) return setLinkError("Not a Notion page link or id");
    setLinkError(null);
    setLink("");
    if (!picked.has(id)) onChange([...value, id]);
  }

  function row(page: NotionPage, depth: number, inheritedFrom?: NotionPage) {
    const kids = search ? [] : (tree.children.get(page.id) ?? []);
    const count = tree.counts.get(page.id) ?? 0;
    const included = inheritedFrom ?? pickedAncestor(page.id, known, picked);
    const checked = picked.has(page.id) || !!included;
    const expanded = open.has(page.id);
    const parent = search ? parentOf(page, known) : undefined;
    const boxId = `${searchId}-${page.id}`;
    return (
      <li key={page.id} role="treeitem" aria-expanded={kids.length ? expanded : undefined} aria-selected={checked} aria-label={page.title}>
        <div
          className="flex min-h-11 items-center gap-2 border-t border-line pr-3 hover:bg-surface2 max-[600px]:gap-1.5"
          style={{ paddingLeft: 6 + depth * 18 }}
          data-testid="notion-page"
        >
          {kids.length ? (
            <button
              type="button"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${page.title}`}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (expanded) next.delete(page.id);
                  else next.add(page.id);
                  return next;
                })
              }
              className="grid size-7 flex-none place-items-center rounded-md text-text2 hover:bg-surface hover:text-text"
            >
              <Icon name="chevron-right" size={16} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
            </button>
          ) : (
            <span aria-hidden className="size-7 flex-none" />
          )}
          <input
            id={boxId}
            type="checkbox"
            checked={checked}
            disabled={!!included}
            onChange={() => toggle(page)}
            className="size-[18px] flex-none accent-[var(--accent)] disabled:opacity-60"
          />
          <PageIcon page={page} />
          <div className="flex min-w-0 flex-1 flex-col py-1.5">
            <label
              htmlFor={boxId}
              className={`truncate text-[15px] leading-[22px] font-medium ${included ? "text-text2" : "text-text"}`}
              title={page.title}
            >
              {page.title}
            </label>
            {(parent || page.type === "database" || count > 0 || included) && (
              <span className="tnum flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] leading-[18px] text-text2">
                {parent && <span className="min-w-0 truncate">in {parent.title}</span>}
                {page.type === "database" && <span>Database</span>}
                {count > 0 && (
                  <span title={`${count} shared sub-page(s) known`}>
                    {count} sub-page{count === 1 ? "" : "s"}
                  </span>
                )}
                {included && (
                  <span className="inline-flex items-center gap-1 font-semibold text-accent-ink" title={`Included with ${included.title}`}>
                    <Icon name="check" size={16} />
                    Included
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        {kids.length > 0 && expanded && (
          <ul role="group" className="flex flex-col">
            {kids.map((k) => row(k, depth + 1, included ?? (picked.has(page.id) ? page : undefined)))}
          </ul>
        )}
      </li>
    );
  }

  const shown = search ? list.items : tree.top;

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-panel border border-line bg-surface" data-testid="notion-picker">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <Icon name="search" size={16} className="flex-none text-text2" />
          <label htmlFor={searchId} className="sr-only">
            Search Notion pages
          </label>
          <input
            id={searchId}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search pages"
            className={`${INPUT} h-8`}
          />
        </span>
        <span className="tnum flex-none text-[13px] font-semibold text-accent-ink" aria-live="polite" data-testid="notion-picked-count">
          {value.length} picked
        </span>
      </div>

      <div className="max-h-[340px] overflow-y-auto" aria-busy={list.loading}>
        {list.error && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <p role="alert" className="min-w-0 flex-1 rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit">
              {list.error}
            </p>
            <Button onClick={list.retry}>Retry</Button>
          </div>
        )}
        {!list.error && list.loading && !list.items.length && (
          <div className="flex flex-col">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-11 items-center border-t border-line px-3 first:border-t-0">
                <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />
              </div>
            ))}
          </div>
        )}
        {!list.loading && !list.error && !shown.length && (
          <p className="px-3 py-6 text-center text-[15px] text-text2">{search ? "No shared page matches" : "Nothing shared yet"}</p>
        )}
        {shown.length > 0 && (
          <ul role="tree" aria-label="Shared Notion pages" aria-multiselectable className="-mt-px flex flex-col">
            {shown.map((p) => row(p, 0))}
          </ul>
        )}
        {list.cursor && !list.error && (
          <div className="border-t border-line px-3 py-2">
            <Button variant="ghost" disabled={list.loading} onClick={list.loadMore}>
              {list.loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2.5" aria-label="Picked pages" role="list">
          {value.map((id) => {
            const p = known.get(id);
            const title = p?.title ?? labels[id] ?? `Page ${id.slice(0, 8)}…`;
            return (
              <span role="listitem" key={id} className="inline-flex h-[30px] max-w-full items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-[13px] font-semibold text-accent-ink">
                <span className="min-w-0 truncate" title={p || labels[id] ? title : id}>
                  {title}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${title}`}
                  onClick={() => onChange(value.filter((x) => x !== id))}
                  className="grid size-6 flex-none place-items-center rounded-full hover:bg-surface"
                >
                  <Icon name="x" size={16} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1.5 border-t border-line bg-surface2 px-3 py-2.5">
        <label htmlFor={`${searchId}-link`} className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
          Paste a link
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`${searchId}-link`}
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Inside the add-source form: Enter adds the link, it does not submit the form.
              e.preventDefault();
              addLink();
            }}
            placeholder="Page link or id"
            className={`${INPUT} h-8 flex-1`}
          />
          <Button onClick={() => addLink()} disabled={!link.trim()}>
            Add
          </Button>
        </div>
        {linkError && (
          <p role="alert" className="text-[13px] font-medium text-crit">
            {linkError}
          </p>
        )}
        <p className="text-[13px] text-text2">
          Only pages you shared with Product Oracle in Notion appear here ·{" "}
          <a href={SHARE_HELP} target="_blank" rel="noreferrer" className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            Share more in Notion
          </a>
        </p>
      </div>
    </div>
  );
}
