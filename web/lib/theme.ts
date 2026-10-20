"use client";

import { useCallback, useSyncExternalStore } from "react";

/** I3 rule 5: dark is a real theme, chosen by the system setting and switchable in the user menu. */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "oracle-theme";

/**
 * Runs in <head> before the first paint, so a saved choice never flashes the other theme.
 * Without a saved choice, <html> carries no data-theme and the CSS follows the system.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function subscribe(on: () => void) {
  listeners.add(on);
  window.addEventListener("storage", on);
  return () => {
    listeners.delete(on);
    window.removeEventListener("storage", on);
  };
}

/** The user's theme choice and a setter that saves it and applies it at once. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as const);
  const setTheme = useCallback((t: ThemeChoice) => {
    try {
      if (t === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      // Storage blocked: the choice still applies to this page.
    }
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    listeners.forEach((l) => l());
  }, []);
  return [theme, setTheme];
}
