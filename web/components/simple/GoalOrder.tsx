"use client";
// build-goal-order-control: the goals' order, the owner's picked design (mk-goalorder GO1 b and
// GO2 a). Home's goal row gets Change order (owners and approvers, through can()): the cards
// turn into a numbered row with a grip to drag and left / right arrows; Save order stores each
// goal's place (attrs.position, 1 = first) and a toast offers Undo. Every list of goals puts a
// small grey number, 1 to n, before each goal's name.

import { createContext, useContext, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { Button } from "@/components/ds/Button";
import { toast } from "@/components/ds/Toast";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

/** A goal's place in the order, as a small grey number before its name. */
export function GoalNum({ n }: { n: number | null | undefined }): ReactNode {
  if (!n) return null;
  return (
    <span aria-label={`Goal ${n}`} className="goal-num tnum" data-testid="order-num">
      {n}
    </span>
  );
}

/** The goals' numbers on a page (lib/goal-tree.ts goalNumbers), for lists drawn deep inside it. */
export const GoalNumbers = createContext<Map<string, number>>(new Map());

/** A goal's number by its id, key or title (null when it is not in the order). */
export function useGoalNumber(...keys: (string | null | undefined)[]): number | null {
  const numbers = useContext(GoalNumbers);
  for (const k of keys) if (k && numbers.has(k)) return numbers.get(k)!;
  return null;
}

type Tile = { id: string; name: string; status: string };
/** A goal's stored place before the save, to put back on Undo (null: it had none). */
type Placed = { id: string; position: number | null };

const moveTo = (order: string[], id: string, to: number): string[] => {
  const rest = order.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
};

/** Stores each goal's place; only the goals whose place changed are written. */
async function store(places: Placed[], before: Map<string, number | null>): Promise<void> {
  for (const p of places)
    if ((before.get(p.id) ?? null) !== p.position)
      await unwrap(api.PATCH("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: p.id } }, body: { origin: "user", attrs: { position: p.position } } }));
}

/** Home's goal row while ordering: the bar with Cancel and Save order over the numbered cards. */
export function GoalOrderEdit({
  rows,
  positions,
  archived,
  onDone,
  onSaved,
}: {
  rows: Tile[];
  /** Each goal's stored position now (null: none). */
  positions: Map<string, number | null>;
  /** Archived goals: not in the order, said once. */
  archived: number;
  onDone: () => void;
  /** Reloads the pages' goals after a save or an Undo. */
  onSaved: () => void;
}): ReactNode {
  const start = rows.map((r) => r.id);
  const [order, setOrder] = useState<string[]>(start);
  const [dragging, setDragging] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const band = useRef<HTMLUListElement>(null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const move = (id: string, d: number) => setOrder((o) => moveTo(o, id, o.indexOf(id) + d));

  // Drag: the card is lifted under the pointer and takes the place of the card it is over.
  const grab = (id: string) => (e: ReactPointerEvent) => {
    const on = e.target as HTMLElement;
    // A finger drags by the grip only, so the page still scrolls under it.
    if (e.button !== 0 || on.closest("button") || (e.pointerType !== "mouse" && !on.closest(".goal-order-grip"))) return;
    e.preventDefault();
    setDragging(id);
    const over = (ev: PointerEvent) => {
      const cards = [...(band.current?.querySelectorAll<HTMLElement>("[data-goal-id]") ?? [])];
      const hit = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return c.dataset.goalId !== id && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (hit) setOrder((o) => moveTo(o, id, o.indexOf(hit.dataset.goalId!)));
    };
    const drop = () => {
      setDragging(null);
      removeEventListener("pointermove", over);
      removeEventListener("pointerup", drop);
      removeEventListener("pointercancel", drop);
    };
    addEventListener("pointermove", over);
    addEventListener("pointerup", drop);
    addEventListener("pointercancel", drop);
  };

  const save = async () => {
    if (order.join() === start.join()) return onDone();
    setSaving(true);
    const before = new Map(positions);
    try {
      await store(
        order.map((id, i) => ({ id, position: i + 1 })),
        before,
      );
      onDone();
      onSaved();
      const after = new Map(order.map((id, i) => [id, i + 1] as const));
      toast({
        message: "Goal order saved. Every page shows the new order.",
        action: {
          label: "Undo",
          onClick: () =>
            void store(
              [...before].map(([id, position]) => ({ id, position })),
              after,
            )
              .then(onSaved)
              .catch((e) => toast({ message: errorMessage(e) })),
        },
      });
    } catch (e) {
      toast({ message: errorMessage(e) });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="goal-order-edit">
      <div className="goal-order-bar">
        <span>
          <span className="simple-small">Drag a goal, or use its arrows. The order shows on every page once saved.</span>
          {archived > 0 && (
            <span className="simple-small block" data-testid="goal-order-archived">
              {archived === 1 ? "1 archived goal is" : `${archived} archived goals are`} not in the order.
            </span>
          )}
        </span>
        <span className="flex gap-2">
          <Button variant="ghost" onClick={onDone} disabled={saving} data-testid="goal-order-cancel">
            Cancel
          </Button>
          <Button variant="solid" onClick={() => void save()} disabled={saving} data-testid="goal-order-save">
            Save order
          </Button>
        </span>
      </div>
      <ul className="simple-goal-band" ref={band}>
        {order.map((id, i) => {
          const g = byId.get(id)!;
          return (
            <li
              key={id}
              data-goal-id={id}
              className={`simple-goal goal-order-card ${dragging === id ? "goal-order-lifted" : ""}`}
              data-testid="goal-order-card"
              onPointerDown={grab(id)}
            >
              <span className="flex items-center gap-2">
                <span className="goal-order-grip" aria-hidden data-testid="goal-order-grip">
                  ⠿
                </span>
                <GoalNum n={i + 1} />
              </span>
              <b className="text-text">{g.name}</b>
              <span className="simple-small">{g.status}</span>
              <span className="mt-auto flex gap-2">
                <button type="button" className="goal-order-arrow" disabled={i === 0} aria-label={`Move ${g.name} left`} onClick={() => move(id, -1)}>
                  ←
                </button>
                <button type="button" className="goal-order-arrow" disabled={i === order.length - 1} aria-label={`Move ${g.name} right`} onClick={() => move(id, 1)}>
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
