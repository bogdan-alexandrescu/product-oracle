"use client"; // MOCK-HOOK
// MOCK-HOOK: mock-up switches read from the address (?qd1=a&open=1); mock-ups only, never merged.
import { useSyncExternalStore } from "react"; // MOCK-HOOK
const noop = () => () => {}; // MOCK-HOOK
export function useMockHook(name: string): string | null { // MOCK-HOOK
  return useSyncExternalStore(noop, () => read(name), () => null); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK: a switch stays on for the tab once seen, as pages rewrite their address (select a row, open an item).
function read(name: string): string | null { // MOCK-HOOK
  const v = new URLSearchParams(window.location.search).get(name); // MOCK-HOOK
  if (v != null) sessionStorage.setItem(`mk-${name}`, v); // MOCK-HOOK
  return v ?? sessionStorage.getItem(`mk-${name}`); // MOCK-HOOK
} // MOCK-HOOK
