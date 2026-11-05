"use client";
// MOCK-HOOK mk-edit-tasks-restore (Decision 2, ?ec2=a|b|c): where a cut feature, an archived
// goal and a removed goal milestone are found and brought back. Mock-ups only.

import { useEffect, useState } from "react"; // MOCK-HOOK

import { Button, Panel, toast } from "@/components/ds"; // MOCK-HOOK
import { MK_REMOVED, type MkRemoved } from "@/lib/api/mock/mk-removed"; // MOCK-HOOK
import { formatDay } from "@/lib/format"; // MOCK-HOOK

import type { Act } from "./_card"; // MOCK-HOOK
import type { Item } from "./_lib"; // MOCK-HOOK

/** MOCK-HOOK: the variant the URL picks (?ec2=a|b|c), else none (the app as built). */
export function useEc2(): string | null {
  const [v, setV] = useState<string | null>(null); // MOCK-HOOK
  useEffect(() => setV(new URLSearchParams(window.location.search).get("ec2")), []); // MOCK-HOOK
  return v; // MOCK-HOOK
}
const flag = (k: string) => typeof window !== "undefined" && new URLSearchParams(window.location.search).get(k) === "1"; // MOCK-HOOK

const HOW: Record<MkRemoved["how"], string> = { cut: "Cut", archived: "Archived", removed: "Removed" }; // MOCK-HOOK
const KIND: Record<MkRemoved["kind"], string> = { feature: "Feature", goal: "Goal", milestone: "Milestone" }; // MOCK-HOOK
const when = (r: MkRemoved) => `${HOW[r.how]} on ${formatDay(r.at)} by ${r.by}`; // MOCK-HOOK

/** MOCK-HOOK: Restore (or Propose restoring) one removed thing: a cut feature for real, the rest in the page. */
function useRestore(items: Item[], act: Act | null, onGone: (r: MkRemoved) => void) {
  return async (r: MkRemoved) => {
    const i = items.find((x) => x.key === r.key);
    if (r.kind === "feature" && i && i.status === "cut" && act) await act(`Restored ${r.title}`, { op: "restore", target: { item_id: i.id }, before: { cut: true }, after: {} } as never);
    else toast({ message: `Restored ${r.title}`, action: { label: "Undo", onClick: () => undefined } });
    onGone(r);
  }; // MOCK-HOOK
}

function Row({ r, can, decide, onRestore, onOpen }: { r: MkRemoved; can: boolean; decide: boolean; onRestore: () => void; onOpen?: () => void }) {
  return (
    <li data-testid="mk-removed-row" className="flex items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        {onOpen ? (
          <button type="button" className="text-left font-semibold [overflow-wrap:anywhere] hover:underline" onClick={onOpen}>{r.title}</button>
        ) : (
          <span className="font-semibold [overflow-wrap:anywhere]">{r.title}</span>
        )}
        <span className="block text-[13px] text-text2">{KIND[r.kind]} · {r.where} · {when(r)}</span>
      </span>
      {can && <Button className="!h-8 flex-none" onClick={onRestore}>{decide ? "Restore" : "Propose restoring"}</Button>}
    </li>
  ); // MOCK-HOOK
}

/** MOCK-HOOK: what this roadmap lost: its own cut features and its goals' removed milestones. */
const onPage = (r: MkRemoved, roadmap: string | null) => r.kind !== "goal" && (!roadmap || r.roadmap === roadmap); // MOCK-HOOK

/** MOCK-HOOK ec2 A: a "Show removed" switch beside the Roadmap's filters; on, the removed things list under it, each with Restore. */
export function MkShowRemoved({ items, act, canChange, decide, roadmap }: { items: Item[]; act: Act; canChange: boolean; decide: boolean; roadmap: string | null }) {
  const [on, setOn] = useState(flag("removed")); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const rows = MK_REMOVED.filter((r) => onPage(r, roadmap) && !gone.includes(r.id)); // MOCK-HOOK
  const restore = useRestore(items, act, (r) => setGone((g) => [...g, r.id])); // MOCK-HOOK
  return (
    <div className="w-full" data-testid="mk-show-removed">
      <label className="inline-flex items-center gap-2 text-[14px]">
        <input type="checkbox" role="switch" checked={on} onChange={() => setOn(!on)} className="size-4 accent-[var(--color-accent)]" />
        Show removed · {rows.length}
      </label>
      {on && (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-dashed border-line-strong bg-surface2" aria-label="Removed">
          {rows.map((r) => <Row key={r.id} r={r} can={canChange} decide={decide} onRestore={() => void restore(r)} />)}
          {rows.length === 0 && <li className="px-3 py-2 text-text2">Nothing removed</li>}
        </ul>
      )}
    </div>
  );
}

/** MOCK-HOOK ec2 C: a "Removed" button in the filter row opens one list of what left the plans, each with Restore; a feature opens its panel. */
export function MkRemovedButton({ items, act, canChange, decide, onOpen }: { items: Item[]; act: Act; canChange: boolean; decide: boolean; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(flag("open")); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const rows = MK_REMOVED.filter((r) => !gone.includes(r.id)); // MOCK-HOOK
  const restore = useRestore(items, act, (r) => setGone((g) => [...g, r.id])); // MOCK-HOOK
  return (
    <div className="relative" data-testid="mk-removed-button">
      <Button className="!h-8" aria-expanded={open} onClick={() => setOpen(!open)}>Removed · {rows.length}</Button>
      {open && (
        <div role="dialog" aria-label="Removed" className="absolute top-10 left-0 z-30 w-[min(460px,calc(100vw-32px))] rounded-xl border border-line bg-surface shadow-xl">
          <p className="border-b border-line px-3 py-2 text-[13px] font-semibold text-text2">Removed from your plans</p>
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const i = items.find((x) => x.key === r.key); // MOCK-HOOK
              return <Row key={r.id} r={r} can={canChange} decide={decide} onRestore={() => void restore(r)} onOpen={i ? () => (setOpen(false), onOpen(i.id)) : undefined} />;
            })}
            {rows.length === 0 && <li className="px-3 py-2 text-text2">Nothing removed</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** MOCK-HOOK ec2 A, C: a cut feature's panel says who cut it and when; Restore lives in the panel header's menu (another set draws it). */
export function MkRemovedLine({ item }: { item: Item }) {
  const r = MK_REMOVED.find((x) => x.key === item.key); // MOCK-HOOK
  return (
    <p className="mt-2 text-sm text-text2" data-testid="item-cut">
      {r ? when(r) : "Cut"}
    </p>
  ); // MOCK-HOOK
}

/** MOCK-HOOK ec2 B: Settings › Trash lists what left the plans (cut, archived, removed) under deleted documents. */
export function MkTrashPlans({ owner }: { owner: boolean }) {
  const [kind, setKind] = useState<"all" | MkRemoved["kind"]>("all"); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const all = MK_REMOVED.filter((r) => !gone.includes(r.id)); // MOCK-HOOK
  const rows = all.filter((r) => kind === "all" || r.kind === kind); // MOCK-HOOK
  return (
    <Panel title="Removed from plans" count={all.length}>
      <div className="flex flex-wrap gap-2 px-3 pt-2" role="group" aria-label="Show">
        {(["all", "feature", "goal", "milestone"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`h-8 rounded-full border px-3 text-[14px] ${kind === k ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line"}`}>
            {k === "all" ? `All · ${all.length}` : `${KIND[k]}s · ${all.filter((r) => r.kind === k).length}`}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <Row key={r.id} r={r} can={owner} decide onRestore={() => (setGone((g) => [...g, r.id]), toast({ message: `Restored ${r.title}`, action: { label: "Undo", onClick: () => undefined } }))} />
        ))}
      </ul>
    </Panel>
  );
}
