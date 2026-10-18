"use client";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useLive } from "@/lib/use-live";

type PreviewIn = { tokens: Schemas["ThemeTokens"]; css: string; kind: "prd" | "roadmap" };

const loadPreview = (body: PreviewIn) =>
  unwrap<string>(api.POST("/v1/themes/preview", { body, parseAs: "text" }));

/**
 * A sample document rendered by POST /v1/themes/preview with unsaved tokens and CSS,
 * refreshed 300 ms after the last change. Sandboxed: no scripts, no same-origin access.
 */
export function ThemePreview({ tokens, css, kind, title = "Theme preview" }: PreviewIn & { title?: string }) {
  const live = useLive<PreviewIn, string>({ tokens, css, kind }, loadPreview, 300);
  return (
    <div className="relative">
      <iframe
        title={title}
        data-testid="theme-preview"
        sandbox=""
        srcDoc={live.data ?? ""}
        className="h-[34rem] w-full rounded-md border border-neutral-200 bg-white"
      />
      {(live.pending || !live.data) && !live.error && (
        <span className="absolute top-2 right-2 rounded bg-white/90 px-1.5 py-0.5 text-[11px] text-neutral-500">
          Updating…
        </span>
      )}
      {live.error && <p className="mt-1 text-xs text-rose-800">Preview failed: {live.error}</p>}
    </div>
  );
}

/** A small, non-interactive picture of a theme: the preview page scaled down to a quarter. */
export function ThemeThumbnail({ tokens, css, kind }: PreviewIn) {
  const live = useLive<PreviewIn, string>({ tokens, css, kind }, loadPreview, 0);
  return (
    <div aria-hidden className="pointer-events-none h-[120px] w-[160px] overflow-hidden rounded border border-neutral-200 bg-white">
      {live.data && (
        <iframe
          title="Theme thumbnail"
          tabIndex={-1}
          sandbox=""
          srcDoc={live.data}
          className="border-0"
          style={{ width: 640, height: 480, transform: "scale(0.25)", transformOrigin: "top left" }}
        />
      )}
    </div>
  );
}
