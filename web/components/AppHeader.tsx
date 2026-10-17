"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, MOCK_MODE } from "@/lib/api/client";
import { resetMockData } from "@/lib/api/mock/server";

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .GET("/v1/me")
      .then(({ data }) => live && setEmail(data?.email ?? data?.token_name ?? null))
      .catch(() => live && setEmail(null));
    return () => {
      live = false;
    };
  }, [pathname]);

  async function signOut() {
    await api.POST("/v1/auth/logout").catch(() => undefined);
    setEmail(null);
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
      {email && (
        <span className="flex items-center gap-3 text-sm">
          <span className="text-neutral-500" data-testid="signed-in-as">
            {email}
          </span>
          <button type="button" onClick={signOut} className="text-neutral-600 hover:text-neutral-900">
            Sign out
          </button>
        </span>
      )}
    </HeaderShell>
  );
}

export function HeaderShell({ children }: { children?: React.ReactNode }) {
  return (
    <header className="border-b border-neutral-200 bg-white">
      <nav className="mx-auto flex h-12 max-w-[1400px] items-center gap-6 px-6">
        <Link href="/documents" className="font-semibold tracking-tight text-neutral-900">
          Product Oracle
        </Link>
        <Link href="/documents" className="text-sm text-neutral-600 hover:text-neutral-900">
          Documents
        </Link>
        <div className="ml-auto flex items-center gap-4">{children}</div>
      </nav>
    </header>
  );
}
