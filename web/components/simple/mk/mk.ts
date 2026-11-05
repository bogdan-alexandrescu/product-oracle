"use client"; // MOCK-HOOK

// MOCK-HOOK: mk-edit-meetings-tracks. URL switches for the owner's mock-up frames:
// ?ea=a|b|c (agenda), ?et=a|b|c (tracks), ?em=a|b|c (move a feature); &st=rest|open|mid|result; &many=1 (the hard case). // MOCK-HOOK
import { useMe } from "@/lib/me"; // MOCK-HOOK

export function mk(key: string): string | null { // MOCK-HOOK
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(key); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: who may act, through can() and the item's own can_* field: one who decides changes, an approver who does not proposes, others read. */
export type MkMode = "edit" | "propose" | "read"; // MOCK-HOOK
/** MOCK-HOOK: the mode the page read last, for the mock's data changes made outside a component. */
export let mkModeSeen: MkMode = "edit"; // MOCK-HOOK
/** MOCK-HOOK: `decides` is the item's own can_* field when it has one; with none, only an owner decides. */
export function useMkMode(decides?: boolean): MkMode { // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  const approver = can("review_section"); // MOCK-HOOK: an approver-level operation
  mkModeSeen = can("accept_simple_change", decides) ? "edit" : approver ? "propose" : "read"; // MOCK-HOOK: an owner passes any item; else the item's can_* decides
  return mkModeSeen; // MOCK-HOOK
} // MOCK-HOOK

export const MK_BTN = "inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium hover:bg-surface2 disabled:opacity-50"; // MOCK-HOOK
export const MK_PRIMARY = "inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-on-accent hover:brightness-110"; // MOCK-HOOK
export const MK_FIELD = "h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[15px] outline-none focus:border-accent"; // MOCK-HOOK
export const MK_CHIP = "inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-px text-sm font-medium text-text"; // MOCK-HOOK
export const MK_LINK = "text-sm font-medium text-accent-ink underline underline-offset-2"; // MOCK-HOOK
