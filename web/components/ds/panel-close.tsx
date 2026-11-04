"use client";

// A Split's side panel closes on a desktop: an × in its head, or Esc. Closed, the table takes
// the whole width; picking a row (click, Enter or Space) opens it again on that row. The ×
// shows only where a table's row can bring the panel back. A phone keeps its panel as built.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Icon } from "./Icon";

/** Open or closed; a page that lays its table out by the room it has holds it itself. */
export type PanelClose = { open: boolean; setOpen: (open: boolean) => void };

export function usePanelClose(): PanelClose {
  const [open, setOpen] = useState(true);
  return useMemo(() => ({ open, setOpen }), [open]);
}

type SplitPanel = {
  /** A table in the page can pick a row, so a closed panel can come back. */
  pickable: boolean;
  /** A table that picks rows says so while it is shown. */
  register: () => () => void;
  /** The panel's own control: it closes and focus goes back to the selected row. */
  close: () => void;
};

const SplitPanelContext = createContext<SplitPanel | null>(null);
/** True inside the Split's panel, so an Inspector in the page itself gets no ×. */
const InPanel = createContext(false);

export const useSplitPanel = () => useContext(SplitPanelContext);

const PHONE = "(max-width: 600px)";
// Esc that belongs to something open in the page (a menu, a dialog, a list of choices).
const OWN_ESC = '[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]';

/** The Split's grid (Layout.tsx's Split hands over here). */
export function ClosableSplit({
  children,
  inspector,
  cols,
  sticky,
  byRoom,
  panel,
}: {
  children: ReactNode;
  inspector: ReactNode;
  cols: string;
  sticky: string;
  byRoom: boolean;
  panel?: PanelClose;
}) {
  const own = usePanelClose();
  const { open, setOpen } = panel ?? own;
  const [tables, setTables] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const pickable = tables > 0;
  const closed = pickable && !open;

  const register = useCallback(() => {
    setTables((n) => n + 1);
    return () => setTables((n) => n - 1);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => {
      const main = root.current?.querySelector("[data-split-table]");
      const row =
        main?.querySelector<HTMLElement>('tr[data-row][aria-selected="true"]') ??
        main?.querySelector<HTMLElement>("tr[data-row][tabindex]");
      row?.focus();
    });
  }, [setOpen]);
  const value = useMemo(() => ({ pickable, register, close }), [pickable, register, close]);

  // Picking a row of the table (a click anywhere on it, or Enter or Space) opens the panel again.
  const reopen = (t: EventTarget | null) => {
    if (closed && t instanceof Element && t.closest("tr[data-row][aria-selected]")) setOpen(true);
  };

  return (
    <SplitPanelContext.Provider value={value}>
      <div
        ref={root}
        className={byRoom ? "@container min-w-0" : "min-w-0"}
        data-panel={pickable ? (closed ? "closed" : "open") : undefined}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented || closed || !pickable || window.matchMedia(PHONE).matches)
            return;
          if (e.target instanceof Element && e.target.closest(OWN_ESC)) return;
          e.preventDefault();
          close();
        }}
      >
        {/* Closed, the panel is hidden on a desktop only: a phone shows it below the table as before. */}
        <div className={`grid items-start gap-4 max-[600px]:gap-3 ${closed ? "grid-cols-1" : cols}`}>
          <div
            className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3"
            data-split-table
            onClickCapture={(e) => reopen(e.target)}
            onKeyDownCapture={(e) => (e.key === "Enter" || e.key === " ") && reopen(e.target)}
          >
            {children}
          </div>
          <div className={`min-w-0 ${sticky} ${closed ? "min-[601px]:hidden" : ""}`}>
            <InPanel.Provider value={true}>{inspector}</InPanel.Provider>
          </div>
        </div>
      </div>
    </SplitPanelContext.Provider>
  );
}

/** A table that picks rows tells its Split, so the Split's panel can close. */
export function usePickableTable(selectable: boolean) {
  const sp = useSplitPanel();
  const register = sp?.register;
  useEffect(() => (selectable && register ? register() : undefined), [selectable, register]);
  return sp;
}

/** The × in the panel's head, beside its title. */
export function PanelCloseButton() {
  const p = useSplitPanel();
  const inPanel = useContext(InPanel);
  if (!p?.pickable || !inPanel) return null;
  return (
    <button
      type="button"
      onClick={p.close}
      aria-label="Close the details"
      title="Close the details (Esc)"
      data-testid="panel-close"
      className="-my-1.5 -mr-2 inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-hero-text2 hover:bg-hero-2 hover:text-hero-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-hero-accent max-[600px]:hidden"
    >
      <Icon name="x" size={18} />
    </button>
  );
}
