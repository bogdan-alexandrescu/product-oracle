"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { Button, Chip, InfoTip, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, MOCK_MODE } from "@/lib/api/client";
import { MOCK_LOGIN } from "@/lib/api/mock/fixtures";
import { safeNextPath } from "@/lib/safe-next";

export function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Only follow same-site paths (nothing is rendered from it, so the server pass may say /home).
  const target = typeof window === "undefined" ? "/home" : safeNextPath(next, window.location.origin);

  // Already signed in (e.g. by Google IAP in front of the app): skip the form.
  useEffect(() => {
    let live = true;
    api
      .GET("/v1/me")
      .then(({ response }) => live && response.ok && router.replace(target))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [router, target]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { error: err, response } = await api.POST("/v1/auth/login", { body: { email, password } });
      if (err || !response.ok) {
        setError(response.status === 401 ? "Invalid email or password." : "Login failed.");
        return;
      }
      router.push(target);
    } catch {
      setError("Cannot reach the API.");
    } finally {
      setPending(false);
    }
  }

  const field = `${INPUT} h-10`;
  return (
    <AuthCard title="Sign in">
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
        <Button type="submit" variant="primary" disabled={pending} className="mt-1 w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {MOCK_MODE && (
        <div data-testid="mock-login" className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
          <Chip kind="warn">Mock</Chip>
          <span className="min-w-0 font-mono text-[13px] break-all">
            {MOCK_LOGIN.email} / {MOCK_LOGIN.password}
          </span>
          <InfoTip label="Mock mode" side="top">
            To try a role, use approver@, commenter@ or viewer@example.com with the same password.
          </InfoTip>
        </div>
      )}
    </AuthCard>
  );
}
