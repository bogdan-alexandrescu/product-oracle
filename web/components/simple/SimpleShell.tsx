"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Mark } from "@/components/ds/Brand";
import { Icon, type IconName } from "@/components/ds/Icon";
import { ModeSwitch } from "@/components/ds/ModeSwitch";
import { RAIL_SELECTED, TAB_BAR } from "@/components/ds/rail";
import { SIMPLE_HOME, switchTarget } from "@/lib/experience";
import { useMe } from "@/lib/me";

type Dest = { label: string; href: string; icon: IconName; testId: string };

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
 * Simple's rail (#723 S1): the [Simple | Detailed] switch on top, its six destinations and the
 * user menu; on a phone, the same bottom tab bar and More drawer Detailed uses. Its look comes
 * from the rail tokens under html[data-mode="simple"] (globals.css). While Simple is off, a
 * Simple page opens its matching Detailed page instead.
 */
export function SimpleNavs({ account }: { account: (placement: "rail" | "sheet") => ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, capsReady, simpleMode } = useMe();
  const [more, setMore] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMore(false);
  }
  const off = !!me && capsReady && !simpleMode;
  useEffect(() => {
    if (off) router.replace(switchTarget(pathname, "detailed"));
  }, [off, pathname, router]);

  const shown = useSimpleShown();
  if (!shown) return null;

  const tabDests = TABS.map((t) => SIMPLE_DESTINATIONS.find((d) => d.label === t)!);
  const moreDests = SIMPLE_DESTINATIONS.filter((d) => !TABS.includes(d.label));
  const moreActive = moreDests.some((d) => isActive(pathname, d));

  return (
    <>
      <nav
        aria-label="Simple"
        data-testid="simple-nav"
        className="sticky top-0 z-40 col-start-1 row-start-1 flex h-dvh w-[88px] flex-col items-center gap-0.5 bg-rail py-3.5 [--focus-ring:var(--rail-bar)] [border-right:var(--simple-rail-border)] max-[600px]:hidden"
      >
        <Link href={SIMPLE_HOME} aria-label="Product Oracle" data-testid="simple-nav-brand" className="mb-3 flex-none rounded-xl">
          <Mark size={44} tone="sky" className="block" />
        </Link>
        <ModeSwitch placement="rail" />
        {SIMPLE_DESTINATIONS.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            data-testid={d.testId}
            aria-current={isActive(pathname, d) ? "page" : undefined}
            className={`relative flex w-[70px] flex-col items-center gap-0.5 rounded-[10px] pt-[7px] pb-1.5 text-[13px] leading-4 font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${RAIL_SELECTED}`}
          >
            <Icon name={d.icon} stroke={1.7} />
            {d.label}
          </Link>
        ))}
        <span className="flex-1" />
        {account("rail")}
      </nav>

      <nav
        aria-label="Simple"
        data-testid="simple-tab-bar"
        className="fixed inset-x-0 bottom-0 z-40 hidden h-[68px] grid-cols-5 bg-rail-foot px-1.5 [--focus-ring:var(--rail-bar)] [border-top:var(--simple-rail-border)] pt-1.5 pb-2 max-[600px]:grid"
      >
        {tabDests.map((d) => {
          const active = isActive(pathname, d) && !more;
          return (
            <Link
              key={d.href}
              href={d.href}
              data-testid={`simple-tab-${d.testId.slice("simple-nav-".length)}`}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-w-0 flex-col items-center justify-center gap-[3px] rounded-[10px] text-[13px] leading-4 ${
                active ? `bg-rail-active font-semibold text-rail-active-text ${TAB_BAR}` : "font-medium text-rail-text"
              }`}
            >
              <Icon name={d.icon} stroke={1.7} />
              <span className="max-w-full truncate">{d.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
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
        </button>
      </nav>
      {more && (
        <div
          id="simple-more-sheet"
          role="dialog"
          aria-label="More"
          className="fixed inset-x-0 bottom-[68px] z-40 hidden rounded-t-inspector border-t border-line bg-surface p-3 shadow-tip max-[600px]:block"
        >
          <ModeSwitch placement="sheet" />
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
          {account("sheet")}
        </div>
      )}
    </>
  );
}
