"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

const ENDED = "This link has ended. Ask the person who sent it for a new one.";
const NOT_OPENED = "That did not open the link. The passcode may be wrong, or the link may have ended. Check the passcode and the address, or ask the person who sent it.";

/** "Platform roadmap, autumn - Oct 31, 2026.pdf": the roadmap's name and today's date. */
function pdfName(title: string | null | undefined): string {
  const name = (title ?? "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Roadmap";
  return `${name} - ${formatDate(new Date().toISOString())}.pdf`;
}

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
    // qa4-docs-share-31: the API answers a wrong passcode and an ended link alike (it never
    // says which), so the note blames neither the passcode alone nor the person.
    if (res.status === 404) return setView({ kind: "locked", note: NOT_OPENED });
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
    // qa4-docs-share-25: named after the roadmap and the day it was saved.
    a.download = pdfName(view.kind === "open" ? view.about.title : null);
    a.click();
    URL.revokeObjectURL(url);
  };

  if (view.kind === "open") {
    const { title, expires_on } = view.about;
    const who = sharedBy(view.about);
    // qa-docs-11: the page follows the reader's light or dark preference, as the page in its
    // frame does (the API's reader styles), and the frame grows to its content: one scroll.
    // qa-docs-70: header and page sit in one inset column, so Download PDF never touches the edge.
    return (
      <main
        className="flex min-h-dvh flex-col bg-[#ffffff] text-[#0f172a] dark:bg-[#0f172a] dark:text-[#e2e8f0]"
        style={{ colorScheme: "light dark" }}
        data-testid="shared-page"
      >
        <header data-testid="shared-header" className="border-b border-[#e2e8f0] bg-[#ffffff] px-6 py-3 dark:border-[#334155] dark:bg-[#0f172a]">
          {/* qa4-docs-share-26: on a phone the title has the row; Download PDF goes under it. */}
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 max-[600px]:flex-col max-[600px]:items-start">
            <div className="min-w-0 flex-1 max-[600px]:w-full max-[600px]:flex-none">
              {title && <h1 className="font-display text-xl font-bold tracking-heading break-words">{title}</h1>}
              {(who || expires_on) && (
                <p className="text-sm text-[#475569] dark:text-[#94a3b8]" data-testid="shared-about">
                  {/* qa4-docs-share-26: each part on its own line on a phone, so no line starts with "·". */}
                  {[who ? `Shared by ${who}` : null, expires_on ? `Link ends ${expires_on}` : null]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i} className="max-[600px]:block">
                        {i > 0 && <span className="max-[600px]:hidden"> · </span>}
                        {part}
                      </span>
                    ))}
                </p>
              )}
            </div>
            {download && (
              <span role="status" className="text-sm text-[#475569] dark:text-[#94a3b8]">
                {download}
              </span>
            )}
            {/* qa-docs-1, qa-docs-11: fixed colours per scheme, as the page in the frame. */}
            {view.download && (
              <button
                type="button"
                onClick={pdf}
                className="inline-flex h-10 items-center rounded-button border border-[#cbd5e1] bg-[#ffffff] px-4 font-semibold text-[#0f172a] hover:bg-[#f1f5f9] dark:border-[#475569] dark:bg-[#1e293b] dark:text-[#e2e8f0] dark:hover:bg-[#334155]"
              >
                Download PDF
              </button>
            )}
          </div>
        </header>
        {/* qa-docs-26: the page keeps the header's side margins; its tables never touch the window's edge. */}
        <div data-testid="shared-body" className="px-6">
          <div className="mx-auto w-full max-w-6xl">
            <Frame title="Shared roadmap" html={view.html} />
          </div>
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
          {/* qa-docs-71: who shared what stays unsaid until the passcode (spec-O5 Q5: nothing before it). */}
          <p className="text-text2">Someone shared a private roadmap with you. It opens with the passcode they gave you.</p>
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
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" type="submit" disabled={busy || !passcode} aria-describedby={!passcode ? `${id}-why` : undefined}>
              Open
            </Button>
            {/* qa-docs-71: a greyed Open says why. */}
            {!passcode && (
              <span id={`${id}-why`} data-testid="passcode-why" className="text-sm text-text2">
                Enter the passcode first
              </span>
            )}
          </div>
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
      style={{ backgroundColor: "transparent", colorScheme: "light dark", ...(height != null ? { height } : { minHeight: "80dvh" }) }}
    />
  );
}
