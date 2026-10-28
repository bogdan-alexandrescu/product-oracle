"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { HopPanel } from "@/components/hop/HopPanel";
import { SIMPLE_DESTINATIONS, SimpleNavs } from "@/components/simple/SimpleShell";
import { setPanelOpen, usePanelOpen } from "@/components/hop/open-state";
import { api, MOCK_MODE } from "@/lib/api/client";
import { homeOf, modeOf } from "@/lib/experience";
import { resetMockData } from "@/lib/api/mock/server";
import { useMe } from "@/lib/me";
import { useSettingsTabs } from "@/lib/settings-tabs";
import { loadInbox, loadMyQuestions, onWaitingChanged, waitingCount } from "@/lib/waiting";
import { ScreenSubjectProvider } from "@/lib/screen-subject";
import { useTheme, type ThemeChoice } from "@/lib/theme";

import { Mark } from "./Brand";
import { ConfirmHost } from "./ConfirmDialog";
import { ToastHost } from "./Toast";
import { initialsOf } from "./Figures";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { Notice } from "./Layout";
import { ModeRoot, ModeSwitch } from "./ModeSwitch";
import { RAIL_SELECTED, TAB_BAR } from "./rail";
import { Sheet } from "./Sheet";

type Dest = { label: string; href: string; icon: IconName; testId: string; match?: string };

/**
 * The destinations (I3), in rail order. Company (H1, owner 2026-10-21 "New pages") groups
 * Strategy, Decisions, Rituals and Updates; it sits after Inbox, just above Settings (owner,
 * 2026-10-21, "Rail order").
 */
export const DESTINATIONS: Dest[] = [
  { label: "Home", href: "/home", icon: "home", testId: "nav-home" },
  { label: "Requests", href: "/requests", icon: "requests", testId: "nav-requests" },
  { label: "Baseline", href: "/baseline", icon: "baseline", testId: "nav-baseline" },
  { label: "PRDs", href: "/documents", icon: "prds", testId: "nav-prds" },
  { label: "Priorities", href: "/priorities", icon: "priorities", testId: "nav-priorities" },
  { label: "Plan", href: "/plan", icon: "roadmap", testId: "nav-plan" },
  { label: "Runs", href: "/runs", icon: "runs", testId: "nav-runs" },
  { label: "Inbox", href: "/inbox", icon: "inbox", testId: "nav-inbox" },
  { label: "Company", href: "/company", icon: "company", testId: "nav-company" },
];
const SETTINGS: Dest = { label: "Settings", href: "/settings", icon: "settings", testId: "nav-settings", match: "/settings" };

/** Phone tab bar: Home, PRDs, Plan, Inbox, More. */
const TABS = ["Home", "PRDs", "Plan", "Inbox"];

/*
 * The destination a document belongs to (UI test finding E2): every kind's pages are
 * /documents/<slug>/…, so the URL alone says PRDs. A document page names its list once it
 * knows the document's kind (Plan for a roadmap, Company › Updates for an update), per slug; a slug's kind never changes,
 * so later pages of the same document highlight the right item from their first paint.
 */
const documentHomes = new Map<string, string>();
let documentHomesVersion = 0;
const documentHomesListeners = new Set<() => void>();

function subscribeDocumentHomes(listener: () => void) {
  documentHomesListeners.add(listener);
  return () => {
    documentHomesListeners.delete(listener);
  };
}

/** A document page says which destination it belongs to (`href`, e.g. "/plan", or "/company/strategy" for a vision or strategy). */
export function useDocumentDestination(slug: string | undefined, href: string | undefined) {
  useLayoutEffect(() => {
    if (!slug || !href || documentHomes.get(slug) === href) return;
    documentHomes.set(slug, href);
    documentHomesVersion += 1;
    documentHomesListeners.forEach((listener) => listener());
  }, [slug, href]);
}

/** The destination the open document page belongs to, once it has said so. */
function useDocumentHome(pathname: string): string | undefined {
  useSyncExternalStore(
    subscribeDocumentHomes,
    () => documentHomesVersion,
    () => 0,
  );
  const slug = /^\/documents\/([^/]+)/.exec(pathname)?.[1];
  return slug ? documentHomes.get(decodeURIComponent(slug)) : undefined;
}

function isActive(pathname: string, d: Dest, home?: string): boolean {
  // A document page: the list its document belongs to (Company for /company/strategy and for an update's, /company/updates).
  if (home) return d.href === home || home.startsWith(`${d.href}/`);
  const base = d.match ?? d.href;
  // /sources (evidence search) lives under Settings › Sources.
  if (d.testId === SETTINGS.testId && pathname.startsWith("/sources")) return true;
  // A brief before drafting (C5) is on its way to a PRD.
  if (d.href === "/documents" && pathname.startsWith("/intakes/")) return true;
  // A spec's flows and wireframes (v2 screen 4) belong with its tech brief, a document.
  if (d.href === "/documents" && pathname.startsWith("/specs/")) return true;
  // The Plan's alignment reports (F6) belong with the Roadmap.
  if (d.href === "/roadmap" && (pathname === "/plan" || pathname.startsWith("/plan/"))) return true;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * The badge: what waits on me, the Inbox's rows and the questions asked of me (I3), as Home
 * and /inbox count them. Re-read on every navigation and after an action (lib/waiting).
 */
function useInboxCount(enabled: boolean): number | null {
  const pathname = usePathname();
  const [n, setN] = useState<number | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => onWaitingChanged(() => setChanges((c) => c + 1)), []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    Promise.all([loadInbox(), loadMyQuestions().catch(() => [])])
      .then(([inbox, questions]) => alive && setN(waitingCount(inbox, questions)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, pathname, changes]);
  return n;
}

function Badge({ n, testId }: { n: number | null; testId?: string }) {
  if (!n) return null;
  return (
    <span
      data-testid={testId}
      aria-label={`${n} waiting`}
      className="tnum absolute top-1 right-1.5 h-4 min-w-4 rounded-lg bg-rail-badge px-1 text-center font-mono text-[13px] leading-4 font-semibold text-on-rail-badge max-[600px]:right-auto max-[600px]:left-[calc(50%+6px)]"
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

/** The user menu: who is signed in, the theme switch, My account, mock reset, sign out. */
function UserMenu({ placement }: { placement: "rail" | "header" | "sheet" }) {
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
      role={placement === "sheet" ? undefined : "dialog"}
      aria-label="Account"
      className={
        placement === "rail"
          ? "absolute bottom-0 left-[calc(100%+12px)] z-50 w-72 rounded-panel border border-line bg-surface p-3 text-text shadow-tip [--focus-ring:var(--accent)]"
          : placement === "header"
            ? "absolute top-[calc(100%+8px)] right-0 z-50 w-72 max-w-[calc(100vw-20px)] rounded-panel border border-line bg-surface p-3 text-left text-text shadow-tip [--focus-ring:var(--accent)]"
            : "border-t border-line pt-3"
      }
    >
      <p className="mb-3 truncate px-1 text-sm font-medium" data-testid={placement === "sheet" ? "signed-in-as-sheet" : undefined}>
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
      {me?.kind === "user" && (
        // A person's own account; a service token has none.
        <Link
          href="/account"
          data-testid={placement === "sheet" ? "nav-my-account-sheet" : "nav-my-account"}
          onClick={() => setOpen(placement === "sheet")}
          className="mb-1 flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-text hover:bg-surface2"
        >
          <Icon name="user" size={16} />
          My account
        </Link>
      )}
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
  const rail = placement === "rail";
  return (
    <div ref={root} className={rail ? "relative mt-2" : "relative flex-none"}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Account ${email}`}
        title={email}
        data-testid={rail ? "user-menu" : "phone-user-menu"}
        onClick={() => setOpen((o) => !o)}
        className={`grid place-items-center rounded-full bg-rail-avatar font-semibold text-on-rail-avatar ring-2 ring-rail-avatar-ring ${
          rail ? "size-[38px] text-sm" : "size-8 text-[13px]"
        }`}
      >
        {initials}
        {rail && (
          <span className="sr-only" data-testid="signed-in-as">
            {email}
          </span>
        )}
      </button>
      {open && panel}
    </div>
  );
}

function RailLink({ d, pathname, home, badge }: { d: Dest; pathname: string; home?: string; badge?: number | null }) {
  const active = isActive(pathname, d, home);
  return (
    <Link
      href={d.href}
      data-testid={d.testId}
      aria-current={active ? "page" : undefined}
      className={`relative flex w-[70px] flex-col items-center gap-0.5 rounded-[10px] pt-[7px] pb-1.5 text-[13px] leading-4 font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${RAIL_SELECTED}`}
    >
      <Icon name={d.icon} stroke={1.7} />
      {d.label}
      {badge !== undefined && <Badge n={badge} testId={`${d.testId}-badge`} />}
    </Link>
  );
}

/**
 * Pages without the rail: sign-in, where a Google sign-in waits to join (A5), MCP client consent, and a customer's interview link (C3,
 * `/i/<token>`), which a customer opens without an account and never signs in on.
 */
function bare(pathname: string): boolean {
  return pathname.startsWith("/login") || pathname.startsWith("/access") || pathname.startsWith("/oauth") || pathname.startsWith("/i/") || pathname.startsWith("/s/");
}

/** Rail and tab bar; reads the pathname, so it renders inside its own Suspense boundary. */
function Navs() {
  const pathname = usePathname();
  const { me, loading } = useMe();
  // While /v1/me loads, keep the rail so a signed-in page never jumps.
  const shown = (loading || !!me) && !bare(pathname);
  const inbox = useInboxCount(shown);
  const home = useDocumentHome(pathname);
  const [more, setMore] = useState(false);
  // #370: Settings opens on the first tab the role can read, and leaves when there is none.
  const settingsTabs = useSettingsTabs();
  const settings: Dest | null = !settingsTabs.ready
    ? SETTINGS
    : settingsTabs.tabs[0]
      ? { ...SETTINGS, href: settingsTabs.tabs[0].href }
      : null;
  // Close the More sheet on navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMore(false);
  }
  if (!shown) return null;
  // #723: Simple's pages have Simple's own rail, nothing of Detailed's.
  if (modeOf(pathname) === "simple") return <SimpleNavs account={(placement) => <UserMenu placement={placement} />} />;

  const tabDests = TABS.map((t) => DESTINATIONS.find((d) => d.label === t)!);
  const moreDests = [...DESTINATIONS.filter((d) => !TABS.includes(d.label)), ...(settings ? [settings] : [])];
  const moreActive = moreDests.some((d) => isActive(pathname, d, home));

  return (
    <>
      <nav
        aria-label="Oracle"
        data-testid="app-nav"
        className="sticky top-0 z-40 col-start-1 row-start-1 flex h-dvh w-[88px] flex-col items-center gap-0.5 bg-rail py-3.5 [--focus-ring:var(--rail-bar)] max-[600px]:hidden"
      >
        <Link href="/home" aria-label="Product Oracle" data-testid="nav-brand" className="mb-3 flex-none rounded-xl">
          <Mark size={44} tone="sky" className="block" />
        </Link>
        <ModeSwitch placement="rail" documentHome={home} />
        {DESTINATIONS.map((d) => (
          <RailLink key={d.href} d={d} pathname={pathname} home={home} badge={d.label === "Inbox" ? inbox : undefined} />
        ))}
        <span className="flex-1" />
        <span aria-hidden className="mb-1.5 h-px w-10 flex-none bg-rail-sep" />
        {settings && <RailLink d={settings} pathname={pathname} home={home} />}
        <UserMenu placement="rail" />
      </nav>

      <nav
        aria-label="Oracle"
        data-testid="tab-bar"
        className="fixed inset-x-0 bottom-0 z-40 hidden h-[var(--phone-tab-bar)] grid-cols-5 bg-rail-foot px-1.5 [--focus-ring:var(--rail-bar)] pt-1.5 pb-2 max-[600px]:grid"
      >
        {tabDests.map((d) => {
          const active = isActive(pathname, d, home) && !more;
          return (
            <Link
              key={d.href}
              href={d.href}
              data-testid={`tab-${d.testId.slice(4)}`}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-[3px] rounded-[10px] text-[13px] leading-4 ${
                active ? `bg-rail-active font-semibold text-rail-active-text ${TAB_BAR}` : "font-medium text-rail-text"
              }`}
            >
              <Icon name={d.icon} stroke={1.7} />
              <span>{d.label}</span>
              {d.label === "Inbox" && <Badge n={inbox} testId="tab-inbox-badge" />}
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={more}
          aria-controls="more-sheet"
          data-testid="tab-more"
          onClick={() => setMore((m) => !m)}
          className={`relative flex flex-col items-center justify-center gap-[3px] rounded-[10px] text-[13px] leading-4 ${
            more || moreActive ? `bg-rail-active font-semibold text-rail-active-text ${TAB_BAR}` : "font-medium text-rail-text"
          }`}
        >
          <Icon name="more" stroke={1.7} />
          More
        </button>
      </nav>
      {more && (
        <div
          id="more-sheet"
          role="dialog"
          aria-label="More"
          className="fixed inset-x-0 bottom-[var(--phone-tab-bar)] z-40 hidden rounded-t-inspector border-t border-line bg-surface p-3 shadow-tip max-[600px]:block"
        >
          <ModeSwitch placement="sheet" documentHome={home} />
          <ul className="mb-2 grid grid-cols-3 gap-1">
            {moreDests.map((d) => (
              <li key={d.href}>
                <Link
                  href={d.href}
                  aria-current={isActive(pathname, d, home) ? "page" : undefined}
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

/** Titles of the screens outside the rail's destinations, for when the page draws no H1 yet. */
const OTHER_TITLES: [string, string][] = [
  ["/login", "Sign in"],
  ["/access", "Access"],
  ["/oauth", "Connect an MCP client"],
  ["/sources", "Sources"],
  ["/design", "Design system"],
];

function fallbackTitle(pathname: string): string {
  if (pathname.endsWith("/present")) return "Present";
  const other = OTHER_TITLES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  if (other) return other[1];
  if (modeOf(pathname) === "simple") {
    return [...SIMPLE_DESTINATIONS].reverse().find((d) => pathname === d.href || pathname.startsWith(`${d.href}/`))?.label ?? "Home";
  }
  return [...DESTINATIONS, SETTINGS].find((d) => isActive(pathname, d))?.label ?? "Product Oracle";
}

/**
 * The open page's title, read from its H1 (PageHeader's title and suffix, "Checkout PRD v3")
 * and kept in step as the page loads; the destination's label until the page draws one.
 */
function usePageTitle(pathname: string): string {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const read = () => {
      const h1 = main.querySelector("h1");
      const text = h1
        ? Array.from(h1.childNodes, (n) => n.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
        : "";
      setTitle(text || null);
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(main, { subtree: true, childList: true, characterData: true });
    return () => watch.disconnect();
  }, [pathname]);
  return title ?? fallbackTitle(pathname);
}

/**
 * The phone header (I3, 2026-10-19): a slim 44 px bar in the rail's navy on top of every phone
 * screen, below the top safe-area inset: the compact sky Compass mark (links Home), the page's
 * title and the user menu. The page's own H1 hides on a phone (kept for screen readers). The
 * title is white in both themes: rail-active-text, since `white` follows the theme. Desktop: hidden.
 */
function PhoneHeader() {
  const pathname = usePathname();
  const { me } = useMe();
  const title = usePageTitle(pathname);
  const [ask, setAsk] = useState(false);
  const [askPath, setAskPath] = useState(pathname);
  if (askPath !== pathname) {
    setAskPath(pathname);
    setAsk(false);
  }
  if (pathname.startsWith("/i/") || pathname.startsWith("/s/")) return null;
  return (
    <header
      data-testid="phone-header"
      className="sticky top-0 z-30 hidden h-[var(--phone-top-bar)] items-center gap-2.5 bg-rail-top pt-[env(safe-area-inset-top)] pr-2.5 pl-3 [--focus-ring:var(--rail-bar)] max-[600px]:flex"
    >
      <Link href={homeOf(modeOf(pathname))} aria-label="Product Oracle" data-testid="phone-brand" className="flex-none rounded-md">
        {/* ask-fresh: Simple's light header draws the mark in the accent ink, as its rail does; Detailed's navy keeps the sky mark. */}
        {pathname.startsWith("/simple") ? <Mark size={22} tone="current" className="block text-accent-ink" /> : <Mark size={22} tone="sky" className="block" />}
      </Link>
      <p data-testid="phone-title" className="min-w-0 flex-1 truncate font-display text-[17px] leading-6 font-semibold text-rail-active-text">
        {title}
      </p>
      {me && !panelHidden(pathname) && (
        <button
          type="button"
          data-testid="phone-ask"
          aria-label="Ask Oracle"
          aria-expanded={ask}
          onClick={() => setAsk(true)}
          className="flex h-9 flex-none items-center gap-1 rounded-lg px-2 text-[15px] font-semibold text-rail-active-text hover:bg-rail-hover"
        >
          <Icon name="ask" size={20} />
          Ask
        </button>
      )}
      {me && <UserMenu placement="header" />}
      <Sheet open={ask} title="Ask Oracle" onClose={() => setAsk(false)} testId="phone-ask-sheet" scroll={false} full>
        <HopPanel showHeader={false} />
      </Sheet>
    </header>
  );
}

/** Where the head-of-product panel never shows (G7 3.2): sign-in, consent, present mode, the design page. */
export function panelHidden(pathname: string): boolean {
  return /^\/(login|oauth|design)(\/|$)/.test(pathname) || /\/present\/?$/.test(pathname);
}

/**
 * The head-of-product panel's place (G7 "Panel place", owner 2026-10-21): a 44 px "Ask" strip
 * on the right edge of every screen; a click or ⌘J / Ctrl+J opens the 400 px panel, docked
 * from 1280 px (the page's grid gives up the width) and an overlay drawer below. Esc or the
 * strip closes it. Phones get the header's Ask button instead. Nothing loads until it opens.
 */
function HopDock() {
  const pathname = usePathname();
  const { me } = useMe();
  const open = usePanelOpen();
  const shown = !!me && !panelHidden(pathname);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setPanelOpen(!open);
      } else if (e.key === "Escape" && open && !e.defaultPrevented) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, open]);
  if (!shown) return null;
  // The strip is 44 px and the dock's left border 1 px more: a 44 px dock would push the
  // strip 1 px past the right edge (sideways scroll).
  return (
    <aside
      aria-label="Ask Oracle"
      data-testid="hop-dock"
      data-open={open ? "true" : "false"}
      className={`sticky top-0 col-start-3 row-start-1 h-dvh border-l border-line bg-surface max-[600px]:hidden ${open ? "w-[45px] min-[1280px]:w-[400px]" : "w-[45px]"}`}
    >
      <button
        type="button"
        data-testid="hop-strip"
        aria-expanded={open}
        aria-label={open ? "Close Ask Oracle" : "Ask Oracle"}
        title="Ask Oracle (⌘J)"
        onClick={() => setPanelOpen(!open)}
        className={`flex h-full w-11 flex-col items-center gap-3 pt-4 text-text hover:bg-surface2 ${open ? "min-[1280px]:hidden" : ""}`}
      >
        <Mark size={24} tone="current" className="block flex-none text-accent" />
        <span className="text-[15px] font-semibold [writing-mode:vertical-rl]">Ask</span>
      </button>
      {open && (
        <div
          data-testid="hop-drawer"
          className="fixed inset-y-0 right-11 z-40 w-[400px] max-w-[calc(100vw-44px)] border-l border-line shadow-tip min-[1280px]:static min-[1280px]:h-full min-[1280px]:w-full min-[1280px]:max-w-none min-[1280px]:border-l-0 min-[1280px]:shadow-none"
        >
          <HopPanel onClose={() => setPanelOpen(false)} />
        </div>
      )}
    </aside>
  );
}

/**
 * The app shell (I3): SwarmCloud's navy rail with its destinations on desktop, a tab bar
 * (Home, PRDs, Roadmap, Inbox, More) and the phone header on a phone. No rail on /login, /oauth, a
 * customer's interview link /i/ (no phone header either) and when
 * signed out: its grid column then collapses to nothing.
 */
/**
 * #370 fixes 4: when GET /v1/me/capabilities fails, every can() is false and the pages hide
 * their actions. Say so, with Retry, instead of leaving them quietly empty.
 */
export function CapsError() {
  const { capsError, retryCaps } = useMe();
  if (!capsError) return null;
  return (
    <div className="px-4 pt-3 sm:px-6">
      <Notice
        tone="error"
        testId="caps-error"
        action={
          <Button onClick={retryCaps}>
            Retry
          </Button>
        }
      >
        {capsError}
      </Notice>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ScreenSubjectProvider>
      <Suspense fallback={null}>
        <ModeRoot />
      </Suspense>
      <div className="grid min-h-dvh grid-cols-[auto_minmax(0,1fr)_auto]">
        <Suspense fallback={null}>
          <Navs />
        </Suspense>
        <main className="col-start-2 row-start-1 min-w-0">
          <Suspense fallback={null}>
            <PhoneHeader />
          </Suspense>
          <CapsError />
          {children}
        </main>
        <Suspense fallback={null}>
          <HopDock />
        </Suspense>
        <ConfirmHost />
        <ToastHost />
      </div>
    </ScreenSubjectProvider>
  );
}
