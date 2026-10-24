"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { Field, TEXTAREA } from "@/app/settings/_components/fields";
import { Button, Notice } from "@/components/ds";
import { api, MOCK_MODE, type Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { errorMessage } from "@/lib/use-query";

type Access = Schemas["AccessStateOut"];
type State = Access["state"];

/** How often a pending request looks again (3.10: the page updates by itself). */
const POLL_MS = 30_000;
const NOTE_MAX = 500;

const TITLE: Partial<Record<State, string>> = {
  pending: "Waiting for an owner",
  approved: "You're in",
  declined: "An owner declined your request",
  invite_expired: "Your invite expired",
  invite_only: "This Oracle is invite only",
  outside_domains: "Use your work account",
  removed: "You were removed",
};

function body(a: Access): string {
  const email = a.email ?? "your address";
  switch (a.state) {
    case "pending":
      return `You asked to join ${a.company ?? "this company"}'s Product Oracle as ${email}. An owner will approve or decline your request. This page updates by itself.`;
    case "approved":
      return "Opening Oracle…";
    case "declined":
      return `If you think this is a mistake, ask an owner to invite ${email}.`;
    case "invite_expired":
      return `It expired${a.invite_expired_at ? ` on ${formatDay(a.invite_expired_at)}` : ""}. Ask the person who invited you to resend it.`;
    case "invite_only":
      return `Ask an owner to invite ${email}.`;
    case "outside_domains":
      return `${email} isn't from this company's email domains, so it can't join this Oracle.`;
    case "removed":
      return "An owner removed you from this Oracle. Ask an owner to restore you.";
    default:
      return "";
  }
}

/**
 * Where a Google sign-in that is not a member stands (A5, 3.10), outside the app shell like
 * /login: waiting for an owner (with a note for them), declined, an expired invite, invite
 * only, outside the company's domains, or removed. Members and password sign-in go on to Oracle.
 */
export default function AccessPage() {
  const router = useRouter();
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let live = true;
    const look = () =>
      api.GET("/v1/auth/access").then(
        ({ data, response }) => {
          if (!live) return;
          if (!data) return setError(response.statusText || "Can't read your access");
          if (data.state === "member" || data.state === "no_google_sign_in") return router.replace("/login");
          setAccess(data);
          // Approved: on into Oracle with a full load (the session is new).
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          if (data.state === "approved") window.location.assign("/");
        },
        (e) => live && setError(errorMessage(e)),
      );
    void look();
    const t = setInterval(() => void look(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [router]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const { data, response } = await api.POST("/v1/auth/access/note", { body: { note: note.trim() || null } });
      if (!response.ok || !data) throw new Error(response.statusText || "Couldn't send the note");
      setAccess(data);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function signOut() {
    await api.POST("/v1/auth/logout").catch(() => undefined);
    // Google sign-in in front of Oracle: ask it to clear its own cookie, which leads to
    // Google's account chooser. The mock has no Google in front: back to sign-in.
    if (MOCK_MODE) return router.push("/login");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/?gcp-iap-mode=CLEAR_LOGIN_COOKIE");
  }

  const state = access?.state;
  const out = (
    <Button variant="secondary" icon="signout" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
  return (
    <AuthCard title={(state && TITLE[state]) || "Access"} testId="access-page">
      <div data-testid="access-state" data-state={state} className="flex flex-col gap-4 text-[15px] leading-[22px]">
        {error && <Notice tone="error">{error}</Notice>}
        {!access && !error && <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />}
        {access && <p data-testid="access-body">{body(access)}</p>}
        {state === "pending" && (
          <>
            <form onSubmit={send} aria-label="Note for the owner" className="flex flex-col gap-2">
              <Field label="Add a note for the owner (optional)">
                <textarea
                  rows={3}
                  maxLength={NOTE_MAX}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setSent(false);
                  }}
                  className={TEXTAREA}
                />
              </Field>
              <div>
                <Button type="submit" variant="solid" disabled={sending || sent}>
                  {sending ? "Sending…" : sent ? "Sent" : "Send note"}
                </Button>
              </div>
            </form>
            <p className="flex flex-wrap items-center gap-2 text-text2">
              Signed in with the wrong Google account? {out}
            </p>
          </>
        )}
        {state && state !== "pending" && state !== "approved" && <div>{out}</div>}
      </div>
    </AuthCard>
  );
}
