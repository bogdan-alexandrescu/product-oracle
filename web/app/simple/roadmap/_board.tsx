"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { barKind, broken, closedItem, spanWords, whereAttr, type Change, type Item, type Roadmap } from "./_lib";

export type Horizon = Item["horizon"];

export const HORIZONS: { key: Horizon; label: string }[] = [
  { key: "now", label: "Now" },
  { key: "next", label: "Next" },
  { key: "later", label: "Later" },
];

const LONG_PRESS_MS = 450;
/** A held card this close to the screen's top or bottom scrolls the page (px), this far a frame. */
const EDGE = 64;
const EDGE_STEP = 12;

/** A column's sections: its items by the roadmap's groups (goal by default), the cut ones
 * below the line. */
export interface BoardColumn {
  key: Horizon;
  label: string;
  window: { start: string; end: string };
  groups: { key: string; title: string; items: Item[] }[];
  below: Item[];
}

export function boardColumns(data: Roadmap): BoardColumn[] {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  return HORIZONS.map((h) => {
    const groups = data.groups
      .map((g) => ({
        key: g.key,
        title: g.title,
        items: g.item_ids.map((id) => byId.get(id)).filter((i): i is Item => !!i && i.horizon === h.key && !closedItem(i)),
      }))
      .filter((g) => g.items.length);
    const below = data.items.filter((i) => i.horizon === h.key && closedItem(i));
    return { ...h, window: data.windows[h.key], groups, below };
  });
}

type Drag = {
  id: string;
  x0: number;
  y0: number;
  pointer: number;
  armed: boolean;
  moved: boolean;
  timer: number | null;
  el: HTMLElement;
  over: Horizon | null;
  /** The page's scroll when the drag began, and the pointer's last point (for the edge scroll). */
  sy0: number;
  x: number;
  y: number;
  scroll: number | null;
};

export interface BoardProps {
  data: Roadmap;
  phone: boolean;
  /** People who may change things drag; viewers read. */
  canDrag: boolean;
  /** Horizon changes waiting for the decider (the card says where it was proposed to go). */
  proposals: Change[];
  open: string | null;
  onOpen: (item: Item) => void;
  onMove: (item: Item, horizon: Horizon) => void;
  /** S7: quick add's drop targets (the columns and the goal headers). */
  dropTargets?: boolean;
  goalSuggestions?: Map<string, number>;
  onGoal?: (goalId: string, title: string) => void;
}

/**
 * D3's Now / Next / Later board: the same items as the timeline, by horizon then group.
 * A card dragged to another column (a phone: after a long press) changes its horizon
 * through the change engine; the arrow keys do the same for a focused card (left and right;
 * on a phone, where the columns stack, up and down too). A held card at the screen's edge
 * scrolls the page; a cancelled touch moves nothing.
 */
export function Board({ data, phone, canDrag, proposals, open, onOpen, onMove, dropTargets, goalSuggestions, onGoal }: BoardProps) {
  const drag = useRef<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A card the keyboard moved: it gets the focus back once it is drawn in its new column.
  const refocus = useRef<{ id: string; horizon: Horizon } | null>(null);
  const cols = boardColumns(data);

  useEffect(() => {
    const f = refocus.current;
    const el = f && root.current?.querySelector<HTMLElement>(`[data-testid="board-card"][data-bar-id="${f.id}"]`);
    if (f && el && el.dataset.horizon === f.horizon) {
      refocus.current = null;
      el.focus();
    }
  }, [data]);

  // A picked-up card on a touch screen: the page does not scroll under the finger.
  useEffect(() => {
    const stop = (e: TouchEvent) => {
      if (drag.current?.armed) e.preventDefault();
    };
    document.addEventListener("touchmove", stop, { passive: false });
    return () => document.removeEventListener("touchmove", stop);
  }, []);

  // The column under the pointer, by the columns' boxes (the dragged card is over it).
  const columnAt = (x: number, y: number): Horizon | null => {
    for (const el of root.current?.querySelectorAll<HTMLElement>("[data-horizon-column]") ?? []) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el.dataset.horizonColumn as Horizon;
    }
    return null;
  };
  const mark = (over: Horizon | null) => {
    for (const el of root.current?.querySelectorAll<HTMLElement>("[data-horizon-column]") ?? []) {
      if (el.dataset.horizonColumn === over) el.dataset.dropTarget = "true";
      else delete el.dataset.dropTarget;
    }
  };
  const reset = (d: Drag) => {
    if (d.timer) clearTimeout(d.timer);
    if (d.scroll) cancelAnimationFrame(d.scroll);
    d.scroll = null;
    d.el.style.transform = "";
    d.el.style.zIndex = "";
    d.el.removeAttribute("data-picked");
    mark(null);
  };

  const onDown = (e: ReactPointerEvent<HTMLElement>, item: Item) => {
    if (e.button !== 0) return;
    const movable = canDrag && !closedItem(item);
    const touch = e.pointerType === "touch";
    const el = e.currentTarget;
    const d: Drag = {
      id: item.id,
      x0: e.clientX,
      y0: e.clientY,
      pointer: e.pointerId,
      armed: movable && !touch,
      moved: false,
      timer: null,
      el,
      over: null,
      sy0: window.scrollY,
      x: e.clientX,
      y: e.clientY,
      scroll: null,
    };
    drag.current = d;
    const capture = () => {
      try {
        el.setPointerCapture?.(d.pointer);
      } catch {
        // A pointer that is gone already.
      }
    };
    if (touch && movable) {
      // Phone: a long press picks the card up; moving first scrolls.
      d.timer = window.setTimeout(() => {
        d.armed = true;
        capture();
        el.setAttribute("data-picked", "true");
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    } else if (d.armed) capture();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.armed) {
      if (Math.hypot(dx, dy) > 8) {
        reset(d);
        drag.current = null;
      }
      return;
    }
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    e.preventDefault();
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    follow(d);
    // Held at the screen's top or bottom: the page scrolls until the finger moves away.
    if (!d.scroll && edgeStep(d.y)) d.scroll = requestAnimationFrame(() => edgeScroll(d));
  };

  /** The card under the pointer (the page may have scrolled since the drag began) and the column it is over. */
  const follow = (d: Drag) => {
    d.el.style.transform = `translate(${d.x - d.x0}px, ${d.y - d.y0 + window.scrollY - d.sy0}px)`;
    d.el.style.zIndex = "30";
    d.over = columnAt(d.x, d.y);
    mark(d.over);
  };
  const edgeStep = (y: number): number => (y < EDGE ? -EDGE_STEP : y > window.innerHeight - EDGE ? EDGE_STEP : 0);
  const edgeScroll = (d: Drag) => {
    const step = edgeStep(d.y);
    const before = window.scrollY;
    if (step) window.scrollBy(0, step);
    if (drag.current !== d || !step || window.scrollY === before) {
      d.scroll = null;
      return;
    }
    follow(d);
    d.scroll = requestAnimationFrame(() => edgeScroll(d));
  };

  // The system took the touch back (a call, a gesture): the card drops where it was.
  const onCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    reset(d);
  };

  const onUp = (e: ReactPointerEvent<HTMLElement>, item: Item) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    reset(d);
    if (!d.moved) {
      if (e.type === "pointerup") onOpen(item);
      return;
    }
    const to = columnAt(e.clientX, e.clientY) ?? d.over;
    if (to && to !== item.horizon) onMove(item, to);
  };

  const onKey = (e: ReactKeyboardEvent, item: Item) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(item);
      return;
    }
    // Arrows move a card to the column beside it (on a phone the columns stack: up and down
    // too; on a desktop they scroll the page).
    const step = e.key === "ArrowRight" || (phone && e.key === "ArrowDown") ? 1 : e.key === "ArrowLeft" || (phone && e.key === "ArrowUp") ? -1 : 0;
    if (!step || !canDrag || closedItem(item)) return;
    e.preventDefault();
    const at = HORIZONS.findIndex((h) => h.key === item.horizon) + step;
    if (at >= 0 && at < HORIZONS.length) {
      refocus.current = { id: item.id, horizon: HORIZONS[at].key };
      onMove(item, HORIZONS[at].key);
    }
  };

  const card = (item: Item) => {
    const kind = closedItem(item) ? "cut" : barKind(item);
    const red = broken(item).length > 0;
    const pending = proposals.find((c) => c.op === "change_horizon" && c.target.item_id === item.id);
    const movable = canDrag && !closedItem(item);
    return (
      <li key={item.id}>
        <div
          role="button"
          tabIndex={0}
          data-testid="board-card"
          data-bar-id={item.id}
          data-item={item.key}
          data-horizon={item.horizon}
          data-kind={kind}
          data-broken={red ? "true" : "false"}
          data-open={open === item.id ? "true" : undefined}
          aria-label={`${item.title}, ${item.horizon}${movable ? ". Arrows move it to another column" : ""}`}
          style={{ touchAction: movable ? "pan-y" : "auto" }}
          onPointerDown={(e) => onDown(e, item)}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onUp(e, item)}
          onPointerCancel={onCancel}
          onKeyDown={(e) => onKey(e, item)}
          className={`relative block w-full rounded-xl border bg-surface px-3 py-2 text-left shadow-[var(--shadow)] select-none data-[open=true]:ring-2 data-[open=true]:ring-accent data-[picked=true]:shadow-tip ${
            red ? "border-crit" : kind === "draft" ? "border-dashed border-line-strong" : "border-line"
          } ${movable ? "cursor-grab" : "cursor-pointer"} ${kind === "cut" ? "opacity-70" : ""}`}
        >
          <p className={`text-[16px] leading-snug font-medium ${kind === "cut" ? "text-text2 line-through" : ""}`}>{item.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text2">
            <span
              data-testid="board-dates"
              className={kind === "estimated" ? "rounded bg-[repeating-linear-gradient(45deg,var(--accent-soft)_0_4px,var(--accent-mid)_4px_6px)] px-1 text-accent-ink" : ""}
            >
              {spanWords(item.start.date, item.end.date, data.today)}
              {kind === "estimated" && " · estimated"}
            </span>
            {kind === "draft" && (
              <span className="rounded-full bg-na-bg px-1.5 text-xs text-na" data-testid="draft-tag">
                Draft
              </span>
            )}
            {item.confidence && <span>{item.confidence} confidence</span>}
            {item.owner && <span>{item.owner.name}</span>}
          </p>
          {item.drafting && (
            <p className="mt-1 text-sm text-accent-ink" data-testid="item-drafting">
              Oracle is drafting…
            </p>
          )}
          {item.merged_into && (
            <p className="mt-1 text-sm text-text2" data-testid="item-merged">
              Merged into {item.merged_into.code}
            </p>
          )}
          {item.looks_like.length > 0 && (
            <p className="mt-1 text-sm text-warn" data-testid="board-looks-like">
              Looks like {item.looks_like[0].code} {item.looks_like[0].title}
            </p>
          )}
          {red && (
            <p className="mt-1 text-sm text-crit" data-testid="board-broken">
              {broken(item)[0].reason}
            </p>
          )}
          {pending && (
            <p className="mt-1 text-sm text-accent-ink" data-testid="board-pending">
              Proposed: move to {HORIZONS.find((h) => h.key === pending.after.horizon)?.label ?? String(pending.after.horizon)} · {pending.by_name}
            </p>
          )}
        </div>
      </li>
    );
  };

  return (
    <div ref={root} data-testid="board" className={phone ? "space-y-3" : "grid grid-cols-3 gap-3"}>
      {cols.map((c) => (
        <section
          key={c.key}
          data-testid="board-column"
          data-horizon-column={c.key}
          data-add-where={dropTargets ? whereAttr("horizon", c.key) : undefined}
          data-add-label={c.label}
          aria-label={c.label}
          className="min-w-0 rounded-[var(--simple-radius)] border border-line bg-surface2 p-2.5 data-[drop-target=true]:border-accent data-[drop-target=true]:bg-accent-soft"
        >
          <header className="flex items-baseline gap-2 px-1 pb-2">
            <h2 className="text-lg font-semibold">{c.label}</h2>
            <span className="text-sm text-text2">
              {spanWords(c.window.start, c.window.end, data.today)}
            </span>
            <span className="tnum ml-auto text-sm text-text2" data-testid="column-count">
              {c.groups.reduce((n, g) => n + g.items.length, 0)}
            </span>
          </header>
          {c.groups.map((g) => (
            <div key={g.key} className="mb-2" data-testid="board-group">
              <h3
                className="flex items-center gap-1 truncate px-1 pb-1 text-sm font-semibold text-text2"
                data-add-where={dropTargets && data.group === "goal" && g.key !== "none" ? whereAttr("goal", g.key) : undefined}
                data-add-label={g.title}
              >
                <span className="min-w-0 flex-1 truncate">{g.title}</span>
                {onGoal && data.group === "goal" && g.key !== "none" && (
                  <button
                    type="button"
                    data-testid="goal-suggestions-open"
                    aria-label={`Suggested features for ${g.title}`}
                    title="Suggested features"
                    onClick={() => onGoal(g.key, g.title)}
                    className="flex h-6 flex-none items-center gap-0.5 rounded-full border border-accent-mid bg-surface px-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-soft"
                  >
                    ✦<span className="tnum">{goalSuggestions?.get(g.key) ?? 0}</span>
                  </button>
                )}
              </h3>
              <ul className="space-y-1.5">{g.items.map((i) => card(i))}</ul>
            </div>
          ))}
          {!c.groups.length && <p className="px-1 py-3 text-sm text-text2">Nothing here yet.</p>}
          {c.below.length > 0 && (
            <div className="mt-2 border-t border-dashed border-line-strong pt-2" data-testid="board-below">
              <h3 className="px-1 pb-1 text-sm font-semibold text-text2">Below the line</h3>
              <ul className="space-y-1.5">{c.below.map((i) => card(i))}</ul>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
