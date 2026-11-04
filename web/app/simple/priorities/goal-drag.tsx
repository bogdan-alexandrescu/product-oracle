"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Schemas } from "@/lib/api/client";

import { DragGhost, featureOf, type useBucketWrites } from "./goal-buckets";
import { planFeatures, wk } from "./plan-buckets";

type Buckets = Schemas["GoalBucketsOut"];
type Feature = ReturnType<typeof planFeatures>[number];
type Carried = { f: Feature; id: string; from: string | null; by: "pointer" | "keys"; x: number; y: number; moved: boolean };

const EDGE = 72; // px from the window's top or bottom where a drag scrolls the page
const SPEED = 14; // px a frame

/** The goal card under a point, by its goal id. */
function goalAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-goal-id]");
  return el?.dataset.goalId ?? null;
}

/**
 * GB3 a: carry a feature by its grip onto another goal's bucket, which lights up and says it
 * becomes the goal the feature moves most; dropping saves that link first (Undo in the note).
 * Pointer and touch (the page scrolls when the finger holds at the window's edge), and keys:
 * Enter or Space picks it up, the arrows choose a goal, Enter drops, Escape cancels.
 */
export function useBucketDrag({ gb, writes }: { gb: Buckets | undefined; writes: ReturnType<typeof useBucketWrites> }) {
  const [carried, setCarried] = useState<Carried | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [edge, setEdge] = useState<{ dir: 1 | -1; words: string } | null>(null);
  const ref = useRef<{ carried: Carried | null; over: string | null }>({ carried: null, over: null });
  useEffect(() => {
    ref.current = { carried, over };
  });
  const titleOf = useCallback((id: string | null) => gb?.goals.find((g) => g.id === id)?.title ?? "", [gb]);

  const drop = useCallback(
    async (c: Carried, to: string | null) => {
      setCarried(null);
      setOver(null);
      setEdge(null);
      if (!to || to === c.from) {
        setSaid(`${c.f.name} stays where it was.`);
        return;
      }
      setSaid(`Moved ${c.f.name} to ${titleOf(to)}.`);
      await writes.move(c.id, c.from, to, <>Moved {c.f.name} to {titleOf(to)}.</>);
    },
    [titleOf, writes],
  );

  const grip = (f: Feature, e: React.PointerEvent | React.KeyboardEvent) => {
    const rec = featureOf(gb, f.code, f.name);
    if (!rec || ref.current.carried) return;
    const from = rec.goal_ids[0] ?? null;
    if ("pointerId" in e) {
      if (e.button !== 0) return;
      e.preventDefault();
      setCarried({ f, id: rec.id, from, by: "pointer", x: e.clientX, y: e.clientY, moved: false });
    } else {
      setCarried({ f, id: rec.id, from, by: "keys", x: 0, y: 0, moved: false });
      setSaid(`Picked up ${f.name}. Use the arrow keys to choose a goal, Enter to drop it there, Escape to cancel.`);
    }
  };

  // The pointer: follow it, light the goal under it, scroll at the window's edges, drop on release.
  useEffect(() => {
    if (carried?.by !== "pointer") return;
    let frame = 0;
    let last = { x: carried.x, y: carried.y };
    const target = (x: number, y: number) => {
      const id = goalAt(x, y);
      setOver(id && id !== ref.current.carried?.from ? id : null);
    };
    const tick = () => {
      const dir = last.y > window.innerHeight - EDGE ? 1 : last.y < EDGE ? -1 : 0;
      if (dir) {
        window.scrollBy(0, dir * SPEED);
        target(last.x, last.y);
        const cards = [...document.querySelectorAll<HTMLElement>("[data-goal-id]")];
        const next = dir > 0 ? cards.find((c) => c.getBoundingClientRect().top > window.innerHeight) : [...cards].reverse().find((c) => c.getBoundingClientRect().bottom < 0);
        const g = gb?.goals.find((x) => x.id === next?.dataset.goalId);
        setEdge({ dir, words: `${dir > 0 ? "↓ Scrolling down" : "↑ Scrolling up"}${g ? ` to goal ${g.order}, ${g.title}` : ""}: keep holding at the edge` });
      } else setEdge(null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const move = (e: PointerEvent) => {
      e.preventDefault();
      last = { x: e.clientX, y: e.clientY };
      setCarried((c) => (c ? { ...c, x: e.clientX, y: e.clientY, moved: true } : c));
      target(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      const c = ref.current.carried;
      if (!c) return;
      void drop(c, c.moved ? goalAt(e.clientX, e.clientY) : null);
    };
    const cancel = () => {
      setCarried(null);
      setOver(null);
      setEdge(null);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // Bound once per pick-up; the position lives in `last`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried?.by, carried?.id]);

  // The keys: the arrows step through the other goals, Enter drops, Escape cancels.
  useEffect(() => {
    if (carried?.by !== "keys" || !gb) return;
    const goals = gb.goals.filter((g) => g.id !== carried.from);
    const key = (e: KeyboardEvent) => {
      const c = ref.current.carried;
      if (!c) return;
      const at = goals.findIndex((g) => g.id === ref.current.over);
      if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) {
        e.preventDefault();
        const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
        const next = goals[at < 0 ? (step > 0 ? 0 : goals.length - 1) : (at + step + goals.length) % goals.length];
        if (!next) return;
        setOver(next.id);
        setSaid(`Over goal ${next.order}, ${next.title}. Enter drops it there.`);
        document.querySelector(`[data-goal-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        void drop(c, ref.current.over);
      } else if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Escape") e.preventDefault();
        setCarried(null);
        setOver(null);
        setSaid(`Move cancelled. ${c.f.name} stays where it was.`);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [carried?.by, carried?.id, carried?.from, gb, drop]);

  let ghost: ReactNode = null;
  if (carried?.by === "pointer" && carried.moved) {
    const phone = typeof window !== "undefined" && window.innerWidth < 640;
    ghost = (
      <DragGhost
        code={carried.f.code}
        name={carried.f.name}
        weeks={carried.f.weeks == null ? "PM-owned" : `${wk(carried.f.weeks)} wk`}
        className={phone ? "!left-4 w-[calc(100%-32px)] max-w-none" : ""}
        style={{ left: phone ? undefined : carried.x - 24, top: carried.y - 18 }}
      />
    );
  }
  const edgeBar = edge ? (
    <div aria-hidden data-testid="drag-edge" className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex h-16 items-center justify-center border-t-2 border-dashed border-accent bg-accent-soft/90 text-[15px] font-[650] text-accent-ink max-sm:bottom-16 lg:left-[232px]">
      {edge.words}
    </div>
  ) : null;
  return { grip, lifted: carried?.f.code ?? null, over, said, ghost, edge: edgeBar };
}
