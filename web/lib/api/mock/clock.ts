/**
 * The mock's one "now" (#520). The mock runs in the browser, so its seeds and the pages
 * read the same clock: the Playwright suite pins it here before every test
 * (e2e/test.ts installs the browser clock at MOCK_NOW, then lets it run), and a test
 * that needs another day sets its own with page.clock. Date-dependent seeds count
 * from the browser's "now" (new Date()), never from a calendar date written in, so
 * they move with this pin.
 */
export const MOCK_NOW = "2026-10-22T12:00:00Z";

/**
 * "Now" for a seed: the browser's clock in the app, MOCK_NOW where a test builds a seed
 * itself (Node, where the browser's pinned clock does not reach).
 */
export const mockNowMs = (): number => (typeof window === "undefined" ? Date.parse(MOCK_NOW) : Date.now());
