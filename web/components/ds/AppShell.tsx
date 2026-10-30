"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { HopPanel } from "@/components/hop/HopPanel";
import { personLine, SIMPLE_DESTINATIONS, SimpleNavs } from "@/components/simple/SimpleShell";
import { closeTransientPanel, setPanelOpen, takeAskFocus, useAskDraft, usePanelOpen } from "@/components/hop/open-state";
import { api, MOCK_MODE } from "@/lib/api/client";
import { homeOf, modeOf } from "@/lib/experience";
import { resetMockData } from "@/lib/api/mock/server";
import { leave } from "@/lib/leave-guard";
import { useMe } from "@/lib/me";
import { useSettingsTabs } from "@/lib/settings-tabs";
import { loadInbox, loadMyQuestions, onWaitingChanged, waitingCount } from "@/lib/waiting";
import { ScreenSubjectProvider } from "@/lib/screen-subject";
import { useTheme, type ThemeChoice } from "@/lib/theme";

import { Mark } from "./Brand";
import { ConfirmHost, confirmInPage } from "./ConfirmDialog";
import { ToastHost } from "./Toast";
import { initialsOf } from "./Figures";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { Notice } from "./Layout";
import { ModeRoot, ModeSwitch, SEGMENTED } from "./ModeSwitch";
import { usePageInfo } from "./page-info";
import { onRadioKeys, radioTabIndex } from "./radio-keys";
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

/** The destination the open document page belongs to, once it has said so; a new roadmap's is Plan (qa-shell-14). */
function useDocumentHome(pathname: string): string | undefined {
  const kind = useSearchParams().get("kind");
  useSyncExternalStore(
    subscribeDocumentHomes,
    () => documentHomesVersion,
    () => 0,
  );
  if (pathname === "/documents/new") return kind === "roadmap" ? "/plan" : undefined;
  const slug = /^\/documents\/([^/]+)/.exec(pathname)?.[1];
  return slug ? documentHomes.get(decodeURIComponent(slug)) : undefined;
}

/*
 * A recorded change's impact (/impact/changes/<id>) can be about a PRD version, a baseline
 * item or a source: the route alone does not say which. The Impact page knows once its report
 * has loaded (it already works out where "back" goes) and says so here; until then, or for a
 * change the rail has no destination for (a member, an intake, an access request), nothing in
 * the rail is highlighted rather than guessing PRDs.
 */
const changeHomes = new Map<string, string>();
let changeHomesVersion = 0;
const changeHomesListeners = new Set<() => void>();

function subscribeChangeHomes(listener: () => void) {
  changeHomesListeners.add(listener);
  return () => {
    changeHomesListeners.delete(listener);
  };
}

/** An impact page says which destination the change it shows belongs to. */
export function useChangeDestination(id: string | undefined, href: string | undefined) {
  useLayoutEffect(() => {
    if (!id || !href || changeHomes.get(id) === href) return;
    changeHomes.set(id, href);
    changeHomesVersion += 1;
    changeHomesListeners.forEach((listener) => listener());
  }, [id, href]);
}

/** The destination a recorded change's impact page belongs to, once it has said so. */
function useChangeHome(pathname: string): string | undefined {
  useSyncExternalStore(
    subscribeChangeHomes,
    () => changeHomesVersion,
    () => 0,
  );
  const id = /^\/impact\/changes\/([^/]+)/.exec(pathname)?.[1];
  return id ? changeHomes.get(decodeURIComponent(id)) : undefined;
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
  // qa-docs-65: a feature's tech brief belongs with its PRD.
  if (d.href === "/documents" && pathname.startsWith("/briefs/")) return true;
  // qa-plan-19: the Roadmap's tabs (changelog, launches) are tabs of Plan.
  if (d.href === "/plan" && (pathname === "/roadmap" || pathname.startsWith("/roadmap/"))) return true;
  // qa-plan-59: a baseline item's what-if belongs with Baseline.
  if (d.href === "/baseline" && pathname.startsWith("/impact/entities/")) return true;
  // A recorded change's impact (/impact/changes/<id>) highlights by what it says it's about
  // (useChangeHome, above the "if (home)" branch); unknown, it highlights nothing rather than
  // guessing PRDs.
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

/** The link's name with its badge: "Inbox, 11 waiting" (qa-shell-14: a span's aria-label is not read). */
export const badgedName = (label: string, n: number | null | undefined) => (n ? `${label}, ${n} waiting` : undefined);

/**
 * qa-shell-14, qa-onboarding-32: the count sits beside the icon's top-right corner, starting
 * just past the 24 px icon (50% + 14 px), so two or three digits never cover it; a ring in the
 * bar's colour keeps its edge clear. The link carries the words (badgedName): the number is
 * drawn, not read.
 */
function Badge({ n, testId }: { n: number | null; testId?: string }) {
  if (!n) return null;
  // Past 99 it says 99+ (the link's name keeps the count), so it fits the 88 px rail and the tab.
  const text = n > 99 ? "99+" : String(n);
  return (
    <span
      data-testid={testId}
      aria-hidden
      className={`tnum absolute top-0.5 left-[calc(50%+14px)] h-4 min-w-4 rounded-lg bg-rail-badge text-center font-mono leading-4 font-semibold text-on-rail-badge ring-2 ring-rail ${
        text.length > 2 ? "px-0.5 text-[11px] tracking-tighter" : "px-1 text-[13px]"
      }`}
    >
      {text}
    </span>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/**
 * The user menu: who is signed in, the theme switch, My account, mock reset, sign out. On open,
 * focus moves to the checked theme; Escape closes it and returns focus to the avatar
 * (qa-shell-12, qa-shell-18). The avatar is marked current on /account (qa-shell-15).
 */
function UserMenu({ placement, emailBeside = false }: { placement: "rail" | "header"; emailBeside?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { me, clear } = useMe();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ bottom: 12, left: 100 });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const email = me?.email ?? me?.token_name ?? "";
  // qa-simple-roadmap-46: the panel truncates this line; the full address (and the name,
  // when there is one) still reads on hover/focus.
  const name = me && me.kind === "user" ? (me.name ?? null) : null;
  // qa-simple-prd-p3-31: Simple's rail writes the email beside the avatar when there is no
  // name; the avatar's hidden line then leaves it out, so the block says it once.
  const emailShown = emailBeside && !!email && personLine(me) === email;

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    // The rail scrolls when the window is short (qa-shell-2): the menu is fixed beside it,
    // its foot level with the avatar's, never clipped by the rail. Placed again while open,
    // when the window is resized or the rail scrolls, so it never drifts from the avatar.
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      // Beside the rail, Detailed's or Simple's: past the rail's right edge.
      const nav = button.current?.closest("nav")?.getBoundingClientRect();
      if (r) setAt({ bottom: Math.max(8, window.innerHeight - r.bottom), left: (nav?.right ?? r.right) + 12 });
    };
    place();
    window.addEventListener("resize", place);
    // Capture: the rail's own scroll does not bubble.
    document.addEventListener("scroll", place, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only this menu closes (not the Ask panel).
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  // Close on navigation (My account).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }

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
  const rail = placement === "rail";
  const current = pathname === "/account" || pathname.startsWith("/account/");

  const panel = (
    <div
      role="dialog"
      aria-label="Account"
      style={rail ? at : undefined}
      className={
        rail
          ? "fixed z-50 max-h-[calc(100dvh-16px)] w-72 overflow-y-auto rounded-panel border border-line bg-surface p-3 text-text shadow-tip [--focus-ring:var(--accent)]"
          : "absolute top-[calc(100%+8px)] right-0 z-50 w-72 max-w-[calc(100vw-20px)] rounded-panel border border-line bg-surface p-3 text-left text-text shadow-tip [--focus-ring:var(--accent)]"
      }
    >
      {/* qa-simple-roadmap-46: the name and the whole email, each on its own line and wrapped, never cut off. */}
      <p className="mb-3 px-1 text-sm font-medium" data-testid="account-who">
        {name && <span className="block break-words">{name}</span>}
        <span className={`block break-all ${name ? "font-normal text-text2" : ""}`}>{email}</span>
      </p>
      <div
        role="radiogroup"
        aria-label="Theme"
        data-testid="theme-switch"
        onKeyDown={(e) => onRadioKeys(e, THEMES.map((t) => t.value), theme, setTheme)}
        className={`mb-3 grid grid-cols-3 ${SEGMENTED.track}`}
      >
        {THEMES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={theme === t.value}
            tabIndex={radioTabIndex(theme === t.value)}
            data-testid={`theme-${t.value}`}
            onClick={() => setTheme(t.value)}
            // qa-simple-home-31: the one segmented control, as the rail's Simple | Detailed.
            className={`flex items-center justify-center gap-1 ${SEGMENTED.option} ${theme === t.value ? SEGMENTED.on : SEGMENTED.off}`}
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
          data-testid="nav-my-account"
          aria-current={current ? "page" : undefined}
          onClick={() => setOpen(false)}
          className="mb-1 flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-text hover:bg-surface2 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
        >
          <Icon name="user" size={16} />
          My account
        </Link>
      )}
      {MOCK_MODE && (
        <button
          type="button"
          title="Restore the sample data and sign out"
          onClick={async () => {
            // qa-shell-13: it drops every change made in this browser, so it asks first.
            const yes = await confirmInPage({
              action: "Reset sample data",
              message: "Restore the sample data and sign out? Every change made in this browser is lost.",
              destructive: true,
            });
            if (!yes) return;
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
        onClick={() => leave(() => void signOut())}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-text hover:bg-surface2"
      >
        <Icon name="signout" size={16} />
        Sign out
      </button>
    </div>
  );

  return (
    <div ref={root} className={rail ? "relative mt-2 flex-none" : "relative flex-none"}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Account ${email}`}
        aria-current={current ? "page" : undefined}
        title={email}
        data-testid={rail ? "user-menu" : "phone-user-menu"}
        onClick={() => setOpen((o) => !o)}
        className={`grid place-items-center rounded-full bg-rail-avatar font-semibold text-on-rail-avatar ring-2 ring-rail-avatar-ring aria-[current=page]:ring-[3px] aria-[current=page]:ring-rail-active-text ${
          rail ? "size-[38px] text-sm" : "size-8 text-[13px]"
        }`}
      >
        {initials}
        {rail && !emailShown && (
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
      aria-label={badgedName(d.label, badge)}
      className={`relative flex w-[70px] flex-none flex-col items-center gap-0.5 rounded-[10px] pt-[7px] pb-1.5 text-[13px] leading-4 font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${RAIL_SELECTED}`}
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

/**
 * Rail and tab bar; reads the pathname, so it renders inside its own Suspense boundary.
 * qa-shell-31: the phone's tab bar (and its More sheet) is drawn into `phoneSlot`, after the page,
 * so Tab reaches it last, as it sits at the bottom; the rail stays before the page.
 */
function Navs({ phoneSlot }: { phoneSlot: HTMLElement | null }) {
  const pathname = usePathname();
  const { me, loading } = useMe();
  // While /v1/me loads, keep the rail so a signed-in page never jumps.
  // qa-docs-59: Present mode covers the screen; no rail or account button under (or over) its controls.
  const shown = (loading || !!me) && !bare(pathname) && !/\/present\/?$/.test(pathname);
  const inbox = useInboxCount(shown);
  const documentHome = useDocumentHome(pathname);
  const changeHome = useChangeHome(pathname);
  const home = documentHome ?? changeHome;
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
  // qa-shell-27: on a phone the header's avatar is the one account control, never the More sheet.
  if (modeOf(pathname) === "simple") return <SimpleNavs account={(placement) => (placement === "rail" ? <UserMenu placement="rail" emailBeside /> : null)} />;

  const tabDests = TABS.map((t) => DESTINATIONS.find((d) => d.label === t)!);
  const moreDests = [...DESTINATIONS.filter((d) => !TABS.includes(d.label)), ...(settings ? [settings] : [])];
  // qa-settings-39: the bar has no tab for My account; like Settings, it lights More.
  const moreActive = moreDests.some((d) => isActive(pathname, d, home)) || pathname === "/account" || pathname.startsWith("/account/");

  // z-[39]: drawn after the page now, one under the page's own z-40 sheets and panels, which
  // still lie over it as they did when it came first.
  const phone = (
    <>
      <nav
        aria-label="Oracle"
        data-testid="tab-bar"
        className="fixed inset-x-0 bottom-0 z-[39] hidden h-[var(--phone-tab-bar)] grid-cols-5 bg-rail-foot px-1.5 [--focus-ring:var(--rail-bar)] pt-1.5 pb-2 max-[600px]:grid"
      >
        {tabDests.map((d) => {
          const active = isActive(pathname, d, home) && !more;
          return (
            <Link
              key={d.href}
              href={d.href}
              data-testid={`tab-${d.testId.slice(4)}`}
              aria-current={active ? "page" : undefined}
              aria-label={d.label === "Inbox" ? badgedName(d.label, inbox) : undefined}
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
      {/* qa-shell-10: a sheet above the tab bar, with a backdrop; Escape, a tap outside or a swipe down closes it. */}
      <Sheet open={more} title="More" onClose={() => setMore(false)} testId="more-sheet" id="more-sheet" above>
        <div className="p-3">
          <ModeSwitch placement="sheet" documentHome={home} />
          <ul className="grid grid-cols-3 gap-1">
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
        </div>
      </Sheet>
    </>
  );

  return (
    <>
      <nav
        aria-label="Oracle"
        data-testid="app-nav"
        className="sticky top-0 z-40 col-start-1 row-start-1 flex h-dvh w-[88px] flex-col items-center gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain bg-rail py-3.5 [scrollbar-width:none] [--focus-ring:var(--rail-bar)] max-[600px]:hidden"
      >
        <Link href="/home" aria-label="Product Oracle" data-testid="nav-brand" className="mb-3 flex-none rounded-xl">
          <Mark size={44} tone="sky" className="block" />
        </Link>
        <ModeSwitch placement="rail" documentHome={home} />
        {/* qa-shell-2: a short window scrolls the rail, so Settings and the account menu stay reachable. */}
        {DESTINATIONS.map((d) => (
          <RailLink key={d.href} d={d} pathname={pathname} home={home} badge={d.label === "Inbox" ? inbox : undefined} />
        ))}
        <span className="flex-1" />
        <span aria-hidden className="mb-1.5 h-px w-10 flex-none bg-rail-sep" />
        {settings && <RailLink d={settings} pathname={pathname} home={home} />}
        <UserMenu placement="rail" />
      </nav>
      {phoneSlot && createPortal(phone, phoneSlot)}
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
  ["/account", "My account"],
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
 * qa-shell-23: the phone header's one rule. A tab of a section (Plan's tabs and the Roadmap's,
 * Company's, one level below the section) shows the section's name, as
 * the rail names it; every other page (a document, a run, a report, a template) shows its H1.
 * The browser tab always names the page itself ("Dates · Product Oracle").
 */
function sectionOf(pathname: string): string | null {
  if (/^\/(plan|roadmap)(\/[^/]+)?\/?$/.test(pathname)) return "Plan";
  if (/^\/company(\/[^/]+)?\/?$/.test(pathname)) return "Company";
  // qa-settings-40: Settings' pages name themselves ("Connections"); the phone's page picker
  // under it (settings/_nav.tsx) already says they are Settings.
  return null;
}

/** An H1's words, without its suffix ("v3") when `plain`. */
function h1Text(h1: Element | undefined, plain: boolean): string {
  if (!h1) return "";
  return Array.from(h1.childNodes, (n) => (plain && n instanceof Element && n.hasAttribute("data-title-suffix") ? "" : (n.textContent?.trim() ?? "")))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * A tab's name: its full name when its label shortens it (Plan's "Documents" is "Roadmap
 * documents"), without a count beside it (Requests' "Themes 3").
 */
function tabName(a: Element): string {
  const full = a.getAttribute("aria-label")?.trim();
  if (full) return full;
  return Array.from(a.childNodes, (n) => (n instanceof Element && /^\s*\d+\s*$/.test(n.textContent ?? "") ? "" : (n.textContent ?? "")))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * qa-shell-16: the page, then its section's open tab: "Dates · Plan" where the H1 is the
 * section's name (Plan, Company, Requests), "New template · Templates" where the H1 names a page
 * inside a tab. The tab is read from the shown H1's own header, whether its strip shows there or
 * not (a phone draws Requests' tabs above the header and Settings' as a select), so a page has
 * one name on every device.
 */
function withTab(h1: Element | undefined, words: string, pathname: string): string {
  if (!h1 || !words) return words;
  const tab = h1.closest("[data-page-header]")?.querySelector('nav a[aria-current="page"]');
  const label = tab ? tabName(tab) : "";
  if (!label || label === words) return words;
  const section = [...DESTINATIONS, SETTINGS].find((d) => isActive(pathname, d))?.label;
  return words === section ? `${label} · ${words}` : `${words} · ${label}`;
}

/**
 * The open page's title, read from its H1 (PageHeader's title and suffix, "Checkout PRD v3")
 * and kept in step as the page loads; the destination's label until the page draws one.
 * `plain`: the title without the suffix, for the browser tab ("Checkout PRD").
 */
const noSubscribe = () => () => undefined;

function usePageTitle(pathname: string): { title: string; plain: string; drawn?: boolean } {
  const [read, setRead] = useState<{ title: string; plain: string; drawn?: boolean } | null>(null);
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const update = () => {
      // Next keeps recently visited routes mounted but hidden: the shown page's H1.
      const h1s = Array.from(main.querySelectorAll("h1"));
      const h1 = h1s.find((h) => h.checkVisibility()) ?? h1s[0];
      const title = h1Text(h1, false);
      // qa-shell-3: a section's tab (Plan, Company, Settings) is headed by the section's name;
      // the browser tab names the open tab too ("Dates · Plan"), so no two pages share one.
      const plain = withTab(h1, h1Text(h1, true), pathname);
      // qa-docs-78: a page that draws its H1 on a phone too (PageHeader phoneTitle).
      const drawn = !!h1?.hasAttribute("data-phone-title");
      setRead((r) => (r?.title === title && r.plain === plain && r.drawn === drawn ? r : title ? { title, plain: plain || title, drawn } : null));
    };
    update();
    const watch = new MutationObserver(update);
    watch.observe(main, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "style", "aria-current"] });
    return () => watch.disconnect();
  }, [pathname]);
  // qa-shell-24: a not-found page renders on the server under another path than the
  // browser's, so the path's fallback title waits for hydration (no #418 mismatch).
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (read) return read;
  const fallback = hydrated ? fallbackTitle(pathname) : "";
  return { title: fallback, plain: fallback };
}

/** Public pages that set their own title (a customer's interview link, a shared roadmap). */
const ownTitle = (pathname: string) => pathname.startsWith("/i/") || pathname.startsWith("/s/");

/**
 * qa-shell-2: the browser tab names the page, "<title> · Product Oracle", from the same H1
 * the phone header reads; signed out too ("Sign in · Product Oracle").
 */
function DocumentTitle() {
  const pathname = usePathname();
  const { plain } = usePageTitle(pathname);
  const text = !plain || plain === "Product Oracle" ? "Product Oracle" : `${plain} · Product Oracle`;
  useEffect(() => {
    if (ownTitle(pathname) || !plain) return;
    document.title = text;
    // Next may write the layout's title back after a navigation: keep ours.
    const head = document.querySelector("head");
    if (!head) return;
    const keep = new MutationObserver(() => {
      if (document.title !== text) document.title = text;
    });
    keep.observe(head, { subtree: true, childList: true, characterData: true });
    return () => keep.disconnect();
  }, [pathname, plain, text]);
  return null;
}

/**
 * The phone header (I3, 2026-10-19): a slim 44 px bar in the rail's navy on top of every phone
 * screen, below the top safe-area inset: the compact sky Compass mark (links Home), the page's
 * title (or its section's, qa-shell-23), the page's info tip (qa-shell-22) and the user menu.
 * The page's own H1 hides on a phone (kept for screen readers). The title is white in both
 * themes: rail-active-text, since `white` follows the theme. Desktop: hidden. Not on the pages
 * without the shell (sign-in, access, consent, a customer's link): they keep their own heading.
 */
function PhoneHeader() {
  const pathname = usePathname();
  const { me } = useMe();
  const { title, drawn } = usePageTitle(pathname);
  // The section from the path waits for hydration too (qa-shell-24, see usePageTitle).
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  // qa-docs-78: a page whose own H1 shows on a phone (a long document title, wrapped) is not
  // named a second time, cut, right above it: the bar names where it is, as the rail does.
  const documentHome = useDocumentHome(pathname);
  const changeHome = useChangeHome(pathname);
  const home = documentHome ?? changeHome;
  const where = drawn ? ([...DESTINATIONS, SETTINGS].find((d) => isActive(pathname, d, home))?.label ?? null) : null;
  const info = usePageInfo();
  const [ask, setAsk] = useState(false);
  // A goal's "Suggest from the chat" opens the Ask sheet with its words typed in.
  const typedIn = useAskDraft();
  useEffect(() => {
    // The words arrive from outside React (the drawer's link); a phone opens its sheet for them.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (typedIn && window.matchMedia("(max-width: 600px)").matches) setAsk(true);
  }, [typedIn]);
  const [askPath, setAskPath] = useState(pathname);
  if (askPath !== pathname) {
    setAskPath(pathname);
    setAsk(false);
  }
  if (bare(pathname)) return null;
  // Simple's Ask sheet (the owner's pick C): the whole screen over the header and the tab bar,
  // with the panel's own head (Ask Oracle, New chat, close). It sits outside the sticky header,
  // whose stacking would put it under the tab bar.
  const simple = pathname.startsWith("/simple");
  const sheet = simple ? (
    <Sheet open={ask} title="Ask Oracle" onClose={() => setAsk(false)} testId="phone-ask-sheet" scroll={false} bare>
      <HopPanel onClose={() => setAsk(false)} mark={false} />
    </Sheet>
  ) : (
    <Sheet open={ask} title="Ask Oracle" onClose={() => setAsk(false)} testId="phone-ask-sheet" scroll={false} full>
      <HopPanel showHeader={false} />
    </Sheet>
  );
  return (
    <>
    <header
      data-testid="phone-header"
      className="sticky top-0 z-30 hidden h-[var(--phone-top-bar)] items-center gap-2.5 bg-rail-top pt-[env(safe-area-inset-top)] pr-2.5 pl-3 [--focus-ring:var(--rail-bar)] max-[600px]:flex"
    >
      {/* qa-simple-home-32: a 44 px hit area around the 22 px mark; the negative margin keeps the mark where it was. */}
      <Link href={homeOf(modeOf(pathname))} aria-label="Product Oracle" data-testid="phone-brand" className="-m-[11px] flex size-11 flex-none items-center justify-center rounded-md">
        {/* ask-fresh: Simple's light header draws the mark in the accent ink, as its rail does; Detailed's navy keeps the sky mark. */}
        {pathname.startsWith("/simple") ? <Mark size={22} tone="current" className="block text-accent-ink" /> : <Mark size={22} tone="sky" className="block" />}
      </Link>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <p data-testid="phone-title" className="min-w-0 truncate font-display text-[17px] leading-6 font-semibold text-rail-active-text">
          {(hydrated && sectionOf(pathname)) || where || title}
        </p>
        {info && (
          <span
            data-testid="phone-info"
            className="flex flex-none items-center [&_[data-testid=info-tip][aria-expanded=false]>span]:border-rail-text [&_[data-testid=info-tip][aria-expanded=false]>span]:text-rail-active-text"
          >
            {info}
          </span>
        )}
      </span>
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
      {!simple && sheet}
    </header>
    {simple && sheet}
    </>
  );
}

/** Where the head-of-product panel never shows (G7 3.2): sign-in, consent, present mode, the design page. */
export function panelHidden(pathname: string): boolean {
  return /^\/(login|oauth|design)(\/|$)/.test(pathname) || /\/present\/?$/.test(pathname);
}

/**
 * The head-of-product panel's place (G7 "Panel place", owner 2026-10-21): a 44 px "Ask" strip
 * on the right edge of every screen; a click or ⌘J / Ctrl+J opens the 400 px panel, docked
 * from 1600 px (the page's grid gives up the width; qa-shell-8: below, docking squeezed the
 * page) and an overlay drawer below, over a dimmed page (qa-shell-13). Esc, the panel's close
 * button or a click on the dimmed page closes it; the strip only opens it (open, the drawer lies
 * over it, so the panel's close is the one control). Opening focuses the question box; closing
 * returns focus to the strip (qa-shell-19). Phones get the header's Ask button
 * instead. On Simple's pages no strip: Simple's rail has its own Ask Oracle, which opens the
 * same panel (qa-shell-16). Nothing loads until it opens.
 */
function HopDock() {
  const pathname = usePathname();
  const { me } = useMe();
  const open = usePanelOpen();
  const shown = !!me && !panelHidden(pathname);
  const simple = modeOf(pathname) === "simple";
  const strip = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);
  // qa-simple-decide-10: a panel opened for one question closes when its page is left, whichever page opened it.
  const shownOn = useRef(pathname);
  useEffect(() => {
    if (shownOn.current === pathname) return;
    shownOn.current = pathname;
    closeTransientPanel();
  }, [pathname]);
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
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (closed) {
      strip.current?.focus();
      return;
    }
    if (!open || !takeAskFocus()) return;
    // The panel draws its question box once it has loaded.
    const focusBox = () => {
      const box = drawer.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Oracle"]') ?? drawer.current?.querySelector<HTMLTextAreaElement>("textarea");
      if (!box) return false;
      box.focus();
      return true;
    };
    if (focusBox() || !drawer.current) return;
    const watch = new MutationObserver(() => focusBox() && watch.disconnect());
    watch.observe(drawer.current, { subtree: true, childList: true });
    const stop = window.setTimeout(() => watch.disconnect(), 5000);
    return () => {
      watch.disconnect();
      window.clearTimeout(stop);
    };
  }, [open]);
  if (!shown) return null;
  if (simple && !open) return null;
  // Sticky, the dock is its own stacking layer: z-40 keeps it (and the drawer that overlays
  // the page below 1600 px) above anything in the page that sets its own z-index.
  // The strip is 44 px and the dock's left border 1 px more: a 44 px dock would push the
  // strip 1 px past the right edge (sideways scroll).
  // qa-simple-decide-10: on Simple's pages the open panel pushes the page aside from 1240 px, where
  // about 600 px of page is left beside it (never over a row's buttons); narrower, it is a drawer
  // over the page with a backdrop that closes it (docked there, it squeezed the page to a column
  // of single words). Elsewhere it overlays below 1600 px, over its strip, with the same backdrop
  // (qa-shell-13: a page's inspector under it was covered with nothing to say so); the dock keeps
  // the strip's 45 px, so the page keeps its width.
  // qa-onboarding-29: a page's own modal (fixed z-40 inside <main>) ties with the dock's z-40 and
  // loses on DOM order, leaving the Ask column bright beside the dimmed page. While one is open the
  // dock steps down to z-30 so the overlay covers the whole window.
  const modalOver = "[body:has(#main_[aria-modal=true])_&]:z-30";
  const width = simple ? "w-0 min-[1240px]:w-[400px] min-[1240px]:border-l" : open ? "w-[45px] border-l min-[1600px]:w-[400px]" : "w-[45px] border-l";
  return (
    <aside
      aria-label="Ask Oracle"
      data-testid="hop-dock"
      data-open={open ? "true" : "false"}
      className={`sticky top-0 z-40 col-start-3 row-start-1 h-dvh border-line bg-surface max-[600px]:hidden ${modalOver} ${width}`}
    >
      {!simple && (
        <button
          ref={strip}
          type="button"
          data-testid="hop-strip"
          aria-expanded={open}
          aria-label="Ask Oracle"
          title="Ask Oracle (⌘J)"
          onClick={() => setPanelOpen(true)}
          className={`flex h-full w-11 flex-col items-center gap-3 pt-4 text-text hover:bg-surface2 ${open ? "invisible min-[1600px]:hidden" : ""}`}
        >
          <Mark size={24} tone="current" className="block flex-none text-accent" />
          <span className="text-[15px] font-semibold [writing-mode:vertical-rl]">Ask</span>
        </button>
      )}
      {open && (
        <div
          aria-hidden
          data-testid="hop-backdrop"
          className={`fixed inset-0 z-40 bg-hero/30 ${simple ? "min-[1240px]:hidden" : "min-[1600px]:hidden"}`}
          onClick={() => setPanelOpen(false)}
        />
      )}
      {open && (
        <div
          ref={drawer}
          data-testid="hop-drawer"
          className={
            simple
              ? "fixed inset-y-0 right-0 z-40 w-[400px] max-w-[100vw] border-l border-line bg-surface shadow-tip min-[1240px]:static min-[1240px]:h-full min-[1240px]:w-full min-[1240px]:max-w-none min-[1240px]:border-l-0 min-[1240px]:shadow-none"
              : "fixed inset-y-0 right-0 z-40 w-[400px] max-w-[100vw] border-l border-line shadow-tip min-[1600px]:static min-[1600px]:h-full min-[1600px]:w-full min-[1600px]:max-w-none min-[1600px]:border-l-0 min-[1600px]:shadow-none"
          }
        >
          <HopPanel onClose={() => setPanelOpen(false)} />
        </div>
      )}
    </aside>
  );
}

/**
 * The app shell (I3): SwarmCloud's navy rail with its destinations on desktop, a tab bar
 * (Home, PRDs, Plan, Inbox, More) and the phone header on a phone. No rail (nor phone header)
 * on /login, /access, /oauth, a customer's interview link /i/ and when
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
  // qa-shell-31: where the phone's tab bar is drawn, after the page (Navs).
  const [phoneSlot, setPhoneSlot] = useState<HTMLDivElement | null>(null);
  return (
    <ScreenSubjectProvider>
      {/* qa-plan-63, qa-shell-17: the first stop of Tab. */}
      <a
        href="#main"
        data-testid="skip-link"
        className="sr-only rounded-button bg-surface px-3 py-2 text-sm font-semibold text-text shadow-tip focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:ring-2 focus:ring-accent"
      >
        Skip to content
      </a>
      <Suspense fallback={null}>
        <ModeRoot />
        <DocumentTitle />
      </Suspense>
      {/* qa-shell-31: the phone header comes before the page and outside it, so focus meets the
          top bar, the page, then the tab bar, and Skip to content lands past the header. Sticky
          in the body, it stays on top as the page scrolls; desktop never shows it. */}
      <Suspense fallback={null}>
        <PhoneHeader />
      </Suspense>
      <div className="grid min-h-dvh grid-cols-[auto_minmax(0,1fr)_auto] max-[600px]:min-h-[calc(100dvh-var(--phone-top-bar))]">
        <Suspense fallback={null}>
          <Navs phoneSlot={phoneSlot} />
        </Suspense>
        <main id="main" tabIndex={-1} className="col-start-2 row-start-1 min-w-0 outline-none">
          <CapsError />
          {children}
        </main>
        <div ref={setPhoneSlot} className="contents" />
        <Suspense fallback={null}>
          <HopDock />
        </Suspense>
        <ConfirmHost />
        <ToastHost />
      </div>
    </ScreenSubjectProvider>
  );
}
