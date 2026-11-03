"use client";
// MOCK-HOOK: the whole file. PC1 mock-ups (mk-panelclose): how a Split's docked panel closes
// and comes back, one variant per proposal, picked by `?pc1=a|b|c|d` (no param: as built).
//   a: an × in the panel's head; picking a row opens it again. Every Split page.
//   b: a Hide details / Show details switch in the table's head bar, kept per person. Priorities only.
//   c: closed until a row is picked; × and Esc close it. Every Split page.
//   d: a slim rail with the selected item's name; it expands again. Every Split page.
// State switch: `&open=0|1` starts the panel closed or open.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"; // MOCK-HOOK
import { Icon } from "./Icon"; // MOCK-HOOK

export type PC1 = "a" | "b" | "c" | "d"; // MOCK-HOOK
export type PanelClose = { v: PC1 | null; open: boolean; setOpen: (open: boolean) => void; hide: () => void }; // MOCK-HOOK

const HIDDEN_KEY = "po-pc1-details-hidden"; // MOCK-HOOK

/** The variant on this page: b is for Priorities only, the others for every Split page. */ // MOCK-HOOK
export function usePanelClose(page: "priorities" | "other" = "other"): PanelClose { // MOCK-HOOK
  const [v, setV] = useState<PC1 | null>(null); // MOCK-HOOK
  const [open, setOpenState] = useState(true); // MOCK-HOOK
  useEffect(() => { // MOCK-HOOK
    const q = new URLSearchParams(window.location.search); // MOCK-HOOK
    const raw = q.get("pc1"); // MOCK-HOOK
    const pick = raw === "a" || raw === "b" || raw === "c" || raw === "d" ? raw : null; // MOCK-HOOK
    // A phone keeps its panel as built (below the table, or Priorities' bottom sheet). // MOCK-HOOK
    const on = (pick === "b" && page !== "priorities") || window.matchMedia("(max-width: 600px)").matches ? null : pick; // MOCK-HOOK
    setV(on); // MOCK-HOOK
    const forced = q.get("open"); // MOCK-HOOK
    if (on === "c") setOpenState(forced === "1"); // MOCK-HOOK
    else if (on === "b") setOpenState(forced != null ? forced !== "0" : localStorage.getItem(HIDDEN_KEY) !== "1"); // MOCK-HOOK
    else if (on) setOpenState(forced !== "0"); // MOCK-HOOK
  }, [page]); // MOCK-HOOK
  const setOpen = useCallback( // MOCK-HOOK
    (o: boolean) => { // MOCK-HOOK
      setOpenState(o); // MOCK-HOOK
      if (v === "b") localStorage.setItem(HIDDEN_KEY, o ? "0" : "1"); // MOCK-HOOK
    }, // MOCK-HOOK
    [v], // MOCK-HOOK
  ); // MOCK-HOOK
  // Closing by the panel's own control: focus goes back to the selected row. // MOCK-HOOK
  const hide = useCallback(() => { // MOCK-HOOK
    setOpen(false); // MOCK-HOOK
    requestAnimationFrame(() => { // MOCK-HOOK
      const row = document.querySelector<HTMLElement>('[data-split-table] tr[aria-selected="true"]') ?? document.querySelector<HTMLElement>("[data-split-table] tr[data-row][tabindex]"); // MOCK-HOOK
      row?.focus(); // MOCK-HOOK
    }); // MOCK-HOOK
  }, [setOpen]); // MOCK-HOOK
  return { v, open, setOpen, hide }; // MOCK-HOOK
} // MOCK-HOOK

export const SplitPanelContext = createContext<PanelClose | null>(null); // MOCK-HOOK
export const useSplitPanel = () => useContext(SplitPanelContext); // MOCK-HOOK

/** The Split's grid with the PC1 variants (Layout.tsx's Split hands over here). */ // MOCK-HOOK
export function ClosableSplit({ children, inspector, cols, sticky, byRoom, panel }: { children: ReactNode; inspector: ReactNode; cols: string; sticky: string; byRoom: boolean; panel?: PanelClose }) { // MOCK-HOOK
  const own = usePanelClose(); // MOCK-HOOK
  const p = panel ?? own; // MOCK-HOOK
  const closed = !!p.v && !p.open; // MOCK-HOOK
  // Closed: the table takes the full width (a: ×, b: switch, c: not yet picked); d keeps a 56 px rail. Never on a phone. // MOCK-HOOK
  const grid = !closed ? cols : p.v === "d" ? "grid-cols-[minmax(0,1fr)_56px] max-[600px]:grid-cols-1" : "grid-cols-1"; // MOCK-HOOK
  const reopen = (t: EventTarget | null) => { // MOCK-HOOK
    if (!closed || (p.v !== "a" && p.v !== "c")) return; // MOCK-HOOK
    if (t instanceof Element && t.closest("tr[data-row][aria-selected]")) p.setOpen(true); // MOCK-HOOK
  }; // MOCK-HOOK
  return ( // MOCK-HOOK
    <SplitPanelContext.Provider value={p}>
      <div className={byRoom ? "@container min-w-0" : "min-w-0"} data-panel={p.v ? (closed ? "closed" : "open") : undefined}
        onKeyDown={(e) => { // MOCK-HOOK
          if (e.key !== "Escape" || e.defaultPrevented || !p.v || closed || window.innerWidth <= 600) return; // MOCK-HOOK
          e.preventDefault(); // MOCK-HOOK
          p.hide(); // MOCK-HOOK
        }}
      >
        <div className={`grid items-start gap-4 max-[600px]:gap-3 ${grid}`}>
          <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3" data-split-table
            onClickCapture={(e) => reopen(e.target)} // MOCK-HOOK
            onKeyDownCapture={(e) => (e.key === "Enter" || e.key === " ") && reopen(e.target)} // MOCK-HOOK
          >{children}</div>
          {(!closed || p.v === "d") && <div className={`min-w-0 ${sticky}`}>{inspector}</div>}
        </div>
      </div>
    </SplitPanelContext.Provider>
  ); // MOCK-HOOK
} // MOCK-HOOK

/** The panel head's own control: a: ×, c: × (Esc too), d: fold to a rail. b has none here. */ // MOCK-HOOK
export function PanelCloseButton() { // MOCK-HOOK
  const p = useSplitPanel(); // MOCK-HOOK
  if (!p?.v || p.v === "b") return null; // MOCK-HOOK
  const fold = p.v === "d"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <button
      type="button"
      onClick={p.hide}
      aria-label={fold ? "Fold the details" : "Close the details"}
      title={fold ? "Fold the details" : "Close the details (Esc)"}
      data-testid="panel-close"
      className="-my-1.5 -mr-2 inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-hero-text2 hover:bg-hero-2 hover:text-hero-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-hero-accent max-[600px]:hidden"
    >
      <Icon name={fold ? "chevron-right" : "x"} size={18} />
    </button>
  ); // MOCK-HOOK
} // MOCK-HOOK

/** d: the folded panel, a 56 px rail with the selected item's name; it opens the panel again. */ // MOCK-HOOK
export function PanelRail({ eyebrow, title, children }: { eyebrow: ReactNode; title?: ReactNode; children: ReactNode }) { // MOCK-HOOK
  const p = useSplitPanel(); // MOCK-HOOK
  if (p?.v !== "d" || p.open) return <>{children}</>; // MOCK-HOOK
  return ( // MOCK-HOOK
    <button
      type="button"
      onClick={() => p.setOpen(true)}
      aria-label={`Open the details${typeof title === "string" ? `: ${title}` : ""}`}
      aria-expanded={false}
      data-testid="panel-rail"
      className="flex max-h-[calc(100vh-120px)] min-h-[420px] w-14 flex-col items-center gap-3 overflow-hidden rounded-inspector border border-line bg-hero py-3 text-hero-text shadow-panel hover:bg-hero-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-md bg-hero-2"><Icon name="chevron-left" size={18} /></span>
      <span className="min-h-0 flex-1 overflow-hidden text-left [writing-mode:vertical-rl]">
        <span className="text-[13px] font-semibold tracking-[0.02em] text-hero-text2">{eyebrow}</span>
        <span className="mt-2 block font-display text-[17px] leading-6 font-bold tracking-heading">{title}</span>
      </span>
    </button>
  ); // MOCK-HOOK
} // MOCK-HOOK
