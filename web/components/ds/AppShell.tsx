"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { api, MOCK_MODE } from "@/lib/api/client";
import { resetMockData } from "@/lib/api/mock/server";
import { useMe } from "@/lib/me";
import { useTheme, type ThemeChoice } from "@/lib/theme";

import { initialsOf } from "./Figures";
import { Icon, type IconName } from "./Icon";

type Dest = { label: string; href: string; icon: IconName; testId: string; match?: string };

/** The nine destinations (I3), in rail order. */
export const DESTINATIONS: Dest[] = [
  { label: "Home", href: "/home", icon: "home", testId: "nav-home" },
  { label: "Requests", href: "/requests", icon: "requests", testId: "nav-requests" },
  { label: "Baseline", href: "/baseline", icon: "baseline", testId: "nav-baseline" },
  { label: "PRDs", href: "/documents", icon: "prds", testId: "nav-prds" },
  { label: "Priorities", href: "/priorities", icon: "priorities", testId: "nav-priorities" },
  { label: "Roadmap", href: "/roadmap", icon: "roadmap", testId: "nav-roadmap" },
  { label: "Runs", href: "/runs", icon: "runs", testId: "nav-runs" },
  { label: "Inbox", href: "/inbox", icon: "inbox", testId: "nav-inbox" },
];
const SETTINGS: Dest = { label: "Settings", href: "/settings/members", icon: "settings", testId: "nav-settings", match: "/settings" };

/** Phone tab bar: Home, PRDs, Roadmap, Inbox, More. */
const TABS = ["Home", "PRDs", "Roadmap", "Inbox"];

function isActive(pathname: string, d: Dest): boolean {
  const base = d.match ?? d.href;
  // /sources (evidence search) lives under Settings › Sources.
  if (d === SETTINGS && pathname.startsWith("/sources")) return true;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Inbox count for the badge, re-read on every navigation. */
function useInboxCount(enabled: boolean): number | null {
  const pathname = usePathname();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .GET("/v1/inbox")
      .then((r) => alive && r.response.ok && setN(r.data?.total ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, pathname]);
  return n;
}

function Badge({ n, testId }: { n: number | null; testId?: string }) {
  if (!n) return null;
  return (
    <span
      data-testid={testId}
      aria-label={`${n} waiting`}
      className="tnum absolute top-0.5 right-3 h-5 min-w-5 rounded-[10px] bg-lime px-[5px] text-center text-[13px] leading-5 font-semibold text-on-lime max-[600px]:right-auto max-[600px]:left-[calc(50%+6px)]"
    >
      {n}
    </span>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** The user menu: who is signed in, the theme switch, mock reset, sign out. */
function UserMenu({ placement }: { placement: "rail" | "sheet" }) {
  const router = useRouter();
  const { me, clear } = useMe();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(placement === "sheet");
  const root = useRef<HTMLDivElement>(null);
  const email = me?.email ?? me?.token_name ?? "";

  useEffect(() => {
    if (!open || placement === "sheet") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, placement]);

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

  const initials = initialsOf(email);

  const panel = (
    <div
      role={placement === "rail" ? "dialog" : undefined}
      aria-label="Account"
      className={
        placement === "rail"
          ? "absolute bottom-0 left-[calc(100%+12px)] z-50 w-72 rounded-panel border border-line bg-surface p-3 text-text shadow-tip"
          : "border-t border-line pt-3"
      }
    >
      <p className="mb-3 truncate px-1 text-sm font-medium" data-testid={placement === "rail" ? undefined : "signed-in-as-sheet"}>
        {email}
      </p>
      <div role="radiogroup" aria-label="Theme" className="mb-3 grid grid-cols-3 overflow-hidden rounded-button border border-line-strong">
        {THEMES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={theme === t.value}
            data-testid={`theme-${t.value}`}
            onClick={() => setTheme(t.value)}
            className={`flex h-9 items-center justify-center gap-1.5 border-r border-line text-sm font-medium last:border-r-0 ${
              theme === t.value ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            }`}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>
      {MOCK_MODE && (
        <button
          type="button"
          title="NEXT_PUBLIC_API_MOCKS=1: data comes from in-browser fixtures"
          onClick={() => {
            resetMockData();
            // Full reload on purpose: every view re-reads the freshly seeded state.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.assign("/login");
          }}
          className="mb-1 flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-text hover:bg-surface2"
        >
          <span className="rounded border border-dashed border-line-strong px-1.5 text-[13px] text-text2">Mock data</span>
          Reset
        </button>
      )}
      <button
        type="button"
        onClick={signOut}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-text hover:bg-surface2"
      >
        <Icon name="signout" size={16} />
        Sign out
      </button>
    </div>
  );

  if (placement === "sheet") return panel;
  return (
    <div ref={root} className="relative mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Account ${email}`}
        title={email}
        data-testid="user-menu"
        onClick={() => setOpen((o) => !o)}
        className="grid size-[38px] place-items-center rounded-full bg-accent text-sm font-semibold text-on-accent"
      >
        {initials}
        <span className="sr-only" data-testid="signed-in-as">
          {email}
        </span>
      </button>
      {open && panel}
    </div>
  );
}

function RailLink({ d, pathname, badge }: { d: Dest; pathname: string; badge?: number | null }) {
  const active = isActive(pathname, d);
  return (
    <Link
      href={d.href}
      data-testid={d.testId}
      aria-current={active ? "page" : undefined}
      className={`relative flex w-[78px] flex-col items-center gap-0.5 rounded-xl pt-[7px] pb-1.5 text-[13px] leading-4 ${
        active ? "bg-nav-active font-semibold text-nav-active-text" : "font-medium text-nav-text hover:bg-hero-2"
      }`}
    >
      <Icon name={d.icon} />
      {d.label}
      {badge !== undefined && <Badge n={badge} testId={`${d.testId}-badge`} />}
    </Link>
  );
}

/** Rail and tab bar; reads the pathname, so it renders inside its own Suspense boundary. */
function Navs() {
  const pathname = usePathname();
  const { me, loading } = useMe();
  // While /v1/me loads, keep the rail so a signed-in page never jumps.
  const shown = (loading || !!me) && !pathname.startsWith("/login") && !pathname.startsWith("/oauth");
  const inbox = useInboxCount(shown);
  const [more, setMore] = useState(false);
  // Close the More sheet on navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMore(false);
  }
  if (!shown) return null;

  const tabDests = TABS.map((t) => DESTINATIONS.find((d) => d.label === t)!);
  const moreDests = [...DESTINATIONS.filter((d) => !TABS.includes(d.label)), SETTINGS];
  const moreActive = moreDests.some((d) => isActive(pathname, d));

  return (
    <>
      <nav
        aria-label="Oracle"
        data-testid="app-nav"
        className="sticky top-0 col-start-1 row-start-1 flex h-dvh w-[88px] flex-col items-center gap-0.5 bg-nav py-3.5 max-[600px]:hidden"
      >
        <Link
          href="/home"
          aria-label="Product Oracle"
          className="mb-3 grid size-10 flex-none place-items-center rounded-xl bg-lime font-display text-[19px] font-bold text-on-lime"
        >
          Q
        </Link>
        {DESTINATIONS.map((d) => (
          <RailLink key={d.href} d={d} pathname={pathname} badge={d.label === "Inbox" ? inbox : undefined} />
        ))}
        <span className="flex-1" />
        <RailLink d={SETTINGS} pathname={pathname} />
        <UserMenu placement="rail" />
      </nav>

      <nav
        aria-label="Oracle"
        data-testid="tab-bar"
        className="fixed inset-x-0 bottom-0 z-40 hidden h-[68px] grid-cols-5 bg-nav px-1.5 pt-1.5 pb-2 max-[600px]:grid"
      >
        {tabDests.map((d) => {
          const active = isActive(pathname, d) && !more;
          return (
            <Link
              key={d.href}
              href={d.href}
              data-testid={`tab-${d.testId.slice(4)}`}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-[3px] rounded-xl text-[13px] leading-4 ${
                active ? "bg-nav-active font-semibold text-nav-active-text" : "font-medium text-nav-text"
              }`}
            >
              <Icon name={d.icon} />
              <span>{d.label}</span>
              {d.label === "Inbox" && <Badge n={inbox} />}
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={more}
          aria-controls="more-sheet"
          data-testid="tab-more"
          onClick={() => setMore((m) => !m)}
          className={`relative flex flex-col items-center justify-center gap-[3px] rounded-xl text-[13px] leading-4 ${
            more || moreActive ? "bg-nav-active font-semibold text-nav-active-text" : "font-medium text-nav-text"
          }`}
        >
          <Icon name="more" />
          More
        </button>
      </nav>
      {more && (
        <div
          id="more-sheet"
          role="dialog"
          aria-label="More"
          className="fixed inset-x-0 bottom-[68px] z-40 hidden rounded-t-inspector border-t border-line bg-surface p-3 shadow-tip max-[600px]:block"
        >
          <ul className="mb-2 grid grid-cols-3 gap-1">
            {moreDests.map((d) => (
              <li key={d.href}>
                <Link
                  href={d.href}
                  aria-current={isActive(pathname, d) ? "page" : undefined}
                  className="flex flex-col items-center gap-1 rounded-xl py-2.5 text-sm font-medium text-text hover:bg-surface2 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
                >
                  <Icon name={d.icon} />
                  {d.label}
                </Link>
              </li>
            ))}
          </ul>
          <UserMenu placement="sheet" />
        </div>
      )}
    </>
  );
}

/**
 * The app shell (I3): a dark rail with the nine destinations on desktop, a tab bar
 * (Home, PRDs, Roadmap, Inbox, More) on a phone. No rail on /login, /oauth and when
 * signed out: its grid column then collapses to nothing.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-[auto_minmax(0,1fr)]">
      <Suspense fallback={null}>
        <Navs />
      </Suspense>
      <main className="col-start-2 row-start-1 min-w-0">{children}</main>
    </div>
  );
}
