"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Mark } from "@/components/ds/Brand";
import { Icon, type IconName } from "@/components/ds/Icon";
import { ModeSwitch, SEGMENTED } from "@/components/ds/ModeSwitch";
import { TAB_BAR } from "@/components/ds/rail";
import { Sheet } from "@/components/ds/Sheet";
import { setPanelOpen, usePanelOpen } from "@/components/hop/open-state";
import { SIMPLE_HOME, switchTarget } from "@/lib/experience";
import { useMe } from "@/lib/me";
import { api, unwrap } from "@/lib/api/client";
import { loadInbox, onWaitingChanged } from "@/lib/waiting";

type Dest = { label: string; href: string; icon: IconName; testId: string };

/** The Ask panel the rail's Ask Oracle opens (its aria-controls; SimpleAsk.tsx sets it on the docked panel). */
export const SIMPLE_ASK_PANEL_ID = "simple-ask-panel";

const noSubscribe = () => () => undefined;


/** Simple's destinations (#723, D10), in rail order: nothing of Detailed's rail. */
export const SIMPLE_DESTINATIONS: Dest[] = [
  { label: "Home", href: SIMPLE_HOME, icon: "home", testId: "simple-nav-home" },
  { label: "One-pagers", href: "/simple/one-pagers", icon: "doc", testId: "simple-nav-one-pagers" },
  { label: "Roadmap", href: "/simple/roadmap", icon: "roadmap", testId: "simple-nav-roadmap" },
  { label: "Priorities", href: "/simple/priorities", icon: "priorities", testId: "simple-nav-priorities" },
  { label: "Meetings", href: "/simple/meetings", icon: "clock", testId: "simple-nav-meetings" },
  { label: "Decisions", href: "/simple/decisions", icon: "flag", testId: "simple-nav-decisions" },
];

/** Phone tab bar: Home, One-pagers, Roadmap, Decisions, More (Detailed's pattern). */
const TABS = ["Home", "One-pagers", "Roadmap", "Decisions"];

function isActive(pathname: string, d: Dest): boolean {
  if (d.href === SIMPLE_HOME) return pathname === SIMPLE_HOME;
  return pathname === d.href || pathname.startsWith(`${d.href}/`);
}

/**
 * The rail's yellow counts (S1 restyle, the owner's pick): only where something waits on the
 * signed-in person: Decisions (the product decisions waiting for them, GET
 * /v1/simple/decisions/waiting, run approvals never), from the Inbox Roadmap (proposals they
 * decide and drafts waiting for their approval); Meetings counts what its page lists (the
 * production walk): the live meetings and the upcoming reviews not started yet, read when the
 * rail mounts, when something waiting changes and on the Meetings pages, not on every other
 * route change (review).
 */
function useSimpleCounts(enabled: boolean): Record<string, number> | null {
  const pathname = usePathname();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [meetings, setMeetings] = useState<number | null>(null);
  const [live, setLive] = useState(0);
  const [changes, setChanges] = useState(0);
  useEffect(() => onWaitingChanged(() => setChanges((c) => c + 1)), []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // prd-questions: Decisions counts the product decisions waiting for me (Oracle's run approvals never).
    Promise.all([loadInbox(), unwrap(api.GET("/v1/simple/decisions/waiting"))])
      .then(([inbox, waiting]) => {
        if (!alive) return;
        setCounts({
          Decisions: waiting.count,
          Roadmap: inbox.simple_proposals.length + inbox.simple_approvals.length,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, pathname, changes]);
  const meetingsPath = pathname.startsWith("/simple/meetings") ? pathname : "";
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    unwrap(api.GET("/v1/simple/meetings"))
      .then((m) => {
        if (!alive) return;
        setMeetings(m.live.length + m.upcoming.filter((o) => !o.meeting_id).length);
        setLive(m.live.length);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, changes, meetingsPath]);
  // qa-simple-decide-51: "Meetings live": the yellow count only when one is on now (else the count is neutral).
  return counts && { ...counts, Meetings: meetings ?? 0, "Meetings live": live };
}

/** fix4 qa-simple-roadmap-51: an email with a line break allowed after its "@", so it wraps
 * between its parts ("viewer@" / "example.com"), not inside one. */

/** What a rail count counts, said in words (its label and tooltip). */
function countWords(label: string, n: number): string {
  if (label === "Meetings") return `${n} ${n === 1 ? "review" : "reviews"} live or coming up`;
  // qa4-simple-roadmap-9: Roadmap counts changes and drafts sent to you, not the page's "Needs a decision".
  if (label === "Roadmap") return `${n} ${n === 1 ? "change or draft" : "changes or drafts"} waiting on you`;
  return `${n} waiting on you`;
}

/** An email with a line break allowed before its "@" (qa-shell-18): "viewer" / "@example.com". */
function breakAtSign(email: string): ReactNode {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return (
    <Fragment>
      {email.slice(0, at)}
      <wbr />
      {email.slice(at)}
    </Fragment>
  );
}

/**
 * A Simple page's place while the person's permissions load (qa-shell-20): the page frame, a
 * title and two cards as placeholders, so the page is never blank beside the rail's skeleton.
 */
export function SimplePageSkeleton() {
  return (
    <div className="simple-page" data-testid="simple-page-skeleton" role="status" aria-label="Loading" aria-busy="true">
      <header aria-hidden className="flex flex-col gap-2 max-[600px]:hidden">
        <span className="simple-h1">
          <span className="inline-block h-[1em] w-56 max-w-full animate-pulse rounded bg-surface2 align-middle" />
        </span>
      </header>
      {[3, 5].map((rows) => (
        <section key={rows} aria-hidden className="simple-card">
          <span className="simple-h2">
            <span className="inline-block h-[1em] w-48 max-w-full animate-pulse rounded bg-surface2 align-middle" />
          </span>
          {Array.from({ length: rows }, (_, i) => (
            <span key={i} className="block h-5 w-full animate-pulse rounded bg-surface2" />
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * The rail's person line (qa-simple-prd-p3-31): the member's name, or their email once when they
 * have no name of their own (none, or the email again); the avatar beside it then leaves the email
 * out (AppShell's UserMenu `emailBeside`), so the block never says it twice.
 */
export function personLine(me: { name?: string | null; email?: string | null } | null | undefined): string {
  const name = me?.name?.trim();
  return name && name !== me?.email ? name : me?.email || "";
}

/**
 * Whether Simple's page and rail may draw (#725 review): once the capabilities say Simple is
 * on, never while they load or say it is off (the page then opens its Detailed match). Signed
 * out or unreadable, the page draws so its own calls send the person to sign in or say why.
 */
export function useSimpleShown(): boolean {
  const { me, loading, capsReady, capsError, simpleMode } = useMe();
  if (!loading && !me) return true;
  return (capsReady && simpleMode) || !!capsError;
}

/**
 * Simple's rail (#723 S1, restyled to the owner's pick: light, 232 px, labels beside icons, yellow
 * counts where something waits on you, Ask Oracle and the person at the bottom): the switch on top, its six destinations and the
 * user menu; on a phone, the same bottom tab bar and More drawer Detailed uses. Its look comes
 * from the rail tokens under html[data-mode="simple"] (globals.css). While Simple is off, a
 * Simple page opens its matching Detailed page instead.
 */
export function SimpleNavs({ account }: { account: (placement: "rail" | "sheet") => ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, role, capsReady, capsError, simpleMode } = useMe();
  const counts = useSimpleCounts(!!me);
  const [more, setMore] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMore(false);
  }
  // qa-simple-home-2: opening Ask (another surface) closes the More sheet.
  const askOpen = usePanelOpen();
  const [lastAsk, setLastAsk] = useState(askOpen);
  if (lastAsk !== askOpen) {
    setLastAsk(askOpen);
    if (askOpen) setMore(false);
  }
  // qa-simple-home-18: the tab bar (and its More sheet) come after the page in the document, so
  // Tab reaches the skip link, the header and the page first; it stays fixed at the bottom.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const off = !!me && capsReady && !simpleMode;
  useEffect(() => {
    if (off) router.replace(switchTarget(pathname, "detailed"));
  }, [off, pathname, router]);

  const shown = useSimpleShown();
  // While the person's permissions load, the rail's frame (its width, the brand) so the page
  // beside it never jumps; nothing when Simple turns out to be off (Detailed opens instead).
  if (!shown && !off && !capsError)
    return (
      <nav
        aria-label="Simple"
        aria-busy="true"
        data-testid="simple-nav-skeleton"
        className="sticky top-0 z-40 col-start-1 row-start-1 flex h-dvh w-[var(--simple-rail-width)] flex-col gap-1 bg-rail px-4 py-5 [border-right:var(--simple-rail-border)] max-[600px]:hidden"
      >
        <span className="mb-4 flex flex-none items-center gap-2.5 rounded-xl px-2">
          <Mark size={32} tone="current" className="block text-accent-ink" />
          <span className="font-display text-[18px] font-semibold whitespace-nowrap text-rail-active-text">Product Oracle</span>
        </span>
        {/* qa-shell-20: the switch's place, so the destinations never move down when it shows. */}
        <span aria-hidden data-testid="simple-nav-skeleton-switch" className={`mb-4 grid w-full flex-none grid-cols-2 ${SEGMENTED.track}`}>
          <span className={`${SEGMENTED.option} animate-pulse bg-surface`} />
          <span className={SEGMENTED.option} />
        </span>
        {SIMPLE_DESTINATIONS.map((d) => (
          <span key={d.href} aria-hidden className="flex h-12 items-center gap-3 px-3">
            <span className="size-5 flex-none animate-pulse rounded bg-rail-hover" />
            <span className="h-3 w-24 animate-pulse rounded bg-rail-hover" />
          </span>
        ))}
      </nav>
    );
  if (!shown) return null;

  const tabDests = TABS.map((t) => SIMPLE_DESTINATIONS.find((d) => d.label === t)!);
  const moreDests = SIMPLE_DESTINATIONS.filter((d) => !TABS.includes(d.label));
  const moreActive = moreDests.some((d) => isActive(pathname, d));
  // qa-simple-home-29: the phone shows the rail's counts too; More sums the counts in its sheet.
  const countOf = (d: Dest) => counts?.[d.label] ?? 0;
  const moreCount = moreDests.reduce((sum, d) => sum + countOf(d), 0);
  const tabBadge = (id: string, n: number, words: string) =>
    n > 0 && (
      <span id={id} data-testid={id} aria-label={words} title={words} className="simple-count simple-count-tab tnum">
        {n}
      </span>
    );

  return (
    <>
      {/* qa-simple-home-6: from 1200 px the open Ask panel sits beside the page (it keeps the shell's third column), not over it. */}
      {askOpen && me && !/\/present\/?$/.test(pathname) && <span aria-hidden data-testid="simple-ask-room" className="col-start-3 row-start-1 hidden w-[400px] min-[1200px]:block" />}
      {/* fix4 qa-simple-roadmap-46: the rail's colour runs the page's full height (the sticky rail is one
       * screen tall), and the rail sits under a page's dimmed backdrop (z-35) like the page. */}
      <span aria-hidden data-testid="simple-nav-underlay" className="col-start-1 row-start-1 self-stretch bg-rail [border-right:var(--simple-rail-border)] max-[600px]:hidden" />
      <nav
        aria-label="Simple"
        data-testid="simple-nav"
        className="sticky top-0 z-30 col-start-1 row-start-1 flex h-dvh w-[var(--simple-rail-width)] flex-col gap-1 bg-rail px-4 py-5 [--focus-ring:var(--accent)] [border-right:var(--simple-rail-border)] max-[600px]:hidden"
      >
        <Link href={SIMPLE_HOME} aria-label="Product Oracle" data-testid="simple-nav-brand" className="mb-4 flex flex-none items-center gap-2.5 rounded-xl px-2">
          <Mark size={32} tone="current" className="block text-accent-ink" />
          <span className="font-display text-[18px] font-semibold whitespace-nowrap text-rail-active-text">Product Oracle</span>
        </Link>
        <ModeSwitch placement="wide" />
        {SIMPLE_DESTINATIONS.map((d) => {
          const n = counts?.[d.label] ?? 0;
          return (
            <Link
              key={d.href}
              href={d.href}
              data-testid={d.testId}
              aria-current={isActive(pathname, d) ? "page" : undefined}
              // The destination is the link's name; its count is the description (never "Meetings 3").
              aria-label={d.label}
              aria-describedby={n > 0 ? `${d.testId}-count` : undefined}
              className="flex h-12 items-center gap-3 rounded-xl px-3 text-[length:var(--simple-rail-label)] leading-6 font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text aria-[current=page]:bg-rail-active aria-[current=page]:font-semibold aria-[current=page]:text-rail-active-text"
            >
              <Icon name={d.icon} stroke={1.7} />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              {n > 0 && (
                <span id={`${d.testId}-count`} data-testid={`${d.testId}-count`} aria-label={countWords(d.label, n)} title={countWords(d.label, n)} className={`simple-count tnum ${d.label === "Meetings" && !counts?.["Meetings live"] ? "simple-count-quiet" : ""}`}>
                  {n}
                </span>
              )}
            </Link>
          );
        })}
        <span className="flex-1" />
        {/* qa-simple-home-24: says whether the Ask panel is open, which it controls, and looks pressed while it is. */}
        <button
          type="button"
          data-testid="simple-ask"
          aria-expanded={askOpen}
          aria-controls={SIMPLE_ASK_PANEL_ID}
          onClick={() => setPanelOpen(!askOpen)}
          className={`mb-2 flex h-12 items-center gap-3 rounded-xl border px-3 text-[length:var(--simple-rail-label)] font-semibold ${
            askOpen ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-rail-active-text hover:bg-rail-hover"
          }`}
        >
          <Icon name="ask" stroke={1.7} />
          Ask Oracle
        </button>
        <div data-testid="simple-person" className="flex items-center gap-3 border-t border-line pt-3">
          {account("rail")}
          <span className="flex min-w-0 flex-col pt-2 leading-5">
            {/* qa-simple-home-25, 21, qa-simple-prd-p3-31: the name in full, or the email once when the member has no name of their own
                (personLine); the email breaks only before its "@" (qa-shell-18), never mid-word. With no name the avatar says the
                email to a screen reader (its "Account <email>" name), so this line is hidden from it. */}
            <span
              data-testid="simple-person-name"
              title={me?.email || me?.name || undefined}
              aria-hidden={!!me?.email && personLine(me) === me.email ? true : undefined}
              className="text-[15px] font-semibold [overflow-wrap:break-word] text-rail-active-text"
            >
              {me?.email && personLine(me) === me.email ? breakAtSign(me.email) : personLine(me)}
            </span>
            <span className="text-[14px] text-rail-text capitalize">{role ?? ""}</span>
          </span>
        </div>
      </nav>

      {mounted &&
        createPortal(
          <>
            {/* z-39: last in the document now, it still paints under a page's own z-40 layers, as it did before the page. */}
            <nav
              aria-label="Simple"
              data-testid="simple-tab-bar"
              className="fixed inset-x-0 bottom-0 z-[39] hidden h-[var(--phone-tab-bar)] grid-cols-5 bg-rail-foot px-1.5 [--focus-ring:var(--rail-bar)] [border-top:var(--simple-rail-border)] pt-1.5 pb-2 max-[600px]:grid"
            >
              {tabDests.map((d) => {
                const active = isActive(pathname, d) && !more;
                const id = `simple-tab-${d.testId.slice("simple-nav-".length)}`;
                const n = countOf(d);
                return (
                  <Link
                    key={d.href}
                    href={d.href}
                    data-testid={id}
                    aria-current={active ? "page" : undefined}
                    aria-label={d.label}
                    aria-describedby={n > 0 ? `${id}-count` : undefined}
                    className={`relative flex min-w-0 flex-col items-center justify-center gap-[3px] rounded-[10px] text-[13px] leading-4 ${
                      active ? `bg-rail-active font-semibold text-rail-active-text ${TAB_BAR}` : "font-medium text-rail-text"
                    }`}
                  >
                    <Icon name={d.icon} stroke={1.7} />
                    {/* fix4 review: "One-pagers" fills a 390 px phone's fifth of the bar to the pixel; a hair tighter it is whole. */}
                    <span className="max-w-full truncate tracking-[-0.02em]">{d.label}</span>
                    {tabBadge(`${id}-count`, n, countWords(d.label, n))}
                  </Link>
                );
              })}
              <button
                type="button"
                aria-label="More"
                aria-describedby={moreCount > 0 ? "simple-tab-more-count" : undefined}
                aria-expanded={more}
                aria-controls="simple-more-sheet"
                data-testid="simple-tab-more"
                onClick={() => setMore((m) => !m)}
                className={`relative flex flex-col items-center justify-center gap-[3px] rounded-[10px] text-[13px] leading-4 ${
                  more || moreActive ? `bg-rail-active font-semibold text-rail-active-text ${TAB_BAR}` : "font-medium text-rail-text"
                }`}
              >
                <Icon name="more" stroke={1.7} />
                More
                {tabBadge("simple-tab-more-count", moreCount, `${moreCount} in More`)}
              </button>
            </nav>
            {/* qa-simple-home-19: Detailed's More sheet (its handle, title, close button and dimmed backdrop), sized to its links. */}
            <Sheet open={more} title="More" onClose={() => setMore(false)} testId="simple-more-sheet" id="simple-more-sheet" above>
              <div className="p-3">
                <ModeSwitch placement="sheet" />
                <ul className="grid grid-cols-2 gap-1">
                  {moreDests.map((d) => {
                    const n = countOf(d);
                    const id = `simple-more-${d.testId.slice("simple-nav-".length)}-count`;
                    return (
                      <li key={d.href}>
                        <Link
                          href={d.href}
                          aria-current={isActive(pathname, d) ? "page" : undefined}
                          aria-label={d.label}
                          aria-describedby={n > 0 ? id : undefined}
                          className="relative flex flex-col items-center gap-1 rounded-xl py-2.5 text-sm font-medium text-text hover:bg-surface2 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
                        >
                          <Icon name={d.icon} />
                          {d.label}
                          {tabBadge(id, n, countWords(d.label, n))}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                {account("sheet")}
              </div>
            </Sheet>
          </>,
          document.body,
        )}
    </>
  );
}
