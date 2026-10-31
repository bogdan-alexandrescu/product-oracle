"use client"; // MOCK-HOOK
// MOCK-HOOK: mock-up switches read from the address (?qd1=a&open=1); mock-ups only, never merged.
import { useSyncExternalStore } from "react"; // MOCK-HOOK
const noop = () => () => {}; // MOCK-HOOK
export function useMockHook(name: string): string | null { // MOCK-HOOK
  return useSyncExternalStore(noop, () => new URLSearchParams(window.location.search).get(name), () => null); // MOCK-HOOK
} // MOCK-HOOK
