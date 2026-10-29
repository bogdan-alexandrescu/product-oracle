"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button, Chip, Icon } from "@/components/ds";
import { errorMessage } from "@/lib/use-query";

import { INPUT, TEXTAREA } from "../_components/fields";

/** What every source picker takes: the connection to browse and the source's config. */
export type PickerProps = {
  /** The source's connection; without one only pasting ids is possible. */
  connectionId: string | null;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
};

export type BrowseItem = {
  id: string;
  /** The checkbox's name: "#product", "owner/name". */
  label: string;
  isPrivate: boolean;
  /** Short figures after the name (members, last push). */
  meta?: ReactNode;
  /** Hover text for the row (a channel topic, a repo description). */
  hint?: string | null;
};

/** `notice`: what the provider left out of the list (GitHub's SSO partial results). */
export type BrowsePage = { items: BrowseItem[]; next: string | null; notice?: string | null };

const SEARCH_DELAY_MS = 250;

export function listOf(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  return Array.isArray(value) ? value.map(String) : [];
}

/** A config's `labels`: the display names of its picks, by id (only for people to read). */
export function labelsOf(config: Record<string, unknown>): Record<string, string> {
  const value = config.labels;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** The names of `picked`, from what a list showed (`listed`) or else what was saved. */
export function pickedLabels(
  picked: string[],
  listed: (id: string) => string | undefined,
  saved: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of picked) {
    const name = listed(id) ?? saved[id];
    if (name) out[id] = name;
  }
  return out;
}

export function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function parseLines(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean))];
}

function Row({ item, checked, onToggle }: { item: BrowseItem; checked: boolean; onToggle: (on: boolean) => void }) {
  return (
    <li data-testid="pick-row" className="border-t border-line first:border-t-0">
      <label
        title={item.hint ?? undefined}
        className="flex min-h-10 cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-surface2 max-[600px]:px-2.5"
      >
        <input
          type="checkbox"
          aria-label={item.label}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="size-4 flex-none accent-accent"
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-text">{item.label}</span>
        {item.isPrivate && (
          <span title="Private" className="flex-none text-text2">
            <Icon name="lock" size={16} />
          </span>
        )}
        {item.meta && <span className="tnum flex flex-none items-center gap-1 text-[13px] text-text2">{item.meta}</span>}
      </label>
    </li>
  );
}

/**
 * A searchable checkbox list over a provider's browse endpoint, with a selected count,
 * "Load more" for the next page and a "Paste ids" fallback. Picks are ids; an id the
 * list has not shown (pasted, or past the loaded pages) is still listed, by its saved
 * name or else by id. `onLabels` gets the picks' names whenever the picks change or a
 * loaded page names a pick that had none (so a source saved before names were kept
 * gets them by opening the editor).
 */
export function BrowseList({
  label,
  searchLabel,
  pasteLabel,
  pasteExample,
  connectionId,
  picked,
  onPicked,
  labels = {},
  onLabels,
  load,
  extra,
}: {
  /** The group's name: "Slack channels". */
  label: string;
  searchLabel: string;
  /** The paste box's label, "Channel ids" (shown as "… (one per line)"). */
  pasteLabel: string;
  pasteExample: string;
  connectionId: string | null;
  picked: string[];
  onPicked: (ids: string[]) => void;
  /** The picks' saved names, by id. */
  labels?: Record<string, string>;
  onLabels?: (labels: Record<string, string>) => void;
  load: (search: string, cursor: string | null) => Promise<BrowsePage>;
  /** More fields under the list (Slack's "Since"). */
  extra?: ReactNode;
}) {
  const pasteId = useId();
  const [pasting, setPasting] = useState(connectionId === null);
  const [text, setText] = useState(connectionId === null ? picked.join("\n") : "");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<BrowseItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Every item listed so far, so a pick the current list does not show keeps its name.
  const [seen, setSeen] = useState<Record<string, BrowseItem>>({});
  const loadRef = useRef(load);
  const labelsRef = useRef({ labels, onLabels });
  const run = useRef(0);
  useEffect(() => {
    loadRef.current = load;
    labelsRef.current = { labels, onLabels };
  });

  useEffect(() => {
    const { labels: saved, onLabels: report } = labelsRef.current;
    if (!report) return;
    const next = pickedLabels(picked, (id) => seen[id]?.label, saved);
    if (!sameLabels(next, saved)) report(next);
    // Reports only a change, so a new array of the same picks settles at once.
  }, [picked, seen]);

  async function fetchPage(q: string, cursor: string | null) {
    const mine = ++run.current;
    setBusy(true);
    setError(null);
    try {
      const page = await loadRef.current(q, cursor);
      if (mine !== run.current) return;
      setSeen((prev) => ({ ...prev, ...Object.fromEntries(page.items.map((it) => [it.id, it])) }));
      setItems((prev) => (cursor && prev ? [...prev, ...page.items] : page.items));
      setNext(page.next);
      if (!cursor || page.notice) setNotice(page.notice ?? null);
    } catch (e) {
      if (mine !== run.current) return;
      setError(errorMessage(e));
      if (!cursor) setItems(null);
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (pasting || connectionId === null) return;
    const t = setTimeout(() => void fetchPage(search.trim(), null), search ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(t);
    // fetchPage reads load through a ref; re-run on what the list depends on.
  }, [search, pasting, connectionId, attempt]);

  const chosen = new Set(picked);
  const toggle = (id: string, on: boolean) => onPicked(on ? [...picked.filter((x) => x !== id), id] : picked.filter((x) => x !== id));
  const listed = new Set((items ?? []).map((i) => i.id));
  // Picks the current list does not show, first, while not searching.
  const extraPicks = search.trim()
    ? []
    : picked
        .filter((id) => !listed.has(id))
        .map((id) => seen[id] ?? { id, label: labels[id] ?? id, isPrivate: false });

  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {!pasting && (
          <span className="relative min-w-0 flex-1 basis-48">
            <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text2">
              <Icon name="search" size={16} />
            </span>
            <input
              type="search"
              aria-label={searchLabel}
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${INPUT} pl-8`}
            />
          </span>
        )}
        <span className="flex flex-none items-center gap-1.5 max-[600px]:w-full max-[600px]:justify-between">
          <Chip kind={picked.length ? "acc" : "na"} data-testid="picked-count">
            {picked.length} selected
          </Chip>
          {connectionId !== null && (
            <Button
              variant="ghost"
              onClick={() => {
                if (!pasting) setText(picked.join("\n"));
                setPasting((v) => !v);
              }}
            >
              {pasting ? "Pick from list" : "Paste ids"}
            </Button>
          )}
        </span>
      </div>

      {pasting ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={pasteId} className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
            {pasteLabel} (one per line)
          </label>
          <textarea
            id={pasteId}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onPicked(parseLines(e.target.value));
            }}
            rows={4}
            placeholder={pasteExample}
            className={`${TEXTAREA} font-mono`}
          />
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-button border border-line bg-surface">
          {error && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <p role="alert" className="min-w-0 flex-1 text-sm font-medium text-crit">
                {error}
              </p>
              <Button onClick={() => setAttempt((n) => n + 1)} disabled={busy}>
                Retry
              </Button>
            </div>
          )}
          {notice && !error && (
            <p role="note" className="border-b border-line bg-warn-bg px-3 py-2 text-sm font-medium text-warn">
              {notice}
            </p>
          )}
          <ul aria-label={label} aria-busy={busy} className="max-h-72 overflow-y-auto">
            {extraPicks.map((it) => (
              <Row key={`picked-${it.id}`} item={it} checked onToggle={(on) => toggle(it.id, on)} />
            ))}
            {(items ?? []).map((it) => (
              <Row key={it.id} item={it} checked={chosen.has(it.id)} onToggle={(on) => toggle(it.id, on)} />
            ))}
            {items === null && !error && (
              <li className="flex h-10 items-center px-3">
                <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />
              </li>
            )}
            {items !== null && items.length === 0 && extraPicks.length === 0 && (
              <li className="flex h-10 items-center px-3 text-[15px] text-text2">No matches</li>
            )}
          </ul>
          {next && (
            <div className="border-t border-line px-3 py-1.5">
              <Button variant="ghost" disabled={busy} onClick={() => void fetchPage(search.trim(), next)}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      {extra}
    </div>
  );
}
