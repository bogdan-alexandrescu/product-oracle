"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api } from "@/lib/api/client";

const ENDED = "This link has ended. Ask the person who sent it for a new one.";
/**
 * What an opened link's status says about it (qa-docs-71): the roadmap, the company and the
 * person who shared it, and the day it ends (`expires_on`, written by the API in the Company
 * time zone, as the page's footer: this page has no member's zone to read).
 */
type About = { title?: string | null; shared_by?: string | null; shared_by_name?: string | null; expires_at?: string | null; expires_on?: string | null };
type View =
  | { kind: "loading" }
  | { kind: "locked"; note: string | null }
  | { kind: "open"; html: string; download: boolean; about: About }
  | { kind: "ended" }
  | { kind: "error"; note: string };
/** The status once the passcode opened the link: allow_download and the rest come only then (never while locked). */
type Status = { state?: string; allow_download?: boolean } & About;

const path = (token: string) => ({ params: { path: { token } } });
const status = async (token: string) => (await api.GET("/v1/public/shares/{token}/status", path(token))).data as Status | undefined;

/**
 * The link holder's page (spec-O5 §3, owner answer O5-Q5): the passcode form until the
 * passcode opened the link in this browser, then the page the API rendered for the link's
 * audience, in a sandboxed frame (no script runs in it), with Download PDF when the link
 * allows downloads (its status's allow_download, owner decision 2026-10-26). Nothing names
 * the company before the passcode, and an ended link says only that it ended.
 */
export function SharedRoadmap({ token }: { token: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const id = useId();

  const show = async (res: Response, html: string | undefined, download: boolean, about: About = {}) => {
    if (res.ok && html) return setView({ kind: "open", html, download, about });
    if (res.status === 410) return setView({ kind: "ended" });
    if (res.status === 404) return setView({ kind: "locked", note: "That passcode did not open a link. Check it and the address, or ask the person who sent it." });
    if (res.status === 429) {
      const wait = Math.max(1, Math.ceil(Number(res.headers.get("Retry-After") ?? "60") / 60));
      return setView({ kind: "locked", note: `Too many tries. Try again in ${wait} minute${wait === 1 ? "" : "s"}.` });
    }
    if (res.status === 401) return setView({ kind: "locked", note: null });
    setView({ kind: "error", note: "Try again in a moment." });
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const now = await status(token);
      if (!alive) return;
      if (now?.state === "ended") return setView({ kind: "ended" });
      if (now?.state !== "active") return setView({ kind: "locked", note: null });
      const page = await api.GET("/v1/public/shares/{token}", { ...path(token), parseAs: "text" });
      if (alive) await show(page.response, page.data as string | undefined, now.allow_download === true, now);
    })().catch(() => alive && setView({ kind: "error", note: "Try again in a moment." }));
    return () => {
      alive = false;
    };
  }, [token]);

  // qa-docs-71: the browser tab names the roadmap once the link is open.
  // The title it had comes back when the page goes.
  const shownTitle = view.kind === "open" ? view.about.title : null;
  useEffect(() => {
    if (!shownTitle) return;
    const before = document.title;
    document.title = `${shownTitle} · Shared roadmap`;
    return () => {
      document.title = before;
    };
  }, [shownTitle]);

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // The right passcode sets this link's cookie; the API then answers with the page.
      const out = await api.POST("/v1/public/shares/{token}", { ...path(token), body: { passcode } as never, parseAs: "text" });
      // The cookie now opens the link: its status says whether it allows downloads.
      const now = out.response.ok ? await status(token) : undefined;
      await show(out.response, out.data as string | undefined, now?.allow_download === true, now ?? {});
      if (out.response.ok) setPasscode("");
    } catch {
      setView({ kind: "error", note: "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  const pdf = async () => {
    setDownload(null);
    const out = await api.GET("/v1/public/shares/{token}/pdf", { ...path(token), parseAs: "blob" });
    if (out.response.status === 410) return setView({ kind: "ended" });
    if (!out.response.ok || !(out.data instanceof Blob)) {
      return setDownload(out.response.status === 404 ? "Downloads are off for this link." : out.response.status === 429 ? "Too many downloads. Try again later." : "Try again in a moment.");
    }
    const url = URL.createObjectURL(out.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "roadmap.pdf";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (view.kind === "open") {
    const { title, expires_on } = view.about;
    const who = sharedBy(view.about);
    // qa-docs-70: the shared page is the company's light document, so the bar is light too
    // (fixed colours, whatever the app's theme), and the frame grows to its content: one scroll.
    return (
      <main className="flex min-h-dvh flex-col text-[#0f172a]" style={{ colorScheme: "light", backgroundColor: "#ffffff" }} data-testid="shared-page">
        <header
          data-testid="shared-header"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#e2e8f0] px-4 py-3"
          style={{ backgroundColor: "#ffffff" }}
        >
          <div className="min-w-0 flex-1">
            {title && <h1 className="font-display text-xl font-bold tracking-heading break-words">{title}</h1>}
            {(who || expires_on) && (
              <p className="text-sm text-[#475569]" data-testid="shared-about">
                {[who ? `Shared by ${who}` : null, expires_on ? `Link ends ${expires_on}` : null].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          {download && (
            <span role="status" className="text-sm text-[#475569]">
              {download}
            </span>
          )}
          {/* qa-docs-1: fixed light colours (bg-white follows the app's dark theme). */}
          {view.download && (
            <button
              type="button"
              onClick={pdf}
              className="inline-flex h-10 items-center rounded-button border border-[#cbd5e1] bg-[#ffffff] px-4 font-semibold text-[#0f172a] hover:bg-[#f1f5f9]"
            >
              Download PDF
            </button>
          )}
        </header>
        {/* qa-docs-26: the page keeps the header's side margins; its tables never touch the window's edge. */}
        <div data-testid="shared-body" className="px-4">
          <Frame title="Shared roadmap" html={view.html} />
        </div>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      {view.kind === "loading" && <p className="text-text2">Opening…</p>}
      {view.kind === "ended" && <p className="text-lg">{ENDED}</p>}
      {view.kind === "error" && <p role="alert">{view.note}</p>}
      {view.kind === "locked" && (
        <form onSubmit={unlock} className="space-y-4">
          <h1 className="font-display text-2xl font-bold tracking-heading">Enter the passcode</h1>
          <p className="text-text2">This page is private. Enter the passcode the person who sent you this link gave you.</p>
          {view.note && (
            <p role="alert" className="font-semibold">
              {view.note.split(". ")[0]}.
              <span className="block font-normal text-text2">{view.note.split(". ").slice(1).join(". ")}</span>
            </p>
          )}
          <div>
            <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold text-text2">
              Passcode
            </label>
            <input id={id} type="password" autoComplete="off" required maxLength={128} autoFocus className={INPUT} value={passcode} onChange={(e) => setPasscode(e.target.value)} />
          </div>
          <Button variant="primary" type="submit" disabled={busy || !passcode}>
            Open
          </Button>
        </form>
      )}
    </main>
  );
}

/** "Ann Lee at Example Labs": the person who made the link (qa-docs-71), and their company. */
function sharedBy({ shared_by, shared_by_name }: About): string | null {
  if (shared_by_name && shared_by) return `${shared_by_name} at ${shared_by}`;
  return shared_by_name || shared_by || null;
}

/**
 * The API's page in a sandboxed frame: no script runs in it (no allow-scripts); same origin
 * only so this page can read its height and grow the frame to it (qa-docs-70: one scroll).
 */
function Frame({ title, html }: { title: string; html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    // The content's own height: the frame is squeezed to nothing for the reading (and
    // set back before anything paints), so the page's scrollHeight is its content, not the
    // frame's last height. Then it shrinks when the window widens, and a page sized in vh
    // does not grow with the frame without end.
    const fit = () => {
      const frame = ref.current;
      const doc = frame?.contentDocument;
      if (!frame || !doc?.documentElement) return;
      const was = frame.style.height;
      frame.style.height = "0px";
      const content = doc.documentElement.scrollHeight;
      frame.style.height = was;
      setHeight(content);
    };
    // The frame may load before React listens to it: fit once it is there, and as it grows.
    const el = ref.current;
    let watch: ResizeObserver | null = null;
    const attach = () => {
      const body = el?.contentDocument?.body;
      if (!body) return;
      fit();
      watch?.disconnect();
      watch = new ResizeObserver(fit);
      watch.observe(body);
    };
    attach();
    el?.addEventListener("load", attach);
    window.addEventListener("resize", fit);
    return () => {
      watch?.disconnect();
      el?.removeEventListener("load", attach);
      window.removeEventListener("resize", fit);
    };
  }, [html]);
  return (
    // allow-same-origin is safe only while there is no allow-scripts: with both, the
    // page could reach into this one and take the sandbox off (qa-docs-share.spec pins it).
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={html}
      scrolling="no"
      data-testid="shared-frame"
      className="block w-full border-0"
      style={{ backgroundColor: "#ffffff", ...(height != null ? { height } : { minHeight: "80dvh" }) }}
    />
  );
}
