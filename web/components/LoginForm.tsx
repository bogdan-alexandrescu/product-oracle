"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui";
import { api, MOCK_MODE } from "@/lib/api/client";
import { MOCK_LOGIN } from "@/lib/api/mock/fixtures";

export function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Only follow same-site paths.
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/documents";

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

  const field = "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900";
  return (
    <div className="mx-auto mt-20 max-w-sm px-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mb-6 text-sm text-neutral-500">Review PRD drafts produced by the agent track.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-neutral-700">
          Email
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-neutral-700">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={pending} className="py-2">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {MOCK_MODE && (
        <p className="mt-6 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500">
          Mock mode: sign in with <span className="font-mono">{MOCK_LOGIN.email}</span> /{" "}
          <span className="font-mono">{MOCK_LOGIN.password}</span>. To try a role, use approver@, commenter@ or
          viewer@example.com with the same password.
        </p>
      )}
    </div>
  );
}
