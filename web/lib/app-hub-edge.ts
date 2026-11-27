import { APP_HUB_ORIGINS } from './csp';

/** The message type Oracle posts to the Saga apps hub whenever its left edge changes colour. */
export const HUB_EDGE_TYPE = 'hub:edge';

/** How far in from the left edge the colour is read: under the hub's strip and handle. */
const EDGE_X = 4;
/** DOM changes come in bursts; the edge is read once the burst settles. */
export const EDGE_SETTLE_MS = 200;

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const RGB_FUNCTION =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/;
const FIRST_COLOR = /(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^)]*\)|#[\da-f]{3,8}\b/i;

let canvas: CanvasRenderingContext2D | null | undefined;

/** A 1×1 canvas: it paints any colour the browser knows, oklch included, and reads back sRGB. */
function paint(doc: Document, color: string): Rgba | undefined {
  canvas ??= doc.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!canvas) return undefined;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = 'transparent';
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

function toRgba(doc: Document, color: string): Rgba | undefined {
  const match = RGB_FUNCTION.exec(color.trim());
  if (!match) return paint(doc, color);
  const [, r, g, b, alpha, percent] = match;
  const a = alpha === undefined ? 1 : Number(alpha) / (percent ? 100 : 1);
  return [Number(r), Number(g), Number(b), a];
}

/** The element's background as rgb: its colour, else its gradient's first; none if see-through. */
function backgroundOf(win: Window, element: Element): Rgb | undefined {
  const style = win.getComputedStyle(element);
  const gradient = FIRST_COLOR.exec(style.backgroundImage)?.[0];
  for (const color of [style.backgroundColor, gradient]) {
    const rgba = color ? toRgba(win.document, color) : undefined;
    if (rgba && rgba[3] >= 0.5) {
      return [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2])];
    }
  }
  return undefined;
}

/** The colour of Oracle's left edge, halfway down: the topmost opaque background there. */
function readEdge(win: Window): Rgb | undefined {
  const doc = win.document;
  const atEdge =
    typeof doc.elementsFromPoint === 'function'
      ? doc.elementsFromPoint(EDGE_X, win.innerHeight / 2)
      : [];
  for (const element of [...atEdge, doc.body, doc.documentElement]) {
    const rgb = backgroundOf(win, element);
    if (rgb) return rgb;
  }
  return undefined;
}

/**
 * Inside the hub's frame, tells the hub the colour of Oracle's left edge, and again whenever it
 * changes, so the hub's strip and dock take the opposite tone. The navy rail of Detailed and the
 * surface of Simple differ, as do light and dark: switching mode or theme sets data-mode or
 * data-theme on <html>, which the observer hears. Posted only to the hub's own origins and only
 * on a change; outside a frame it does nothing. Returns the function that stops it.
 */
export function watchHubEdge(win: Window): () => void {
  if (win.parent === win.self) return () => {};
  let last = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const report = () => {
    const rgb = readEdge(win);
    if (!rgb || rgb.join() === last) return;
    last = rgb.join();
    for (const origin of APP_HUB_ORIGINS) {
      win.parent.postMessage({ type: HUB_EDGE_TYPE, rgb }, origin);
    }
  };
  const reportSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(report, EDGE_SETTLE_MS);
  };

  const observer = new MutationObserver(reportSoon);
  observer.observe(win.document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-mode'],
    childList: true,
    subtree: true,
  });
  const scheme = win.matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', reportSoon);
  win.addEventListener('resize', reportSoon);
  reportSoon();

  return () => {
    clearTimeout(timer);
    observer.disconnect();
    scheme.removeEventListener('change', reportSoon);
    win.removeEventListener('resize', reportSoon);
  };
}
