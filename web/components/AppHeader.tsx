"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { api, MOCK_MODE } from "@/lib/api/client";
import { resetMockData } from "@/lib/api/mock/server";
import { useMe } from "@/lib/me";

export function AppHeader() {
  const router = useRouter();
  const { me, clear } = useMe();
  const email = me?.email ?? me?.token_name ?? null;

  async function signOut() {
    await api.POST("/v1/auth/logout").catch(() => undefined);
    // Still signed in after dropping the session cookie: Google IAP signs this browser
    // in. Ask IAP to clear its own cookie, which leads to Google's sign-in.
    const still = await api.GET("/v1/me").catch(() => undefined);
    if (still?.response.ok) {
      // A full page load on purpose: IAP answers this URL, it never reaches Next.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/?gcp-iap-mode=CLEAR_LOGIN_COOKIE");
      return;
    }
    clear();
    router.push("/login");
  }

  return (
    <HeaderShell>
      {MOCK_MODE && (
        <span className="flex items-center gap-2 text-xs text-neutral-500" title="NEXT_PUBLIC_API_MOCKS=1: data comes from in-browser fixtures">
          <span className="rounded border border-dashed border-neutral-300 px-1.5 py-0.5">Mock data</span>
          <button
            type="button"
            className="underline-offset-2 hover:text-neutral-900 hover:underline"
            onClick={() => {
              resetMockData();
              // Full reload on purpose: every view re-reads the freshly seeded state.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/login");
            }}
          >
            Reset
          </button>
        </span>
      )}
      {email && <UserMenu email={email} isUser={me?.kind === "user"} onSignOut={signOut} />}
    </HeaderShell>
  );
}

/**
 * The user menu: who is signed in, My account (people only: a service token has no
 * account) and Sign out. Mirrors the design system's AppShell menu on main.
 */
function UserMenu({ email, isUser, onSignOut }: { email: string; isUser: boolean; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const item = "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-text hover:bg-surface2";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Account ${email}`}
        data-testid="user-menu"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-text2 hover:bg-surface2 hover:text-text"
      >
        <span data-testid="signed-in-as">{email}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Account"
          className="absolute top-[calc(100%+6px)] right-0 z-50 w-64 rounded-panel border border-line bg-surface p-2 text-left text-text shadow-tip"
        >
          <p className="truncate px-2 pt-1 pb-2 text-[13px] text-text2">{email}</p>
          {isUser && (
            <Link href="/account" className={item} onClick={() => setOpen(false)} data-testid="nav-my-account">
              My account
            </Link>
          )}
          <button type="button" className={item} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function HeaderShell({ children }: { children?: React.ReactNode }) {
  return (
    <header className="border-b border-line bg-surface">
      <nav className="mx-auto flex h-12 max-w-[1400px] items-center gap-6 px-6">
        <Link href="/documents" className="font-semibold tracking-tight text-text">
          Product Oracle
        </Link>
        <div className="ml-auto flex items-center gap-4">{children}</div>
      </nav>
    </header>
  );
}
