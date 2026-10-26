"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api } from "@/lib/api/client";

const ENDED = "This link has ended. Ask the person who sent it for a new one.";
type View = { kind: "loading" } | { kind: "locked"; note: string | null } | { kind: "open"; html: string; download: boolean } | { kind: "ended" } | { kind: "error"; note: string };
/** The status once the passcode opened the link: allow_download comes only then (never while locked). */
type Status = { state?: string; allow_download?: boolean };

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

  const show = async (res: Response, html: string | undefined, download: boolean) => {
    if (res.ok && html) return setView({ kind: "open", html, download });
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
      if (alive) await show(page.response, page.data as string | undefined, now.allow_download === true);
    })().catch(() => alive && setView({ kind: "error", note: "Try again in a moment." }));
    return () => {
      alive = false;
    };
  }, [token]);

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // The right passcode sets this link's cookie; the API then answers with the page.
      const out = await api.POST("/v1/public/shares/{token}", { ...path(token), body: { passcode } as never, parseAs: "text" });
      // The cookie now opens the link: its status says whether it allows downloads.
      const download = out.response.ok ? (await status(token))?.allow_download === true : false;
      await show(out.response, out.data as string | undefined, download);
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
    return (
      <main className="flex min-h-dvh flex-col bg-surface">
        <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line px-4 py-2">
          {download && (
            <span role="status" className="text-sm text-text2">
              {download}
            </span>
          )}
          {view.download && <Button onClick={pdf}>Download PDF</Button>}
        </div>
        <iframe title="Shared roadmap" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={view.html} className="w-full flex-1 border-0 bg-white" style={{ minHeight: "80dvh" }} />
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
