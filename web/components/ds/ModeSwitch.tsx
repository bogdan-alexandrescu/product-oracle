"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect, type KeyboardEvent } from "react";

import { modeOf, saveMode, switchTarget, type Mode } from "@/lib/experience";
import { useMe } from "@/lib/me";

const MODES: { value: Mode; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "detailed", label: "Detailed" },
];

/**
 * The one segmented control (qa-simple-home-31): Simple's rail switch, the More sheet's and the
 * account menu's theme switch. A light track with the chosen option as a white pill.
 */
export const SEGMENTED = {
  track: "gap-0.5 rounded-xl bg-surface2 p-1",
  option: "h-9 rounded-lg text-[15px]",
  on: "bg-surface font-semibold text-accent-ink shadow-sm",
  off: "font-medium text-text2 hover:text-accent-ink",
};

/** Before paint on a full load (the layout's head script) and on every navigation after it: html[data-mode]. */
export const MODE_SCRIPT = `try{document.documentElement.dataset.mode=/^\\/simple(\\/|$)/.test(location.pathname)?"simple":"detailed"}catch(e){}`;

/**
 * #723: the open page's mode on the root element (`data-mode="simple"` or `"detailed"`), which
 * scopes Simple's look (globals.css). Reads the pathname: render it inside Suspense.
 */
export function ModeRoot() {
  const pathname = usePathname();
  const mode = modeOf(pathname);
  useLayoutEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);
  return null;
}

/**
 * The [Simple | Detailed] switch (#723, D10) at the top of both rails, and in the phone's More
 * drawer. Shown only while the API says Simple is on. A choice saves the person's mode
 * (preferences.experience) and opens the matching page of the other mode.
 */
export function ModeSwitch({ placement, documentHome }: { placement: "rail" | "wide" | "sheet"; documentHome?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const { simpleMode } = useMe();
  if (!simpleMode) return null;
  const current = modeOf(pathname);

  async function choose(mode: Mode) {
    if (mode === current) return;
    await saveMode(mode);
    router.push(switchTarget(pathname, mode, documentHome));
  }

  const rail = placement !== "sheet";
  const narrow = placement === "rail";

  // qa-simple-home-30: one Tab stop (the checked mode); the arrow keys move to the other and choose it.
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = MODES.findIndex((m) => m.value === current);
    const next = MODES[(at + step + MODES.length) % MODES.length];
    e.currentTarget.querySelector<HTMLElement>(`[data-mode-value="${next.value}"]`)?.focus();
    void choose(next.value);
  }
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      onKeyDown={onKey}
      data-testid={rail ? "mode-switch" : "mode-switch-sheet"}
      // qa-simple-home-31: Simple's rail and the More sheet draw the one segmented control (the
      // rail's white pill, SEGMENTED); Detailed's narrow rail keeps its stacked switch.
      className={
        narrow
          ? "mb-3 flex w-[70px] flex-none flex-col gap-0.5 rounded-[10px] bg-rail-hover/40 p-0.5"
          : `${placement === "wide" ? "mb-4" : "mb-3"} grid w-full flex-none grid-cols-2 ${SEGMENTED.track}`
      }
    >
      {MODES.map((m) => {
        const on = m.value === current;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-mode-value={m.value}
            data-testid={`mode-${m.value}${rail ? "" : "-sheet"}`}
            onClick={() => void choose(m.value)}
            className={
              narrow
                ? `h-7 rounded-lg text-[13px] leading-4 ${on ? "bg-rail-active font-semibold text-rail-active-text" : "font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text"}`
                : `${SEGMENTED.option} ${on ? SEGMENTED.on : SEGMENTED.off}`
            }
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
