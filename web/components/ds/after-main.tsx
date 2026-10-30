"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";

/** The shell's slot after <main>: the phone's bottom bar renders there (qa-work-42). */
export const AFTER_MAIN_ID = "after-main";

const noSubscribe = () => () => undefined;

/**
 * Renders its children in the slot after the page's content, so Tab reaches them after the
 * top bar and the page (qa-work-42): the phone's bottom bar is fixed to the screen's foot,
 * so where it sits in the DOM changes only the Tab order, never the look. Nothing until the
 * page has hydrated (the slot is the shell's own).
 */
export function AfterMain({ children }: { children: ReactNode }) {
  const slot = useSyncExternalStore(
    noSubscribe,
    () => document.getElementById(AFTER_MAIN_ID),
    () => null,
  );
  return slot ? createPortal(children, slot) : null;
}
