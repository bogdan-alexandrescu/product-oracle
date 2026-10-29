"use client";

import { useMemo, useState } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useLive } from "@/lib/use-live";

type PreviewIn = { tokens: Schemas["ThemeTokens"]; css: string; kind: "prd" | "roadmap" };

const loadPreview = (body: PreviewIn) =>
  unwrap<string>(
    api.POST("/v1/themes/preview", {
      body: { ...body, view: "document", slide_css: null, slide_variant: null },
      parseAs: "text",
    }),
  );

/**
 * A sample document rendered by POST /v1/themes/preview with unsaved tokens and CSS,
 * refreshed 300 ms after the last change. Sandboxed: no scripts, no same-origin access.
 */
export function ThemePreview({ tokens, css, kind, title = "Theme preview" }: PreviewIn & { title?: string }) {
  const live = useLive<PreviewIn, string>({ tokens, css, kind }, loadPreview, 300);
  return <PreviewFrame html={live.data} pending={live.pending} error={live.error} title={title} testId="theme-preview" />;
}

type SlidePreviewIn = {
  tokens: Schemas["ThemeTokens"];
  slide_css: string | null;
  kind: "prd" | "roadmap";
  view: "slides";
  slide_variant: string | null;
};

const loadSlidePreview = (body: SlidePreviewIn) =>
  unwrap<string>(api.POST("/v1/themes/preview", { body: { ...body, css: "" }, parseAs: "text" }));

/**
 * The sample's brief as Present mode slides with unsaved tokens and slide CSS (O1g).
 * `variant` names a built-in theme, whose slide design is in code and is used instead.
 */
export function SlidePreview({
  tokens,
  slideCss,
  kind,
  variant = null,
}: {
  tokens: Schemas["ThemeTokens"];
  slideCss: string | null;
  kind: "prd" | "roadmap";
  variant?: string | null;
}) {
  const live = useLive<SlidePreviewIn, string>(
    { tokens, slide_css: slideCss, kind, view: "slides", slide_variant: variant },
    loadSlidePreview,
    300,
  );
  return (
    <PreviewFrame
      html={live.data}
      pending={live.pending}
      error={live.error}
      title="Slide preview"
      testId="slide-preview"
      // 960 px slides shown at half size.
      scale={0.5}
    />
  );
}

function PreviewFrame({
  html,
  pending,
  error,
  title,
  testId,
  scale = 1,
}: {
  html: string | undefined;
  pending: boolean;
  error: string | null | undefined;
  title: string;
  testId: string;
  scale?: number;
}) {
  return (
    <div className="relative">
      {scale === 1 ? (
        <iframe
          title={title}
          data-testid={testId}
          sandbox=""
          srcDoc={html ?? ""}
          className="h-[34rem] w-full rounded-button border border-line bg-surface"
        />
      ) : (
        <div className="h-[34rem] w-full overflow-hidden rounded-button border border-line bg-surface2">
          <iframe
            title={title}
            data-testid={testId}
            sandbox=""
            srcDoc={html ?? ""}
            className="border-0"
            style={{ width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "top left" }}
          />
        </div>
      )}
      {(pending || !html) && !error && (
        <span className="absolute top-2 right-2 rounded-full bg-surface px-2 py-0.5 text-[13px] text-text2 shadow-panel">
          Updating…
        </span>
      )}
      {error && <p className="mt-1 text-sm text-crit">Preview failed: {error}</p>}
    </div>
  );
}

/**
 * The preview page as a still picture (qa-docs-2, qa-onboarding-29): an SVG image whose
 * foreignObject holds the page. An image runs no script, loads nothing from outside, never
 * scrolls and needs no frame of its own (a scaled, sandboxed frame per tile could paint
 * nothing at all). The page's styles move to the SVG's own <style>, so they always apply.
 * Null when the page cannot be read: the sketch stays.
 */
function pictureOf(html: string, page: { width: number; height: number }): string | null {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const css = [...doc.querySelectorAll("style")].map((el) => el.textContent ?? "").join("\n");
    doc.querySelectorAll("style, script, link, meta, base, iframe, frame, object, embed").forEach((el) => el.remove());
    const body = new XMLSerializer().serializeToString(doc.body);
    const still = `${css}\nbody { overflow: hidden !important; }`.split("]]>").join("]]]]><![CDATA[>");
    const { width: w, height: h } = page;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<style><![CDATA[${still}]]></style>` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;background:var(--color-background, #ffffff)">${body}</div>` +
      `</foreignObject></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
}

/**
 * A small, non-interactive picture of a theme: the preview page scaled down (a quarter by
 * default: 160 x 120). `page` is the preview's own size before scaling (640 x 480): a smaller
 * page keeps the sample's words large enough to read in a small thumbnail. The theme's own
 * colours and fonts draw a sketch of a page underneath, shown until the picture arrives (or
 * when it cannot be had), so a thumbnail is never blank. `fluid` fills its box's width
 * instead (same proportions).
 */
export function ThemeThumbnail({
  tokens,
  css,
  kind,
  scale = 0.25,
  page = { width: 640, height: 480 },
  fluid = false,
}: PreviewIn & { scale?: number; page?: { width: number; height: number }; fluid?: boolean }) {
  const live = useLive<PreviewIn, string>({ tokens, css, kind }, loadPreview, 0);
  const { width: pageWidth, height: pageHeight } = page;
  const src = useMemo(
    () => (live.data ? pictureOf(live.data, { width: pageWidth, height: pageHeight }) : null),
    [live.data, pageWidth, pageHeight],
  );
  const [shown, setShown] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const c = tokens.colors ?? {};
  return (
    <div
      aria-hidden
      data-testid="theme-thumbnail"
      data-ready={src && shown === src ? "true" : undefined}
      className="pointer-events-none relative overflow-hidden rounded border border-line bg-surface"
      style={fluid ? { width: "100%", aspectRatio: `${page.width} / ${page.height}` } : { width: page.width * scale, height: page.height * scale }}
    >
      <div
        data-testid="theme-thumbnail-sketch"
        className="absolute inset-0 flex flex-col gap-1 p-2"
        style={{ background: c.background ?? "#ffffff", fontFamily: tokens.fonts?.heading ?? undefined }}
      >
        <span className="text-[10px] leading-tight font-bold" style={{ color: c.heading ?? "#111827" }}>
          {kind === "roadmap" ? "Product roadmap" : "Feature PRD"}
        </span>
        <span className="h-0.5 w-1/2 rounded" style={{ background: c.accent ?? "#2f5bd3" }} />
        {[90, 75, 85, 60].map((w) => (
          <span key={w} className="h-1 rounded" style={{ width: `${w}%`, background: c.muted ?? "#5b6472", opacity: 0.5 }} />
        ))}
      </div>
      {src && broken !== src && (
        // eslint-disable-next-line @next/next/no-img-element -- a data: SVG made here, not an asset to optimise
        <img
          alt=""
          src={src}
          draggable={false}
          data-testid="theme-thumbnail-picture"
          onLoad={() => setShown(src)}
          onError={() => setBroken(src)}
          className="absolute inset-0 block h-full w-full"
        />
      )}
    </div>
  );
}
