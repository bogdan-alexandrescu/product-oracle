"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect } from "react";

import { modeOf, saveMode, switchTarget, type Mode } from "@/lib/experience";
import { useMe } from "@/lib/me";

const MODES: { value: Mode; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "studio", label: "Studio" },
];

/** Before paint on a full load (the layout's head script) and on every navigation after it: html[data-mode]. */
export const MODE_SCRIPT = `try{document.documentElement.dataset.mode=/^\\/simple(\\/|$)/.test(location.pathname)?"simple":"studio"}catch(e){}`;

/**
 * #723: the open page's mode on the root element (`data-mode="simple"` or `"studio"`), which
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
 * The [Simple | Studio] switch (#723, D10) at the top of both rails, and in the phone's More
 * drawer. Shown only while the API says Simple is on. A choice saves the person's mode
 * (preferences.experience) and opens the matching page of the other mode.
 */
export function ModeSwitch({ placement, documentHome }: { placement: "rail" | "sheet"; documentHome?: string }) {
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

  const rail = placement === "rail";
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      data-testid={rail ? "mode-switch" : "mode-switch-sheet"}
      className={
        rail
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
            data-testid={`mode-${m.value}${rail ? "" : "-sheet"}`}
            onClick={() => void choose(m.value)}
            className={
              rail
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
