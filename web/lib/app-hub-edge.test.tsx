import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { HUB_EDGE_TYPE, watchHubEdge } from './app-hub-edge';
import { APP_HUB_ORIGINS } from './csp';

/** Puts the test page inside a frame whose parent is `parent`. */
function frameIn(parent: Pick<Window, 'postMessage'>) {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as Window);
}

/** An element at the left edge, styled as `style`. */
function layer(style: Partial<CSSStyleDeclaration>) {
  const element = document.createElement('div');
  Object.assign(element.style, style);
  document.body.append(element);
  return element;
}

/** What `elementsFromPoint` finds at the left edge, topmost first. */
function atEdge(stack: () => Element[]) {
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: stack });
}

const settle = () => vi.advanceTimersByTimeAsync(250);
const posted = (postMessage: ReturnType<typeof vi.fn>) =>
  postMessage.mock.calls.map(([message]) => (message as { rgb: number[] }).rgb);

let stop = () => {};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stop();
  stop = () => {};
  document.body.replaceChildren();
  document.body.removeAttribute('style');
  delete document.documentElement.dataset.mode;
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(document, 'elementsFromPoint');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/*
 * protects=Oracle in its own tab posting nothing;
 * fails_when=the watcher posts from a page that is not framed;
 * no_claim=what a framed page posts.
 */
test('Oracle in its own tab tells no one its edge colour', async () => {
  const postMessage = vi.spyOn(window, 'postMessage');
  atEdge(() => [layer({ backgroundColor: 'rgb(11, 58, 122)' })]);
  stop = watchHubEdge(window);
  await settle();
  expect(postMessage).not.toHaveBeenCalled();
});

/*
 * protects=the hub hearing the left edge's colour, and no other origin hearing it;
 * fails_when=it goes to "*" or another origin, or carries anything but the integer rgb;
 * no_claim=which origin the browser delivers it to (it drops a copy whose origin is not the parent's).
 */
test("a framed Oracle tells each hub origin its left edge's colour", async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  atEdge(() => [layer({ backgroundColor: 'rgb(11, 58, 122)' })]);
  stop = watchHubEdge(window);
  await settle();
  expect(postMessage.mock.calls).toEqual(
    APP_HUB_ORIGINS.map((origin) => [{ type: HUB_EDGE_TYPE, rgb: [11, 58, 122] }, origin]),
  );
  expect(HUB_EDGE_TYPE).toBe('hub:edge');
});

/*
 * protects=the colour the eye sees at the edge, under overlays that let it through;
 * fails_when=a transparent or mostly see-through layer is reported;
 * no_claim=how the browser stacks the layers (elementsFromPoint is stubbed).
 */
test('a see-through layer is looked past to the background under it', async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  const stack = [
    layer({ backgroundColor: 'rgba(0, 0, 0, 0)' }),
    layer({ backgroundColor: 'rgba(255, 255, 255, 0.2)' }),
    layer({ backgroundColor: 'rgb(250, 250, 250)' }),
  ];
  atEdge(() => stack);
  stop = watchHubEdge(window);
  await settle();
  expect(posted(postMessage)).toEqual(APP_HUB_ORIGINS.map(() => [250, 250, 250]));
});

/*
 * protects=the colour the eye sees when a layer has both: its background image paints above its
 * background colour;
 * fails_when=the colour under an opaque gradient is reported instead of the gradient;
 * no_claim=a gradient that fades to see-through further down.
 */
test('an opaque gradient over a dark colour reports the gradient', async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  const both = layer({
    backgroundColor: 'rgb(0, 0, 0)',
    backgroundImage: 'linear-gradient(rgb(255, 255, 255), rgb(255, 255, 255))',
  });
  atEdge(() => [both]);
  stop = watchHubEdge(window);
  await settle();
  expect(posted(postMessage)[0]).toEqual([255, 255, 255]);
});

/*
 * protects=the hub hearing the edge's colour on a page that never stops changing;
 * fails_when=each change pushes the read back, so a node added every 100 ms keeps it from ever
 * happening;
 * no_claim=how long a read waits after a burst (the settle window).
 */
test('a page that keeps changing still posts its edge colour', async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  const rail = layer({ backgroundColor: 'rgb(12, 26, 46)' });
  atEdge(() => [rail]);
  stop = watchHubEdge(window);
  for (let i = 0; i < 5; i += 1) {
    document.body.append(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(posted(postMessage)[0]).toEqual([12, 26, 46]);
});

/*
 * protects=a gradient background counting as the edge's colour;
 * fails_when=a layer with only a gradient is skipped or reported as another colour;
 * no_claim=colours the browser serialises other than rgb() (those go through a canvas).
 */
test("a gradient's first colour stands for a layer with no colour of its own", async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  const gradient = layer({ backgroundImage: 'linear-gradient(rgb(42, 30, 92), rgb(14, 10, 32))' });
  atEdge(() => [gradient]);
  stop = watchHubEdge(window);
  await settle();
  expect(posted(postMessage)[0]).toEqual([42, 30, 92]);
});

/*
 * protects=the hub's dock following Oracle between the navy rail of Detailed and the surface of
 * Simple, as the mode switch sets data-mode on <html> and nothing else changes;
 * fails_when=the switch goes unheard, or the same colour is posted again;
 * no_claim=the real rail and surface colours (the stub picks them by data-mode).
 */
test('switching to Simple posts the new edge colour, once; an unchanged edge posts nothing', async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  const rail = layer({ backgroundColor: 'rgb(12, 26, 46)' });
  const surface = layer({ backgroundColor: 'rgb(255, 255, 255)' });
  document.documentElement.dataset.mode = 'detailed';
  atEdge(() => [document.documentElement.dataset.mode === 'simple' ? surface : rail]);
  stop = watchHubEdge(window);
  await settle();

  document.documentElement.dataset.theme = 'light';
  await settle();
  expect(posted(postMessage)).toEqual(APP_HUB_ORIGINS.map(() => [12, 26, 46]));

  document.documentElement.dataset.mode = 'simple';
  await settle();
  expect(posted(postMessage).slice(APP_HUB_ORIGINS.length)).toEqual(
    APP_HUB_ORIGINS.map(() => [255, 255, 255]),
  );
});

/*
 * protects=the hub's dock following Oracle's light and dark themes, picked in the user menu (it
 * sets or clears data-theme on <html>) or followed from the system's colour scheme;
 * fails_when=either switch goes unheard;
 * no_claim=the real light and dark colours (the stub picks them).
 */
test('a theme switch, picked or from the system, posts the new edge colour', async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  let systemDark = false;
  const scheme = new EventTarget();
  vi.spyOn(window, 'matchMedia').mockReturnValue(scheme as MediaQueryList);
  const light = layer({ backgroundColor: 'rgb(255, 255, 255)' });
  const dark = layer({ backgroundColor: 'rgb(16, 16, 16)' });
  const picked = () => document.documentElement.dataset.theme;
  atEdge(() => [(picked() ?? (systemDark ? 'dark' : 'light')) === 'dark' ? dark : light]);
  stop = watchHubEdge(window);
  await settle();

  document.documentElement.dataset.theme = 'dark';
  await settle();
  delete document.documentElement.dataset.theme;
  await settle();
  systemDark = true;
  scheme.dispatchEvent(new Event('change'));
  await settle();
  const each = (rgb: number[]) => APP_HUB_ORIGINS.map(() => rgb);
  expect(posted(postMessage)).toEqual([
    ...each([255, 255, 255]),
    ...each([16, 16, 16]),
    ...each([255, 255, 255]),
    ...each([16, 16, 16]),
  ]);
});

/*
 * protects=the edge read again when it changes with no DOM mutation: a transition that ends after
 * a read, a scroll in any container, a stylesheet that loads late;
 * fails_when=the event goes unheard, or is heard only when it bubbles to the document;
 * no_claim=which events a browser fires for a given repaint.
 */
test.each(['transitionend', 'scroll', 'load'])(
  'a %s anywhere in the page posts the new edge colour',
  async (type) => {
    const postMessage = vi.fn();
    frameIn({ postMessage });
    const rail = layer({ backgroundColor: 'rgb(12, 26, 46)' });
    const surface = layer({ backgroundColor: 'rgb(255, 255, 255)' });
    let stack = [rail];
    atEdge(() => stack);
    stop = watchHubEdge(window);
    await settle();

    stack = [surface];
    surface.dispatchEvent(new Event(type, { bubbles: false }));
    await settle();
    expect(posted(postMessage).at(-1)).toEqual([255, 255, 255]);
  },
);

/*
 * protects=nothing posted after the watcher is stopped;
 * fails_when=the disposer leaves the observer, the pending read or an event listener running;
 * no_claim=the resize and colour-scheme listeners (the same disposer removes them).
 */
test('a stopped watcher posts nothing more', async () => {
  const postMessage = vi.fn();
  frameIn({ postMessage });
  const rail = layer({ backgroundColor: 'rgb(12, 26, 46)' });
  atEdge(() => [rail]);
  watchHubEdge(window)();
  rail.style.backgroundColor = 'rgb(255, 255, 255)';
  await settle();
  for (const type of ['transitionend', 'scroll', 'load']) {
    rail.dispatchEvent(new Event(type, { bubbles: false }));
  }
  await settle();
  expect(postMessage).not.toHaveBeenCalled();
});

/*
 * protects=the watcher running on every load, from the root layout every page renders inside,
 * and stopping with it;
 * fails_when=the root layout stops starting it, or drops its disposer;
 * no_claim=the layout's render (MeProvider's calls make it a page test).
 */
test('the root layout starts the edge watcher once it has mounted', () => {
  const root = readFileSync(join(__dirname, '..', 'app', '__root.tsx'), 'utf8');
  expect(root).toContain('useEffect(() => watchHubEdge(window), []);');
});
