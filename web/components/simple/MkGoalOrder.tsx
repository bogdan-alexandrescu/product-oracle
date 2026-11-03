"use client";
// MOCK-HOOK: the whole file. mk-goalorder mock-ups: the controls that change the goals' order
// (GO1 a Baseline handles, b Home row, c order dialog, d a goal's own Move left / Move right)
// and the marks that say the order is deliberate (GO2 a numbers, b main goal, c one line, d nothing).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button, Dialog, toast } from "@/components/ds";
import { mk, mkGoals, mkMove, mkOrder, mkSetOrder } from "@/lib/mk-goalorder";

/** Re-renders when the order changes (any page, any control). */
export function useMkTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    window.addEventListener("mk-goalorder", on);
    return () => window.removeEventListener("mk-goalorder", on);
  }, []);
  return n;
}

/** Saves the order, says so, and offers Undo (the old order back). */
export function mkSave(next: string[], moved?: string): void {
  const before = mkOrder();
  mkSetOrder(next);
  const at = moved ? next.indexOf(moved) + 1 : 0;
  toast({
    message: moved ? `${moved} is now goal ${at} of ${next.length} confirmed goals. Every page shows the new order.` : "Goal order saved. Every page shows the new order.",
    action: { label: "Undo", onClick: () => mkSetOrder(before) },
  });
}

/** The hard case's archived goal: said once, so the owner sees it is left out on purpose. */
export function MkArchivedNote(): ReactNode {
  const n = mkGoals().filter((g) => g.archived).length;
  if (!n) return null;
  return (
    <span className="simple-small block" data-testid="mk-archived-note">
      {n === 1 ? "1 archived goal is" : `${n} archived goals are`} not in the order.
    </span>
  );
}

// ---------------------------------------------------------------- GO2: the marks

/** GO2 a: the goal's place, as a small number; b: the first goal marked Main goal. */
export function MkMark({ index }: { index: number }): ReactNode {
  const v = mk("go2");
  if (v === "a")
    return (
      <span aria-label={`Goal ${index + 1}`} className="mk-go-num tnum">
        {index + 1}
      </span>
    );
  if (v === "b" && index === 0) return <span className="mk-go-main">Main goal</span>;
  return null;
}

/** GO2 c: one plain line over the goals, said once per page. */
export function MkOrderLine({ who = "Dana Okafor", when = "Nov 3" }: { who?: string; when?: string }): ReactNode {
  if (mk("go2") !== "c") return null;
  return (
    <p className="simple-small mb-2" data-testid="mk-order-line">
      Most important first, in the order {who} set on {when}.
    </p>
  );
}

// ---------------------------------------------------------------- GO1 b: right in Home's goal row

type Tile = { id: string; name: string; status: string };

export function MkHomeBar({ canOrder, editing, onEdit }: { canOrder: boolean; editing: boolean; onEdit: (on: boolean) => void }): ReactNode {
  const v = mk("go1");
  const [dialog, setDialog] = useState(mk("open") === "1" && v === "c");
  if (!canOrder || (v !== "b" && v !== "c")) return null;
  if (editing) return null;
  return (
    <div className="mb-2 flex justify-end">
      <Button variant="ghost" onClick={() => (v === "b" ? onEdit(true) : setDialog(true))} data-testid="mk-change-order">
        Change order
      </Button>
      {dialog && <MkOrderDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

export function MkHomeEdit({ rows, onDone }: { rows: Tile[]; onDone: () => void }): ReactNode {
  const phase = mk("phase");
  const start = rows.map((r) => r.name);
  const [order, setOrder] = useState<string[]>(phase === "mid" ? mkMove(start, start[2], 1) : start);
  const dragging = phase === "mid" ? start[2] : null;
  const byName = new Map(rows.map((r) => [r.name, r]));
  const move = (name: string, d: number) => setOrder((o) => mkMove(o, name, o.indexOf(name) + d));
  return (
    <div data-testid="mk-home-edit">
      <div className="mk-go-editbar">
        <span>
          <span className="simple-small">Drag a goal, or use its arrows. The order shows on every page once saved.</span>
          <MkArchivedNote />
        </span>
        <span className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            variant="solid"
            onClick={() => {
              mkSave(order);
              onDone();
            }}
            data-testid="mk-save-order"
          >
            Save order
          </Button>
        </span>
      </div>
      <ul className="simple-goal-band">
        {order.map((name, i) => {
          const g = byName.get(name)!;
          const lifted = dragging === name;
          return (
            <li key={name} className={`simple-goal mk-go-edit ${lifted ? "mk-go-lifted" : ""}`} data-testid="mk-edit-goal">
              <span className="flex items-center gap-2">
                <span className="mk-go-grip" aria-hidden>
                  ⠿
                </span>
                <span className="mk-go-num tnum">{i + 1}</span>
              </span>
              <b className="text-text">{g.name}</b>
              <span className="simple-small">{g.status}</span>
              <span className="mt-auto flex gap-2">
                <button type="button" className="mk-go-arrow" disabled={i === 0} aria-label={`Move ${name} left`} onClick={() => move(name, -1)}>
                  ←
                </button>
                <button type="button" className="mk-go-arrow" disabled={i === order.length - 1} aria-label={`Move ${name} right`} onClick={() => move(name, 1)}>
                  →
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- GO1 c: a numbered list with arrows

export function MkOrderDialog({ onClose }: { onClose: () => void }): ReactNode {
  const start = mkOrder();
  const mid = mk("phase") === "mid";
  const [order, setOrder] = useState<string[]>(mid ? mkMove(start, start[2], 0) : start);
  const [moved, setMoved] = useState<string | null>(mid ? start[2] : null);
  const move = (name: string, d: number) => {
    setOrder((o) => mkMove(o, name, o.indexOf(name) + d));
    setMoved(name);
  };
  return (
    <Dialog
      title="Goal order"
      onClose={onClose}
      dirty={order.join() !== start.join()}
      testId="mk-order-dialog"
      actions={
        <Button
          variant="solid"
          onClick={() => {
            mkSave(order);
            onClose();
          }}
          data-testid="mk-save-order"
        >
          Save order
        </Button>
      }
    >
      <p className="mb-3 text-sm text-text2">Goal 1 shows first, on the left and at the top, on every page.</p>
      <ol className="mk-go-list">
        {order.map((name, i) => (
          <li key={name} className={moved === name ? "mk-go-moved" : ""} data-testid="mk-order-row">
            <span className="mk-go-num tnum">{i + 1}</span>
            <span className="min-w-0 flex-1">{name}</span>
            {moved === name && <span className="text-xs text-text2">Moved</span>}
            <button type="button" className="mk-go-arrow" disabled={i === 0} aria-label={`Move ${name} up`} onClick={() => move(name, -1)}>
              ↑
            </button>
            <button type="button" className="mk-go-arrow" disabled={i === order.length - 1} aria-label={`Move ${name} down`} onClick={() => move(name, 1)}>
              ↓
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-3">
        <MkArchivedNote />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- GO1 a: handles in Baseline's goal list

/** The handle cell of a top-level goal's row: press it to pick the goal up, then move it. */
export function MkHandle({ title, top }: { title: string; top: boolean }): ReactNode {
  useMkTick();
  const order = mkOrder();
  const i = order.indexOf(title);
  const picked = mk("open") === "1" && i === 2;
  const [held, setHeld] = useState(picked);
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!held || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 4 });
  }, [held]);
  if (!top || i < 0) return null;
  const go = (d: number) => {
    setHeld(false);
    mkSave(mkMove(order, title, i + d), title);
  };
  return (
    <span className="relative flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button ref={ref} type="button" className={`mk-go-grip ${held ? "mk-go-held" : ""}`} aria-label={`Move ${title}`} onClick={() => setHeld(!held)} data-testid="mk-handle">
        ⠿
      </button>
      <span className="mk-go-num tnum">{i + 1}</span>
      {mk("phase") === "mid" && i === 0 && <MkGhost title={order[2]} />}
      {held && (
        <span className="mk-go-pop" role="menu" style={at ? { position: "fixed", left: at.x, top: at.y } : undefined}>
          <span className="text-xs text-text2">Drag the row, or</span>
          <button type="button" role="menuitem" disabled={i === 0} onClick={() => go(-1)}>
            Move up
          </button>
          <button type="button" role="menuitem" disabled={i === order.length - 1} onClick={() => go(1)}>
            Move down
          </button>
          <button type="button" role="menuitem" disabled={i === 0} onClick={() => go(-i)}>
            Make it goal 1
          </button>
          <MkArchivedNote />
        </span>
      )}
    </span>
  );
}

/** GO1 a mid-drag: the carried row, lifted over the row it will land above (fixed, so the table does not clip it). */
function MkGhost({ title }: { title: string }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = ref.current?.closest("tr")?.getBoundingClientRect();
      if (r) setAt({ left: r.left + 28, top: r.top - 26, width: Math.min(560, r.width * 0.5) });
    };
    place();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, []);
  return (
    <span ref={ref} aria-hidden>
      {at && (
        <span className="mk-go-ghost" data-testid="mk-ghost" style={{ position: "fixed", ...at }}>
          <span className="mk-go-grip">⠿</span>
          <span className="mk-go-num tnum">3</span>
          {title}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- GO1 d: on a goal's own panel

export function MkPlace({ title, canOrder }: { title: string; canOrder: boolean }): ReactNode {
  useMkTick();
  if (mk("go1") !== "d") return null;
  const order = mkOrder();
  const i = order.indexOf(title);
  if (i < 0) return null;
  return (
    <div className="mk-go-place" data-testid="mk-place">
      <span>
        Goal <b className="tnum">{i + 1}</b> of {order.length}
        {i === 0 && <span className="text-text2">, shown first</span>}
        <MkArchivedNote />
      </span>
      {canOrder && (
        <span className="flex gap-2">
          <Button variant="secondary" disabled={i === 0} onClick={() => mkSave(mkMove(order, title, i - 1), title)} data-testid="mk-move-left">
            ← Move left
          </Button>
          <Button variant="secondary" disabled={i === order.length - 1} onClick={() => mkSave(mkMove(order, title, i + 1), title)} data-testid="mk-move-right">
            Move right →
          </Button>
        </span>
      )}
    </div>
  );
}
