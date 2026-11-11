"use client";

import { useEffect, useRef, useState } from "react";

import { Button, toast } from "@/components/ds";
import { useFitViewport } from "@/lib/fit-viewport";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

import { ChangeFailed, propose, undo, type Item } from "./_lib";
import { withdraw } from "./_tracks";

type Removed = Schemas["SimpleRemovedItem"];

const KIND: Record<Removed["kind"], string> = { feature: "Feature", goal: "Goal", milestone: "Milestone" };
const HOW: Record<Removed["kind"], string> = { feature: "Cut", goal: "Archived", milestone: "Removed" };

/** "Cut on Oct 21 by Priya Raman": who and when, never split inside a name. */
function byline(r: Removed): string {
  return `${HOW[r.kind]}${r.at ? ` on ${formatDay(r.at)}` : ""}${r.by_name ? ` by ${r.by_name}` : ""}`;
}

/** The read every Removed list and cut feature's panel shares (one request per change). */
export const removedKey = (stamp: string) => `simple-removed:${stamp}`;
export const readRemoved = () => unwrap(api.GET("/v1/simple/removed"));

/**
 * The change that puts one removed thing back: a cut feature through the engine's own
 * "restore", an archived goal through the goal asks' "unarchive_goal", a removed goal
 * milestone through "restore_goal_milestone" (oracle.simple.removed).
 */
function restoreBody(r: Removed): Schemas["SimpleChangeIn"] {
  if (r.kind === "feature") return { op: "restore", target: { item_id: r.id }, before: { cut: true }, after: { cut: false } } as Schemas["SimpleChangeIn"];
  if (r.kind === "goal") return { op: "unarchive_goal", target: { goal_id: r.id }, before: {}, after: {} } as Schemas["SimpleChangeIn"];
  return { op: "restore_goal_milestone", target: { milestone_id: r.id }, before: {}, after: {} } as Schemas["SimpleChangeIn"];
}

/**
 * removed-tracks (ec2 C): "Removed · N" at the start of the Roadmap's filter row opens one list
 * of what left the plans (cut features, archived goals, removed goal milestones), who and when,
 * each with Restore; who does not decide proposes it to the decider; a viewer reads.
 */
export function RemovedButton({ items, canChange, onOpen, onChanged }: { items: Item[]; canChange: boolean; onOpen: (id: string) => void; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  // Read again when the roadmap's cut features change (one cut or put back from its panel or chat).
  const cut = items
    .filter((i) => i.status === "cut")
    .map((i) => i.id)
    .join(",");
  const removed = useQuery(removedKey(`${n}:${cut}`), readRemoved, { keepPrevious: true });
  const rows = removed.data?.items ?? [];
  const box = useRef<HTMLDivElement>(null);
  // BGD (Nov 10): the list's height is capped to the viewport, its rows scrolling under the heading.
  const list = useRef<HTMLDivElement>(null);
  const fit = useFitViewport(list, { on: open });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", away), removeEventListener("keydown", esc));
  }, [open]);
  const refresh = async () => {
    setN((x) => x + 1);
    await onChanged();
  };
  const restore = async (r: Removed) => {
    try {
      const res = await propose(restoreBody(r));
      setOpen(false);
      await refresh();
      // at-followups: a proposal is taken back from its toast, as the Tracks sheet's are.
      if (res.change.status !== "applied")
        toast({
          message: `Restoring ${r.title} proposed · waits for ${r.decider_name ?? "an owner"}`,
          action: {
            label: "Withdraw",
            onClick: () =>
              void withdraw(res.change.id).then(
                () => (toast({ message: "Withdrawn" }), refresh()),
                (e) => toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not withdraw it" }),
              ),
          },
        });
      // Undo where the API allows it (a goal put back is archived again from its own menu).
      else if (res.change.can_undo)
        toast({
          message: `Restored ${r.title}`,
          action: {
            label: "Undo",
            onClick: () => void undo(res.change.id).then(refresh, (e) => toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not undo it" })),
          },
        });
      else toast({ message: `Restored ${r.title}` });
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : `${r.title} could not be restored` });
    }
  };
  return (
    <div ref={box} className="relative" data-testid="removed">
      <Button className="!h-8" aria-expanded={open} aria-controls="removed-list" data-testid="removed-open" onClick={() => setOpen(!open)}>
        {/* at-followups: no count until the list is read (never "Removed · 0" while it loads). */}
        {removed.data ? `Removed · ${rows.length}` : "Removed"}
      </Button>
      {open && (
        <div ref={list} id="removed-list" role="dialog" aria-label="Removed from your plans" style={{ maxHeight: fit.maxHeight }} className="absolute top-10 left-0 z-30 flex w-[min(560px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-surface shadow-xl">
          <p className="flex-none border-b border-line px-3 py-2 text-[13px] font-semibold text-text2">Removed from your plans</p>
          <ul data-fit-body="" className="max-h-[70vh] min-h-0 divide-y divide-line overflow-y-auto overscroll-contain">
            {rows.map((r) => (
              <li key={`${r.kind}:${r.id}`} data-testid="removed-row" className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  {r.kind === "feature" ? (
                    <button type="button" className="text-left font-semibold [overflow-wrap:anywhere] hover:underline" onClick={() => (setOpen(false), onOpen(r.id))}>
                      {r.title}
                    </button>
                  ) : (
                    <span className="font-semibold [overflow-wrap:anywhere]">{r.title}</span>
                  )}
                  <span className="block text-[13px] text-text2">
                    {KIND[r.kind]} · {r.where} · <span className="inline-block">{byline(r)}</span>
                  </span>
                </span>
                {canChange && (
                  <Button className="!h-8 flex-none" title={r.can_decide ? undefined : `Waits for ${r.decider_name ?? "an owner"}`} onClick={() => void restore(r)}>
                    {r.can_decide ? "Restore" : "Propose restoring"}
                  </Button>
                )}
              </li>
            ))}
            {removed.data && rows.length === 0 && <li className="px-3 py-2 text-text2">Nothing removed</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * removed-tracks: who cut a cut feature and when (the removed list's own row), in its panel's
 * head. Nothing when the API does not know (a feature cut before who and when were kept).
 */
export function CutBy({ id, onRestore, restoreLabel = "Restore" }: { id: string; onRestore?: () => void; restoreLabel?: string }) {
  const removed = useQuery(removedKey(`cut:${id}`), readRemoved);
  const r = removed.data?.items.find((x) => x.kind === "feature" && x.id === id);
  if (!r?.at) return null;
  // pm1 '⋯ menu by the close': a grey strip under the title, Restore one click away, never hidden.
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-surface2 px-3 py-1.5 text-sm text-text2">
      <p className="min-w-0 flex-1" data-testid="item-cut">
        Cut on {formatDay(r.at)}
        {r.by_name ? ` by ${r.by_name}` : ""}
      </p>
      {onRestore && (
        <button type="button" className="flex-none rounded-md border border-line bg-surface px-2.5 py-1 font-semibold text-text hover:bg-surface2" onClick={onRestore}>
          {restoreLabel}
        </button>
      )}
    </div>
  );
}
