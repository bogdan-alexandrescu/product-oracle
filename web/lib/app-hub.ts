import { APP_HUB_ORIGINS } from './csp';

/**
 * What Oracle posts to the Saga apps hub once per load, as soon as it renders inside the hub's
 * frame. Without it within its window, the hub offers to open Oracle in a new tab: a Google IAP
 * session that has run out sends the frame to Google's sign-in, which never renders in a frame,
 * and none of Oracle's code runs to say so.
 */
export const HUB_READY_MESSAGE = { type: 'oracle:ready' } as const;

type HubWindow = Pick<Window, 'parent' | 'self'>;

const told = new WeakSet<HubWindow>();

/**
 * Tells the hub framing this page that Oracle has rendered: once per load, only inside a frame,
 * and only to the hub's own origins, so a page on any other origin that frames Oracle hears
 * nothing.
 */
export function tellHubReady(win: HubWindow): void {
  if (win.parent === win.self || told.has(win)) return;
  told.add(win);
  for (const origin of APP_HUB_ORIGINS) win.parent.postMessage(HUB_READY_MESSAGE, origin);
}
