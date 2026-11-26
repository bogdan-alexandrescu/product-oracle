import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { HUB_READY_MESSAGE, tellHubReady } from './app-hub';

function frameIn(parent: Pick<Window, 'postMessage'>) {
  return { parent, self: {} } as unknown as Pick<Window, 'parent' | 'self'>;
}

/*
 * protects=the Saga apps hub hearing that Oracle loaded in its frame, and no one else hearing it;
 * fails_when=the message goes to "*" or another origin, goes more than once per load, or goes from
 * a page that is not framed;
 * no_claim=which origin the browser delivers it to (it drops a copy whose origin is not the parent's).
 */
test('a framed Oracle tells each hub origin it is ready, once per load', () => {
  const postMessage = vi.fn();
  const win = frameIn({ postMessage });
  tellHubReady(win);
  tellHubReady(win);
  expect(postMessage.mock.calls).toEqual([
    [{ type: 'oracle:ready' }, 'https://hub.saga.xyz'],
    [{ type: 'oracle:ready' }, 'https://hub.galatia.saga.xyz'],
  ]);
  expect(HUB_READY_MESSAGE).toEqual({ type: 'oracle:ready' });
});

test('Oracle in its own tab tells no one', () => {
  const postMessage = vi.fn();
  const top = { postMessage } as unknown as Window & { self: unknown };
  tellHubReady({ parent: top, self: top } as unknown as Pick<Window, 'parent' | 'self'>);
  expect(postMessage).not.toHaveBeenCalled();
});

/*
 * protects=the message going on every load, from the root layout every page renders inside;
 * fails_when=the root layout stops calling tellHubReady when it mounts;
 * no_claim=the layout's render (MeProvider's calls make it a page test).
 */
test('the root layout tells the hub once it has mounted', () => {
  const root = readFileSync(join(__dirname, '..', 'app', '__root.tsx'), 'utf8');
  expect(root).toContain('useEffect(() => tellHubReady(window), []);');
});
