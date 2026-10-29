"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect } from "react";

import { modeOf, saveMode, switchTarget, type Mode } from "@/lib/experience";
import { useMe } from "@/lib/me";

import { onRadioKeys, radioTabIndex } from "./radio-keys";

const MODES: { value: Mode; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "detailed", label: "Detailed" },
];

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

  // qa-shell-6: the page opens at once; the choice is saved meanwhile (it only decides where
  // the person lands next time), so a slow save never makes the click look dead.
  function choose(mode: Mode) {
    if (mode === current) return;
    void saveMode(mode);
    router.push(switchTarget(pathname, mode, documentHome));
  }

  const rail = placement !== "sheet";
  const wide = placement === "wide";
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      // A choice opens the other mode: the arrows move focus, Enter or Space opens it.
      onKeyDown={(e) => onRadioKeys(e, MODES.map((m) => m.value), current, choose, { follow: false })}
      data-testid={rail ? "mode-switch" : "mode-switch-sheet"}
      className={
        wide
          ? "mb-4 grid w-full flex-none grid-cols-2 gap-0.5 rounded-xl bg-rail-hover p-1"
          : rail
          ? "mb-3 flex w-[70px] flex-none flex-col gap-0.5 rounded-[10px] bg-rail-hover/40 p-0.5"
          : "mb-3 grid grid-cols-2 overflow-hidden rounded-button border border-line-strong"
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
            tabIndex={radioTabIndex(on)}
            data-testid={`mode-${m.value}${rail ? "" : "-sheet"}`}
            onClick={() => choose(m.value)}
            className={
              wide
                ? `h-9 rounded-lg text-[15px] ${on ? "bg-surface font-semibold text-rail-active-text shadow-sm" : "font-medium text-rail-text hover:text-rail-active-text"}`
                : rail
                ? `h-7 rounded-lg text-[13px] leading-4 ${on ? "bg-rail-active font-semibold text-rail-active-text" : "font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text"}`
                : `h-9 text-sm font-medium ${on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"}`
            }
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
