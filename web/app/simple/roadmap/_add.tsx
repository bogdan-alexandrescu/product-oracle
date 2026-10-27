"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { Button, Sheet } from "@/components/ds";

import type { Where } from "./_lib";

/**
 * S7's quick add. A desktop types a title, then drags its chip onto a quarter column of the
 * timeline, a Now / Next / Later column of the board or a goal's header (any element with
 * data-add-where="kind:value"); Enter opens the same choice as a form. A phone taps Add: a
 * sheet with the title and where. The page sends the add_item change (editors apply,
 * others propose).
 */
export function QuickAdd({
  phone,
  options,
  verb,
  onAdd,
}: {
  phone: boolean;
  options: Where[];
  /** "Add" when the caller's change applies there, else "Propose". */
  verb: (w: Where) => "Add" | "Propose";
  onAdd: (title: string, where: Where) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [sheet, setSheet] = useState(false);
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
    if (!t) return;
    if (await onAdd(t, where)) setTitle("");
  };

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !title.trim()) return;
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
      onSubmit={async (t, w) => {
        const ok = await onAdd(t, w);
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
      <input
        id="quick-add-title"
        value={title}
        maxLength={200}
        placeholder="Type a title, then drag it onto a quarter, a column or a goal"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && title.trim()) {
            e.preventDefault();
            setSheet(true);
          }
        }}
        className="h-9 min-w-[16rem] flex-1 rounded-lg border border-line-strong bg-surface px-3 text-[15px] text-text"
      />
      <span
        role="button"
        tabIndex={title.trim() ? 0 : -1}
        aria-disabled={!title.trim()}
        data-testid="quick-add-chip"
        aria-label={title.trim() ? `Drag '${title.trim()}' onto a quarter, a column or a goal (Enter chooses where)` : "Type a title first"}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && title.trim()) {
            e.preventDefault();
            setSheet(true);
          }
        }}
        style={{ touchAction: "none" }}
        className={`inline-flex h-9 max-w-[18rem] items-center gap-1.5 rounded-full border px-3 text-sm font-semibold select-none ${
          title.trim() ? "cursor-grab border-accent bg-accent-soft text-accent-ink" : "cursor-not-allowed border-line text-text2"
        }`}
      >
        <span aria-hidden>⠿</span>
        <span className="truncate">{title.trim() || "New item"}</span>
      </span>
      <Sheet open={sheet} title="Add an item" onClose={() => setSheet(false)} testId="quick-add-sheet">
        {form}
      </Sheet>
    </section>
  );
}

function AddForm({ initial, options, verb, onSubmit }: { initial: string; options: Where[]; verb: (w: Where) => "Add" | "Propose"; onSubmit: (title: string, where: Where) => Promise<void> }) {
  const [title, setTitle] = useState(initial);
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
        if (!title.trim() || !chosen) return;
        setBusy(true);
        try {
          await onSubmit(title.trim(), chosen);
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
      <Button type="submit" variant="solid" disabled={busy || !title.trim() || !chosen}>
        {chosen ? verb(chosen) : "Add"}
      </Button>
    </form>
  );
}
