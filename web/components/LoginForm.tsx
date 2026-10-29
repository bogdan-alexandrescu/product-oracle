"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { Button, Chip, InfoTip, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, MOCK_MODE } from "@/lib/api/client";
import { MOCK_LOGIN } from "@/lib/api/mock/fixtures";
import { loadLanding } from "@/lib/experience";
import { safeNextPath } from "@/lib/safe-next";

/** Sign-in runs in the browser: without JavaScript, the card says so instead of waiting. */
export function NoScriptNote() {
  return (
    <noscript>
      <span className="mt-2 block text-text">Signing in needs JavaScript. Turn it on in your browser&apos;s settings, then reload this page.</span>
    </noscript>
  );
}

/** How long the session check may take before the form shows anyway. */
const CHECK_WAIT_MS = 10_000;

export function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // qa-shell-12: until the session check answers, no form to start typing into (a signed-in
  // person is sent on); it shows once the check says nobody is signed in, or cannot tell.
  const [checking, setChecking] = useState(true);
  // Only follow same-site paths (nothing is rendered from it, so the server pass may say /home).
  // Without one, the person's home: their saved mode's, else their role's (#723, D13).
  const target = !next
    ? null
    : typeof window === "undefined"
      ? "/home"
      : safeNextPath(next, window.location.origin);

  // Already signed in (e.g. by Google IAP in front of the app): skip the form. A5: a Google
  // sign-in that is not (yet) a member goes to /access, which says where it stands.
  useEffect(() => {
    let live = true;
    // A check that never answers still gives the form (fix2-shell review): after 10 s the
    // form shows; a later answer that someone is signed in still sends them on.
    const giveUp = setTimeout(() => live && setChecking(false), CHECK_WAIT_MS);
    api
      .GET("/v1/auth/access")
      .then(({ data }) => {
        if (!live) return false;
        if (
          data &&
          data.state !== "member" &&
          data.state !== "no_google_sign_in"
        ) {
          router.replace("/access");
          return false;
        }
        return true;
      })
      .catch(() => true)
      .then((ask) => (ask ? api.GET("/v1/me") : null))
      .then(async (res) => {
        if (!live) return;
        if (res === null) return; // Off to /access.
        if (!res?.response.ok) {
          setChecking(false);
          return;
        }
        const to = target ?? (await loadLanding());
        if (live) router.replace(to);
      })
      .catch(() => live && setChecking(false));
    return () => {
      live = false;
      clearTimeout(giveUp);
    };
  }, [router, target]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { error: err, response } = await api.POST("/v1/auth/login", {
        body: { email, password },
      });
      if (err || !response.ok) {
        setError(
          response.status === 401
            ? "Invalid email or password."
            : "Login failed.",
        );
        return;
      }
      router.push(target ?? (await loadLanding()));
    } catch {
      setError("Cannot reach the API.");
    } finally {
      setPending(false);
    }
  }

  const field = `${INPUT} h-10`;
  return (
    <AuthCard title="Sign in">
      {checking ? (
        <p
          role="status"
          data-testid="login-checking"
          className="py-6 text-center text-[15px] text-text2"
        >
          Checking your session…
          <NoScriptNote />
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-text2">
            Email
            <input
              type="email"
              name="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${field} font-normal`}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-text2">
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${field} font-normal`}
            />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            className="mt-1 w-full"
          >
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      )}
      {MOCK_MODE && !checking && (
        <div
          data-testid="mock-login"
          className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm"
        >
          <Chip kind="warn">Mock</Chip>
          <span className="min-w-0 font-mono text-[13px] break-all">
            {MOCK_LOGIN.email} / {MOCK_LOGIN.password}
          </span>
          <InfoTip label="Mock mode" side="top">
            To try a role, use approver@, commenter@ or viewer@example.com with
            the same password.
          </InfoTip>
        </div>
      )}
    </AuthCard>
  );
}
