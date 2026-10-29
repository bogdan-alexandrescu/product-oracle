"use client";

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
export function ThemePreview({
  tokens,
  css,
  kind,
  title = "Theme preview",
  testId = "theme-preview",
  height,
}: PreviewIn & { title?: string; testId?: string; height?: string }) {
  const live = useLive<PreviewIn, string>({ tokens, css, kind }, loadPreview, 300);
  return (
    <PreviewFrame html={live.data} pending={live.pending} error={live.error} title={title} testId={testId} height={height} />
  );
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
  height = "h-[34rem]",
}: {
  html: string | undefined;
  pending: boolean;
  error: string | null | undefined;
  title: string;
  testId: string;
  scale?: number;
  /** The frame's height class; the sample scrolls inside it, so nothing is cut off. */
  height?: string;
}) {
  return (
    <div className="relative">
      {scale === 1 ? (
        <iframe
          title={title}
          data-testid={testId}
          sandbox=""
          srcDoc={html ?? ""}
          className={`${height} w-full rounded-button border border-line bg-surface`}
        />
      ) : (
        <div className={`${height} w-full overflow-hidden rounded-button border border-line bg-surface2`}>
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
 * A small, non-interactive picture of a theme: the preview page scaled down (a quarter by
 * default: 160 x 120). `page` is the preview's own size before scaling (640 x 480): a smaller
 * page keeps the sample's words large enough to read in a small thumbnail. Until the preview
 * arrives (or when it cannot be had) the theme's own colours and fonts draw a sketch of a
 * page, so a thumbnail is never blank.
 */
export function ThemeThumbnail({
  tokens,
  css,
  kind,
  scale = 0.25,
  page = { width: 640, height: 480 },
}: PreviewIn & { scale?: number; page?: { width: number; height: number } }) {
  const live = useLive<PreviewIn, string>({ tokens, css, kind }, loadPreview, 0);
  const c = tokens.colors ?? {};
  return (
    <div
      aria-hidden
      data-testid="theme-thumbnail"
      data-ready={live.data ? "true" : undefined}
      className="pointer-events-none overflow-hidden rounded border border-line bg-surface"
      style={{ width: page.width * scale, height: page.height * scale }}
    >
      {live.data ? (
        <iframe
          title="Theme thumbnail"
          tabIndex={-1}
          sandbox=""
          srcDoc={live.data}
          className="border-0"
          style={{ width: page.width, height: page.height, transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      ) : (
        <div
          data-testid="theme-thumbnail-sketch"
          className="flex h-full flex-col gap-1 p-2"
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
      )}
    </div>
  );
}
