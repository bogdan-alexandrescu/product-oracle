"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { Button, Icon, Sheet } from "@/components/ds";

import type { Where } from "./_lib";

type Ref = { id: string; title: string };

/**
 * S7's quick add. A desktop types a title, then either drags its chip onto a quarter column
 * of the timeline, a Now / Next / Later column of the board or a goal's header (any element
 * with data-add-where="kind:value"), or presses Enter to add it straight away, as a draft,
 * to the first of those places; it can be dragged to the right place after. A phone taps
 * Add: a sheet with the title and where. The page sends the add_item change (editors apply,
 * others propose). The Roadmap filter decides which roadmap: one chosen (`target`) is named
 * in the field; with all roadmaps and more than one (`roadmaps`), the field and the sheet
 * ask which (a select), and nothing is sent until one is chosen.
 */
export function QuickAdd({
  phone,
  options,
  verb,
  onAdd,
  target = null,
  roadmaps = [],
}: {
  phone: boolean;
  options: Where[];
  /** "Add" when the caller's change applies there, else "Propose". */
  verb: (w: Where, roadmap?: string) => "Add" | "Propose";
  onAdd: (title: string, where: Where, roadmap?: string) => Promise<boolean>;
  /** The one roadmap the item goes to (the Roadmap filter's), named in the field. */
  target?: string | null;
  /** All roadmaps and more than one: the roadmaps to choose from. */
  roadmaps?: Ref[];
}) {
  const [title, setTitle] = useState("");
  const [rm, setRm] = useState("");
  const [sheet, setSheet] = useState(false);
  const ask = roadmaps.length > 0;
  const chosen = ask ? roadmaps.find((r) => r.id === rm)?.id : undefined;
  const ready = !!title.trim() && (!ask || !!chosen);
  const drag = useRef<{ pointer: number; ghost: HTMLElement; x0: number; y0: number; over: HTMLElement | null } | null>(null);

  const whereAt = (x: number, y: number): HTMLElement | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const t = el.closest<HTMLElement>("[data-add-where]");
      if (t) return t;
    }
    return null;
  };
  const mark = (el: HTMLElement | null, on: boolean) => {
    if (!el) return;
    if (on) el.setAttribute("data-drop-target", "true");
    else el.removeAttribute("data-drop-target");
    if (el instanceof SVGElement) el.style.fill = on ? "var(--accent-soft)" : "";
    else el.style.outline = on ? "2px solid var(--accent)" : "";
  };
  const parse = (attr: string): Where | null => {
    const at = attr.indexOf(":");
    const kind = attr.slice(0, at) as Where["kind"];
    const value = attr.slice(at + 1);
    return options.find((o) => o.kind === kind && o.value === value) ?? { kind, value, label: value };
  };

  const send = async (where: Where) => {
    const t = title.trim();
    if (!t || (ask && !chosen)) return;
    if (await onAdd(t, where, chosen)) setTitle("");
  };

  /** Enter, on a desktop: add it straight away (as a draft) to the first available place,
   * same as dropping the chip there — no sheet repeating the title and roadmap it already has. */
  const sendDefault = () => {
    if (ready && options[0]) void send(options[0]);
  };

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !ready) return;
    e.preventDefault();
    const chip = e.currentTarget;
    try {
      chip.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is gone already.
    }
    const r = chip.getBoundingClientRect();
    const ghost = chip.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, pointerEvents: "none", zIndex: "70", opacity: "0.9" });
    ghost.removeAttribute("data-testid");
    ghost.setAttribute("aria-hidden", "true");
    document.body.appendChild(ghost);
    drag.current = { pointer: e.pointerId, ghost, x0: e.clientX, y0: e.clientY, over: null };
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.ghost.style.transform = `translate(${e.clientX - d.x0}px, ${e.clientY - d.y0}px)`;
    const over = whereAt(e.clientX, e.clientY);
    if (over !== d.over) {
      mark(d.over, false);
      mark(over, true);
      d.over = over;
    }
  };
  const end = (e: ReactPointerEvent<HTMLElement>, drop: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    d.ghost.remove();
    mark(d.over, false);
    const over = drop ? (whereAt(e.clientX, e.clientY) ?? d.over) : null;
    const where = over ? parse(over.dataset.addWhere ?? over.getAttribute("data-add-where") ?? "") : null;
    if (where) void send(where);
  };

  const form = (
    <AddForm
      initial={title}
      options={options}
      verb={verb}
      roadmaps={roadmaps}
      initialRoadmap={rm}
      target={target}
      onSubmit={async (t, w, r) => {
        if (r) setRm(r);
        const ok = await onAdd(t, w, r);
        if (ok) {
          setTitle("");
          setSheet(false);
        }
      }}
    />
  );

  if (phone)
    return (
      <>
        <Button variant="solid" data-testid="quick-add-open" onClick={() => setSheet(true)}>
          Add
        </Button>
        <Sheet open={sheet} title="Add an item" onClose={() => setSheet(false)} testId="quick-add-sheet">
          {form}
        </Sheet>
      </>
    );

  return (
    <section data-testid="quick-add" aria-label="Quick add" className="flex flex-wrap items-center gap-2 rounded-[var(--simple-radius)] border border-dashed border-line-strong bg-surface px-3 py-2">
      <label htmlFor="quick-add-title" className="text-sm font-semibold whitespace-nowrap">
        Add an item
      </label>
      {target && (
        <span data-testid="quick-add-target" className="text-sm whitespace-nowrap text-text2">
          to {target}
        </span>
      )}
      {ask && (
        <select
          aria-label="Roadmap"
          data-testid="quick-add-roadmap"
          value={rm}
          onChange={(e) => setRm(e.target.value)}
          className={`h-9 rounded-lg border bg-surface px-2 text-[15px] text-text ${title.trim() && !chosen ? "border-accent" : "border-line-strong"}`}
        >
          <option value="">Which roadmap?</option>
          {roadmaps.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      )}
      <input
        id="quick-add-title"
        value={title}
        maxLength={200}
        placeholder="Type a title, then drag it onto a quarter, a column or a goal"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !title.trim()) return;
          e.preventDefault();
          sendDefault();
        }}
        className="h-9 min-w-[16rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 text-[15px] text-text"
      />
      <span
        role="button"
        tabIndex={ready ? 0 : -1}
        aria-disabled={!ready}
        data-testid="quick-add-chip"
        aria-label={ready ? "Drag to place on a quarter, a column or a goal (Enter adds it now)" : title.trim() ? "Choose a roadmap first" : "Type a title first"}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onKeyDown={(e) => {
          if ((e.key !== "Enter" && e.key !== " ") || !ready) return;
          e.preventDefault();
          sendDefault();
        }}
        style={{ touchAction: "none" }}
        className={`inline-flex h-9 max-w-[18rem] items-center gap-1.5 rounded-full border px-3 text-sm font-semibold select-none ${
          ready ? "cursor-grab border-accent bg-accent-soft text-accent-ink" : "cursor-not-allowed border-line text-text2"
        }`}
      >
        <Icon name="grip" size={16} />
        <span className="truncate">{title.trim() || "New item"}</span>
      </span>
      {/* qa-simple-roadmap-10: where Enter puts it, said before it is pressed. */}
      {ready && options[0] && (
        <span data-testid="quick-add-enter-hint" className="text-sm text-text2">
          Enter adds it to {options[0].label}
        </span>
      )}
    </section>
  );
}

function AddForm({
  initial,
  options,
  verb,
  roadmaps,
  initialRoadmap,
  target,
  onSubmit,
}: {
  initial: string;
  options: Where[];
  verb: (w: Where, roadmap?: string) => "Add" | "Propose";
  roadmaps: Ref[];
  initialRoadmap: string;
  target: string | null;
  onSubmit: (title: string, where: Where, roadmap?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial);
  const [rm, setRm] = useState(initialRoadmap);
  const ask = roadmaps.length > 0;
  const roadmap = ask ? roadmaps.find((r) => r.id === rm)?.id : undefined;
  const [where, setWhere] = useState(options[0] ? `${options[0].kind}:${options[0].value}` : "");
  const [busy, setBusy] = useState(false);
  const chosen = options.find((o) => `${o.kind}:${o.value}` === where);
  const groups: [string, Where["kind"]][] = [
    ["Quarters", "quarter"],
    ["Now / Next / Later", "horizon"],
    ["Goals", "goal"],
  ];
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim() || !chosen || (ask && !roadmap)) return;
        setBusy(true);
        try {
          await onSubmit(title.trim(), chosen, roadmap);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Title
        <input
          data-autofocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          className="h-11 rounded-lg border border-line-strong bg-surface px-3 text-[16px] font-normal text-text"
        />
      </label>
      {target && (
        <p className="text-sm text-text2" data-testid="quick-add-target">
          Goes to {target}
        </p>
      )}
      {ask && (
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Roadmap
          <select value={rm} onChange={(e) => setRm(e.target.value)} className="h-11 rounded-lg border border-line-strong bg-surface px-2 text-[16px] font-normal text-text">
            <option value="">Which roadmap?</option>
            {roadmaps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Where
        <select value={where} onChange={(e) => setWhere(e.target.value)} className="h-11 rounded-lg border border-line-strong bg-surface px-2 text-[16px] font-normal text-text">
          {groups.map(([label, kind]) => (
            <optgroup key={kind} label={label}>
              {options
                .filter((o) => o.kind === kind)
                .map((o) => (
                  <option key={`${o.kind}:${o.value}`} value={`${o.kind}:${o.value}`}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <Button type="submit" variant="solid" disabled={busy || !title.trim() || !chosen || (ask && !roadmap)}>
        {chosen ? verb(chosen, roadmap) : "Add"}
      </Button>
    </form>
  );
}
