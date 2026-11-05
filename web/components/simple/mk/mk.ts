"use client"; // MOCK-HOOK

// MOCK-HOOK: mk-edit-meetings-tracks. URL switches for the owner's mock-up frames:
// ?ea=a|b|c (agenda), ?et=a|b|c (tracks), ?em=a|b|c (move a feature); &st=rest|open|mid|result; &many=1 (the hard case).
import { useMe } from "@/lib/me"; // MOCK-HOOK

export function mk(key: string): string | null { // MOCK-HOOK
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(key); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: who may act, through can(): owners and approvers change, a commenter proposes, a viewer reads. */
export type MkMode = "edit" | "propose" | "read"; // MOCK-HOOK
/** MOCK-HOOK: the mode the page read last, for the mock's data changes made outside a component. */
export let mkModeSeen: MkMode = "edit"; // MOCK-HOOK
export function useMkMode(): MkMode { // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  mkModeSeen = can("accept_simple_change") ? "edit" : can("create_simple_change") ? "propose" : "read"; // MOCK-HOOK
  return mkModeSeen; // MOCK-HOOK
} // MOCK-HOOK

export const MK_BTN = "inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium hover:bg-surface2 disabled:opacity-50"; // MOCK-HOOK
export const MK_PRIMARY = "inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-on-accent hover:brightness-110"; // MOCK-HOOK
export const MK_FIELD = "h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[15px] outline-none focus:border-accent"; // MOCK-HOOK
export const MK_LINK = "text-sm font-medium text-accent-ink underline underline-offset-2"; // MOCK-HOOK
