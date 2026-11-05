"use client";
// MOCK-HOOK mk-edit-tasks-restore (Decision 2, ?ec2=a|b|c|d): where a cut feature, an archived
// goal and a removed goal milestone are found and brought back. Mock-ups only.

import { useEffect, useState } from "react"; // MOCK-HOOK

import { Button, Chip, InfoTip, Panel, toast } from "@/components/ds"; // MOCK-HOOK
import { MK_REMOVED, type MkRemoved } from "@/lib/api/mock/mk-removed"; // MOCK-HOOK
import { formatDay } from "@/lib/format"; // MOCK-HOOK

import type { Act } from "./_card"; // MOCK-HOOK
import type { Item } from "./_lib"; // MOCK-HOOK

/** MOCK-HOOK: the variant the URL picks (?ec2=a|b|c|d), else none (the app as built). */
export function useEc2(): string | null {
  const [v, setV] = useState<string | null>(null); // MOCK-HOOK
  useEffect(() => setV(new URLSearchParams(window.location.search).get("ec2")), []); // MOCK-HOOK
  return v; // MOCK-HOOK
}
const flag = (k: string) => typeof window !== "undefined" && new URLSearchParams(window.location.search).get(k) === "1"; // MOCK-HOOK

const HOW: Record<MkRemoved["how"], string> = { cut: "Cut", archived: "Archived", removed: "Removed", deleted: "Deleted" }; // MOCK-HOOK
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
    <li data-testid="mk-removed-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="w-20 flex-none text-[13px] font-semibold text-text2">{KIND[r.kind]}</span>
      <span className="min-w-0 flex-1">
        {onOpen ? (
          <button type="button" className="text-left font-semibold [overflow-wrap:anywhere] hover:underline" onClick={onOpen}>{r.title}</button>
        ) : (
          <span className="font-semibold [overflow-wrap:anywhere]">{r.title}</span>
        )}
        <span className="block text-[13px] text-text2">{r.where} · {when(r)}</span>
      </span>
      {r.days_left != null && <Chip kind="line">{r.days_left} days left</Chip>}
      {can && <Button className="!h-8" onClick={onRestore}>{decide ? "Restore" : "Propose restoring"}</Button>}
    </li>
  ); // MOCK-HOOK
}

/** MOCK-HOOK ec2 A: a "Show removed" switch beside the Roadmap's filters; on, the removed things list under it, each with Restore. */
export function MkShowRemoved({ items, act, canChange, decide, roadmap }: { items: Item[]; act: Act; canChange: boolean; decide: boolean; roadmap: string | null }) {
  const [on, setOn] = useState(flag("removed")); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const rows = MK_REMOVED.filter((r) => r.how !== "deleted" && r.kind !== "goal" && !gone.includes(r.id) && (!roadmap || r.kind !== "feature" || r.where === roadmap)); // MOCK-HOOK
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

/** MOCK-HOOK ec2 C: a "Removed" button by the page title opens a list; a feature opens its panel, which says who cut it, with Restore. */
export function MkRemovedButton({ items, act, canChange, decide, onOpen }: { items: Item[]; act: Act; canChange: boolean; decide: boolean; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(flag("open")); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const rows = MK_REMOVED.filter((r) => r.how !== "deleted" && !gone.includes(r.id)); // MOCK-HOOK
  const restore = useRestore(items, act, (r) => setGone((g) => [...g, r.id])); // MOCK-HOOK
  return (
    <div className="relative" data-testid="mk-removed-button">
      <Button className="!h-8" aria-expanded={open} onClick={() => setOpen(!open)}>Removed · {rows.length}</Button>
      {open && (
        <div role="dialog" aria-label="Removed" className="absolute top-10 left-0 z-30 w-[min(460px,90vw)] rounded-xl border border-line bg-surface shadow-xl">
          <p className="border-b border-line px-3 py-2 text-[13px] font-semibold text-text2">Removed from your plans</p>
          <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">
            {rows.map((r) => {
              const i = items.find((x) => x.key === r.key);
              return <Row key={r.id} r={r} can={canChange} decide={decide} onRestore={() => void restore(r)} onOpen={i ? () => (setOpen(false), onOpen(i.id)) : undefined} />;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** MOCK-HOOK ec2 A, C, D: a cut feature's panel says who cut it and when, with Restore. */
export function MkRemovedLine({ item, act, canChange }: { item: Item; act: Act; canChange: boolean }) {
  const r = MK_REMOVED.find((x) => x.key === item.key); // MOCK-HOOK
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-text2" data-testid="item-cut">
      <span>{r ? when(r) : "Cut"}</span>
      <InfoTip label="What cut means">A cut feature sits below the line, out of the plan. Restore puts it back where it was.</InfoTip>
      {canChange && (
        <>
          ·
          <button type="button" className="font-semibold text-accent-ink hover:underline" onClick={() => void act(`Restored ${item.title}`, { op: "restore", target: { item_id: item.id }, before: { cut: true }, after: {} } as never)}>
            {item.can_decide ? "Restore" : "Propose restoring"}
          </button>
        </>
      )}
    </p>
  ); // MOCK-HOOK
}

/** MOCK-HOOK ec2 D: Cut and Delete side by side in the feature panel's More menu. */
export function MkCutOrDelete({ item, act, canChange }: { item: Item; act: Act; canChange: boolean }) {
  const [open, setOpen] = useState(flag("menu")); // MOCK-HOOK
  const [ask, setAsk] = useState(flag("ask")); // MOCK-HOOK
  if (!canChange || item.status === "cut") return null; // MOCK-HOOK
  return (
    <div className="mt-2" data-testid="mk-cut-delete">
      <Button className="!h-8" aria-expanded={open} onClick={() => setOpen(!open)}>More…</Button>
      {open && (
        <div role="menu" className="mt-1 w-72 max-w-full rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface2" onClick={() => (setOpen(false), void act(`Cut ${item.title}`, { op: "cut", target: { item_id: item.id }, before: { cut: false }, after: { cut: true } } as never))}>
            {item.can_decide ? "Cut from the plan" : "Propose cutting"}
            <span className="block text-[13px] text-text2">Stays on the roadmap, below the line</span>
          </button>
          {item.can_decide && (
            <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-crit hover:bg-surface2" onClick={() => (setOpen(false), setAsk(true))}>
              Delete
              <span className="block text-[13px] text-text2">Goes to Trash for 30 days</span>
            </button>
          )}
        </div>
      )}
      {ask && (
        <div role="alertdialog" aria-label={`Delete ${item.title}?`} className="mt-2 rounded-lg border border-line bg-surface2 p-3">
          <p className="font-semibold">Delete {item.title}?</p>
          <p className="mt-1 text-[14px] text-text2">It leaves the roadmap, Priorities and Home, with its {item.tasks.length} tasks. An owner can restore it from Trash for 30 days.</p>
          <div className="mt-2 flex gap-2">
            <Button className="!h-8" variant="danger" onClick={() => (setAsk(false), localStorage.setItem("mk-deleted", JSON.stringify({ title: item.title })), toast({ message: `${item.title} is in Trash`, action: { label: "Undo", onClick: () => undefined } }))}>Delete</Button>
            <Button className="!h-8" onClick={() => setAsk(false)}>Keep it</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** MOCK-HOOK ec2 B and D: Settings › Trash lists what left the plans beside deleted documents (B: cut, archived and removed too; D: deleted only). */
export function MkTrashPlans({ v, owner }: { v: string; owner: boolean }) {
  const [kind, setKind] = useState<"all" | MkRemoved["kind"]>("all"); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const [mine] = useState<MkRemoved[]>(() => {
    const d = typeof window !== "undefined" ? localStorage.getItem("mk-deleted") : null;
    return d ? [{ id: "mine", kind: "feature", key: "alert-digest", title: JSON.parse(d).title, where: "Alerts roadmap", by: "Avery Stone", at: "2026-10-22T09:12:00Z", how: "deleted", days_left: 30 }] : [];
  }); // MOCK-HOOK the delete made in the panel
  const all = [...mine, ...MK_REMOVED].filter((r) => (v === "d" ? r.how === "deleted" : true) && !gone.includes(r.id)); // MOCK-HOOK
  const rows = all.filter((r) => kind === "all" || r.kind === kind); // MOCK-HOOK
  return (
    <Panel title={v === "d" ? "Deleted from plans" : "Removed from plans"} count={all.length}>
      {v === "b" && (
        <div className="flex flex-wrap gap-2 px-3 pt-2" role="group" aria-label="Show">
          {(["all", "feature", "goal", "milestone"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`h-8 rounded-full border px-3 text-[14px] ${kind === k ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line"}`}>
              {k === "all" ? `All · ${all.length}` : `${KIND[k]}s · ${all.filter((r) => r.kind === k).length}`}
            </button>
          ))}
        </div>
      )}
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <Row key={r.id} r={r} can={owner} decide onRestore={() => (setGone((g) => [...g, r.id]), toast({ message: `Restored ${r.title}`, action: { label: "Undo", onClick: () => undefined } }))} />
        ))}
      </ul>
    </Panel>
  );
}
