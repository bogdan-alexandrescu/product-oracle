"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Icon, InfoTip } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type DeckOut, type ExpandOut } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

const SLIDE_W = 960;
const SLIDE_H = 540;

type Message = { type: "goto"; index: number } | { type: "overlay"; key: string | null };

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/**
 * Server-rendered HTML in a shadow root, so the deck's theme CSS styles the slide and
 * nothing else on the page. Expand controls and in-deck links are handled here.
 */
function ShadowHtml({
  css,
  themeClass,
  html,
  extraCss = "",
  onExpand,
  onLink,
  className,
  style,
  label,
}: {
  css: string;
  themeClass: string;
  html: string;
  extraCss?: string;
  onExpand?: (key: string) => void;
  onLink?: (key: string) => void;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onExpand, onLink });
  useEffect(() => {
    handlers.current = { onExpand, onLink };
  }, [onExpand, onLink]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    // The HTML comes from the API's renderer (drafts' raw HTML is never rendered) and
    // the CSS from validated theme tokens and Oracle's own stylesheets.
    root.innerHTML = `<style>:host{display:block}${css}${extraCss}</style><div class="deck ${themeClass}">${html}</div>`;
  }, [css, themeClass, html, extraCss]);

  useEffect(() => {
    const root = host.current?.shadowRoot;
    if (!root) return;
    const onClick = (e: Event) => {
      const target = e.target as Element | null;
      const expand = target?.closest("[data-expand]");
      if (expand && handlers.current.onExpand) {
        e.stopPropagation();
        handlers.current.onExpand(expand.getAttribute("data-expand")!);
        return;
      }
      const link = target?.closest('a[href^="#"]');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onLink?.(link.getAttribute("href")!.slice(1));
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [html]);

  return <div ref={host} className={className} style={style} aria-label={label} role={label ? "region" : undefined} />;
}

/**
 * One slide, scaled to fit its box at 16:9 (letterboxed). The boxes around it are min-w-0
 * (qa-docs-6): a flex item's automatic minimum would otherwise grow to the slide's 960 px and
 * a phone would show its left part only.
 */
function SlideCanvas({
  deck,
  index,
  onExpand,
  onLink,
  testId,
}: {
  deck: DeckOut;
  index: number;
  onExpand?: (key: string) => void;
  onLink?: (key: string) => void;
  testId: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.1, Math.min(el.clientWidth / SLIDE_W, el.clientHeight / SLIDE_H)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const slide = deck.slides[index];
  return (
    <div ref={outer} className="flex h-full w-full min-w-0 items-center justify-center overflow-hidden" data-testid={`${testId}-box`}>
      {slide && (
        <div style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }} className="shadow-[0_24px_64px_rgba(0,0,0,0.45)]">
          <ShadowHtml
            css={deck.css}
            themeClass={deck.theme_class}
            html={slide.html}
            onExpand={onExpand}
            onLink={onLink}
            style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, transformOrigin: "top left" }}
            className={testId}
          />
        </div>
      )}
    </div>
  );
}

const OVERLAY_CSS = `.expand-body{box-sizing:border-box;padding:24px 32px;font-size:18px;line-height:1.5;
background:var(--color-background);color:var(--color-text);font-family:var(--font-body)}
.expand-body p,.expand-body ul,.expand-body ol{margin:0 0 10px}`;

function ExpandOverlay({ deck, item, onClose }: { deck: DeckOut; item: ExpandOut; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), [item]);
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-hero/80 p-6 max-[600px]:p-2.5" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Detail: ${item.heading}`}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-inspector border border-hero-line bg-surface text-text shadow-tip"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-14 items-center gap-3 bg-hero px-5 py-2 text-hero-text">
          <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">Detail</span>
          <span className="min-w-0 truncate font-display tracking-heading text-lg font-bold">{item.heading}</span>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-hero-text2 px-3 text-sm font-semibold text-hero-text hover:bg-hero-2"
          >
            <Icon name="x" size={16} />
            Close
          </button>
        </div>
        <div className="overflow-y-auto">
          <ShadowHtml
            css={deck.css}
            themeClass={deck.theme_class}
            html={`<div class="expand-body">${item.html}</div>`}
            extraCss={OVERLAY_CSS}
            className="detail-overlay"
          />
        </div>
      </div>
    </div>
  );
}

function useElapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const BAR_BTN =
  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold whitespace-nowrap text-hero-text hover:bg-hero-2 disabled:text-hero-text2 disabled:opacity-60 disabled:hover:bg-transparent aria-pressed:bg-hero-2";

/** A key cap on the dark presentation bar. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-grid h-6 min-w-6 place-items-center rounded-md border border-hero-line px-1 font-mono text-[13px] text-hero-text">
      {children}
    </kbd>
  );
}

/**
 * Present mode (O1f): the brief, one section per slide, full screen, in the document's
 * theme. Keyboard and click navigation; Expand on a feature or milestone opens its
 * detail in an overlay; the presenter view shows the next slide and the notes. Two
 * windows of the same deck (audience and presenter) stay on the same slide.
 */
export function PresentMode({ doc, n, presenter: startPresenter, start }: { doc: string; n: number; presenter: boolean; start: number }) {
  const deckQ = useQuery(`deck|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/deck", { params: { path: { doc, n } } })),
  );
  const deck = deckQ.data;
  const total = deck?.slides.length ?? 0;
  const [index, setIndex] = useState(Math.max(0, start - 1));
  const [presenter, setPresenter] = useState(startPresenter);
  const [overlayKey, setOverlayKey] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const elapsed = useElapsed();

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(`oracle-present:${doc}:${n}`);
    ch.onmessage = (e: MessageEvent<Message>) => {
      if (e.data?.type === "goto") setIndex(e.data.index);
      if (e.data?.type === "overlay") setOverlayKey(e.data.key);
    };
    channel.current = ch;
    return () => ch.close();
  }, [doc, n]);

  const go = useCallback(
    (i: number) => {
      if (!total) return;
      const next = Math.max(0, Math.min(total - 1, i));
      setIndex(next);
      setOverlayKey(null);
      channel.current?.postMessage({ type: "goto", index: next } satisfies Message);
    },
    [total],
  );

  const showOverlay = useCallback((key: string | null) => {
    setOverlayKey(key);
    channel.current?.postMessage({ type: "overlay", key } satisfies Message);
  }, []);

  const allExpand = useMemo(() => {
    const m = new Map<string, ExpandOut>();
    for (const s of deck?.slides ?? []) for (const e of s.expand) if (!m.has(e.section_key)) m.set(e.section_key, e);
    return m;
  }, [deck]);
  const current = deck?.slides[index];
  const overlay = overlayKey
    ? (current?.expand.find((e) => e.section_key === overlayKey) ?? allExpand.get(overlayKey) ?? null)
    : null;

  const onLink = useCallback(
    (key: string) => {
      const target = deck?.slides.findIndex((s) => s.section_key === key) ?? -1;
      if (target >= 0) go(target);
      else if (allExpand.has(key)) showOverlay(key);
    },
    [deck, go, allExpand, showOverlay],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const onButton = (e.target as HTMLElement | null)?.tagName === "BUTTON";
      if (e.key === "Escape") {
        if (overlayKey) showOverlay(null);
        return;
      }
      if (overlayKey) return;
      if (["ArrowRight", "ArrowDown", "PageDown", "n"].includes(e.key) || (!onButton && (e.key === " " || e.key === "Enter"))) {
        e.preventDefault();
        go(index + 1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      } else if (e.key === "End") {
        e.preventDefault();
        go(total - 1);
      } else if (e.key === "s") {
        setPresenter((p) => !p);
      } else if (e.key === "f") {
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, total, overlayKey, showOverlay, toggleFullscreen]);

  const back = `/documents/${doc}/v/${n}`;
  const counter = deck ? `${index + 1} / ${total}` : "";

  // On a phone the deck starts under the phone header (I3); Full screen still covers it all.
  return (
    <div
      ref={rootRef}
      data-testid="present-mode"
      data-presenter={presenter ? "true" : "false"}
      className="fixed inset-0 z-50 flex flex-col bg-hero text-hero-text max-[600px]:top-[calc(44px+env(safe-area-inset-top))]"
    >
      {deckQ.error && (
        <div className="m-auto max-w-md rounded-panel bg-surface p-6 text-text">
          <ErrorNote>{deckQ.error}</ErrorNote>
          <Link href={back} className="mt-3 inline-block text-sm font-semibold text-accent-ink hover:underline">
            Back to the document
          </Link>
        </div>
      )}
      {!deckQ.error && !deck && (
        <div className="m-auto rounded-panel bg-hero-2 px-4 py-3 text-hero-text">
          <p role="status" className="text-sm font-medium">Loading slides…</p>
        </div>
      )}
      {deck && current && (
        <>
          <p className="sr-only" aria-live="polite">
            Slide {index + 1} of {total}: {current.heading}
          </p>
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {presenter ? (
              <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 p-4 max-[800px]:grid-cols-1 max-[800px]:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] max-[600px]:gap-3 max-[600px]:p-2.5" data-testid="presenter-view">
                <section aria-label="Current slide" className="flex min-h-0 flex-col">
                  <h2 className="tnum mb-2 text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">
                    Current · {counter}
                  </h2>
                  <div className="min-h-0 flex-1" onClick={() => go(index + 1)}>
                    <SlideCanvas deck={deck} index={index} onExpand={showOverlay} onLink={onLink} testId="current-slide" />
                  </div>
                </section>
                <div className="flex min-h-0 flex-col gap-4">
                  <section aria-label="Next slide" className="flex h-1/3 min-h-0 flex-col">
                    <h2 className="mb-2 text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">Next</h2>
                    <div className="min-h-0 flex-1">
                      {index + 1 < total ? (
                        <SlideCanvas deck={deck} index={index + 1} testId="next-slide" />
                      ) : (
                        <p className="text-sm text-hero-text2">End</p>
                      )}
                    </div>
                  </section>
                  <section aria-label="Notes" className="flex min-h-0 flex-1 flex-col">
                    <h2 className="mb-2 flex items-center text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">
                      Notes{" "}
                      <span className="tnum ml-auto font-mono text-[15px] tracking-normal text-hero-text" aria-label="Elapsed time">
                        {elapsed}
                      </span>
                    </h2>
                    <div data-testid="presenter-notes" className="min-h-0 flex-1 overflow-y-auto rounded-button border border-hero-line bg-hero-2 p-3.5 text-[17px] leading-relaxed whitespace-pre-wrap text-hero-text">
                      {current.notes ?? <span className="text-hero-text2">No notes for this slide.</span>}
                    </div>
                  </section>
                </div>
              </div>
            ) : (
              <div className="min-h-0 min-w-0 flex-1 cursor-pointer p-4 max-[600px]:p-2.5" onClick={() => go(index + 1)} data-testid="audience-view">
                <SlideCanvas deck={deck} index={index} onExpand={showOverlay} onLink={onLink} testId="current-slide" />
              </div>
            )}
            {overlay && <ExpandOverlay deck={deck} item={overlay} onClose={() => showOverlay(null)} />}
          </div>
          <nav aria-label="Presentation" className="flex flex-wrap items-center gap-1 border-t border-hero-line px-3 py-2 max-[600px]:px-2">
            <button type="button" className={BAR_BTN} onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide">
              <Icon name="back" size={16} />
              <span className="max-[600px]:sr-only">Previous</span>
            </button>
            <span className="tnum px-2 font-mono text-[15px] font-medium text-hero-text" data-testid="slide-counter">
              {counter}
            </span>
            <button type="button" className={BAR_BTN} onClick={() => go(index + 1)} disabled={index >= total - 1} aria-label="Next slide">
              <span className="max-[600px]:sr-only">Next</span>
              <Icon name="arrow" size={16} />
            </button>
            {/* The banner (status, imported) is in the slide's own footer; not again here (qa-docs-30). */}
            <span className="ml-auto flex flex-wrap items-center gap-1">
              <button type="button" className={BAR_BTN} onClick={() => setPresenter((p) => !p)} aria-pressed={presenter}>
                {presenter ? "Audience view" : "Presenter view"}
              </button>
              {presenter && (
                <button
                  type="button"
                  className={BAR_BTN}
                  onClick={() => window.open(`/documents/${doc}/v/${n}/present?slide=${index + 1}`, "oracle-audience")}
                >
                  Open audience window
                </button>
              )}
              <button type="button" className={BAR_BTN} onClick={toggleFullscreen} aria-pressed={fullscreen}>
                {fullscreen ? "Exit full screen" : "Full screen"}
              </button>
              <Link href={back} className={BAR_BTN} onClick={() => document.fullscreenElement && void document.exitFullscreen()}>
                Exit
              </Link>
              <span className="hidden items-center gap-1 pl-2 text-[13px] text-hero-text2 xl:flex">
                <Key>←</Key>
                <Key>→</Key>
                <Key>s</Key>
                <Key>f</Key>
              </span>
              <span className="hidden xl:inline-flex">
                <InfoTip label="keys" hero>
                  ← → slides · s presenter view · f full screen · Esc closes a detail
                </InfoTip>
              </span>
            </span>
          </nav>
        </>
      )}
    </div>
  );
}
