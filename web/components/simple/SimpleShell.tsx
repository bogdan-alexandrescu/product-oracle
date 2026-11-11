"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Mark } from "@/components/ds/Brand";
import { Icon, type IconName } from "@/components/ds/Icon";
import { ModeSwitch, SEGMENTED } from "@/components/ds/ModeSwitch";
import { TAB_BAR } from "@/components/ds/rail";
import { Sheet } from "@/components/ds/Sheet";
import { setPanelOpen, usePanelOpen } from "@/components/hop/open-state";
import { SIMPLE_HOME, switchTarget } from "@/lib/experience";
import { useMe } from "@/lib/me";
import { LINK_KINDS } from "@/lib/roadmap-links";
import { api, unwrap } from "@/lib/api/client";
import { onReadChanged, onReadFailed, STALE_OK } from "@/lib/api/shared-reads";
import { onWaitingChanged, railInbox, railQuestions, readAgainLater, retryWait, waitingCount } from "@/lib/waiting";

type Dest = { label: string; href: string; icon: IconName; testId: string };

/** The Ask panel the rail's Ask Oracle opens (its aria-controls; SimpleAsk.tsx sets it on the docked panel). */
export const SIMPLE_ASK_PANEL_ID = "simple-ask-panel";

const noSubscribe = () => () => undefined;


/** Simple's destinations (#723, D10), in rail order: nothing of Detailed's rail. */
export const SIMPLE_DESTINATIONS: Dest[] = [
  { label: "Home", href: SIMPLE_HOME, icon: "home", testId: "simple-nav-home" },
  { label: "One-pagers", href: "/simple/one-pagers", icon: "doc", testId: "simple-nav-one-pagers" },
  { label: "Roadmap", href: "/simple/roadmap", icon: "roadmap", testId: "simple-nav-roadmap" },
  { label: "Goal map", href: "/simple/goals", icon: "target", testId: "simple-nav-goals" },
  { label: "Priorities", href: "/simple/priorities", icon: "priorities", testId: "simple-nav-priorities" },
  { label: "Meetings", href: "/simple/meetings", icon: "clock", testId: "simple-nav-meetings" },
  { label: "Decisions", href: "/simple/decisions", icon: "flag", testId: "simple-nav-decisions" },
  // inbox-meeting-proposals owner: the one Inbox (Detailed's too), with every proposal waiting on me;
  // S-7: in Simple's shell, so the person stays in Simple.
  { label: "Inbox", href: "/simple/inbox", icon: "inbox", testId: "simple-nav-inbox" },
];

/** Phone tab bar: Home, One-pagers, Roadmap, Decisions, More (Detailed's pattern). */
const TABS = ["Home", "One-pagers", "Roadmap", "Decisions"];

function isActive(pathname: string, d: Dest): boolean {
  if (d.href === SIMPLE_HOME) return pathname === SIMPLE_HOME;
  return pathname === d.href || pathname.startsWith(`${d.href}/`);
}

/**
 * The rail's yellow counts (S1 restyle, the owner's pick): only what waits on the signed-in
 * person, from the one list Home and Decisions read (home-waiting-one-list, GET
 * /v1/simple/decisions/waiting `items`), so a count always matches its page: Decisions counts
 * everything in it (its "Waiting for you"); Roadmap the roadmap's part (its broken links,
 * as the roadmap counts them, dates to confirm, suggested features, proposals and drafts sent to me); Meetings only a
 * meeting live now (an upcoming one waits on nobody).
 * Inbox counts what waits on me as /inbox's "N waiting" does (lib/waiting,
 * inbox-meeting-proposals); what of it the Roadmap tab does not count already (Oracle's dates,
 * goal suggestions, one-pager wordings, question proposals) is "Inbox beyond the tabs", which
 * More sums. Read when the rail mounts, on a route change and whenever something waiting changes.
 */
function useSimpleCounts(enabled: boolean): { counts: Record<string, number>; failed: Set<string> } | null {
  const pathname = usePathname();
  // Each part's last answer, or that its last read failed (counts-wait review).
  const [got, setGot] = useState<Got>({});
  const [changes, setChanges] = useState(0);
  // counts-failed-part: a read's answer older than the part's latest read is dropped; reads in flight
  // hold the next wait until they finish; fails counts each part's failed reads in a row, which back
  // its re-reads off, and only that part's own read that answers sets it back to 0.
  const seq = useRef<Record<string, number>>({});
  const inflight = useRef(0);
  const fails = useRef<Partial<Record<Part, number>>>({});
  // The re-read waiting to run (its cancel), and the reads' abort on unmount.
  const pending = useRef<(() => void) | null>(null);
  const aborts = useRef(new AbortController());
  const [settled, setSettled] = useState(0);
  useEffect(() => onWaitingChanged(() => setChanges((c) => c + 1)), []);
  useEffect(() => {
    const ctrl = (aborts.current = new AbortController());
    return () => ctrl.abort();
  }, []);
  // fresh: a page change or a change to what waits (not a re-read of a failed part): it drops the
  // re-read waiting to run, so no part is read twice at once; the back-off goes on.
  // staleOk: false for a part whose read again failed elsewhere, so it is read now and never shown from before.
  const read = useCallback((parts: Part[], fresh: boolean, staleOk = true) => {
    if (fresh) {
      pending.current?.();
      pending.current = null;
    }
    const { signal } = aborts.current;
    const mine = parts.map((p) => (seq.current[p] = (seq.current[p] ?? 0) + 1));
    inflight.current += 1;
    void Promise.allSettled(parts.map((p) => PART_READS[p](signal, staleOk))).then((results) => {
      inflight.current -= 1;
      if (signal.aborted) return;
      const next: Got = {};
      results.forEach((r, i) => {
        const p = parts[i]!;
        if (seq.current[p] !== mine[i]) return;
        fails.current[p] = r.status === "fulfilled" ? 0 : (fails.current[p] ?? 0) + 1;
        Object.assign(next, { [p]: r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false } });
      });
      setGot((g) => ({ ...g, ...next }));
      setSettled((n) => n + 1);
    });
  }, []);
  // home-waiting-one-list: Decisions counts the one list of what waits on me. The Roadmap's
  // count is its "Needs a decision" count; roadmap-decide: its broken links are those of the
  // whole working draft as I see it (GET /v1/simple/roadmap/waiting, a light count), the same
  // ones the roadmap's strip, its Needs a decision and Home count, with the dates I may confirm
  // and the proposals and drafts waiting on me.
  // counts-wait review: each read settles on its own, so one that fails marks the counts it adds to
  // and the rest still show.
  useEffect(() => {
    if (enabled) read(["waiting", "roadmap", "inbox", "questions", "goals"], true);
  }, [enabled, pathname, changes, read]);
  // simple-call-budget: a part read since (by the page, or behind the counts shown) answered
  // something new: that part reads it again (shared, so no call), the rest keep their waits.
  useEffect(() => onReadChanged((url) => PART_BY_URL.has(url) && read([PART_BY_URL.get(url)!], false)), [read]);
  // counts-failed-part: a read again of a part's list failed (the page's, or one behind the count shown):
  // that part reads it now, not stale-ok, so it shows no number rather than the last one.
  useEffect(() => onReadFailed((url) => PART_BY_URL.has(url) && read([PART_BY_URL.get(url)!], false, false)), [read]);
  const meetingsPath = pathname.startsWith("/simple/meetings") ? pathname : "";
  useEffect(() => {
    if (enabled) read(["meetings"], true);
  }, [enabled, changes, meetingsPath, read]);
  // counts-failed-part: while a part failed, read that part again once the reads have finished, after
  // a wait that doubles with each of its failed reads in a row, whatever started them (15 s, 30 s,
  // 60 s, ... up to 5 min), and never while the tab is hidden.
  const failedParts = PARTS.filter((p) => got[p]?.ok === false).join(",");
  useEffect(() => {
    if (!enabled || !failedParts || inflight.current > 0) return;
    // The failed parts are read again together, after the wait of the one that failed most.
    const tries = Math.max(...(failedParts.split(",") as Part[]).map((p) => fails.current[p] ?? 1));
    const cancel = readAgainLater(retryWait(tries - 1), () => {
      pending.current = null;
      read(failedParts.split(",") as Part[], false);
    });
    pending.current = cancel;
    return () => {
      cancel();
      if (pending.current === cancel) pending.current = null;
    };
  }, [enabled, failedParts, settled, read]);
  // counts-wait: no count (nor More's sum) shows until every read has answered, so none jumps.
  if (PARTS.some((p) => !got[p])) return null;
  const value = <P extends Part>(p: P): Reads[P] | null => {
    const r = got[p];
    return r?.ok ? (r.value as Reads[P]) : null;
  };
  const waiting = value("waiting");
  const roadmap = value("roadmap");
  const inbox = value("inbox");
  const questions = value("questions");
  const goalSuggestions = value("goals");
  const meetings = value("meetings");
  const items = waiting?.items ?? [];
  // Without the light count, the strip's own rule over the list: each link between items
  // (a dependency out of order, a cut item others depend on), not an end past its milestone.
  const links = roadmap?.broken_links ?? items.filter((i) => i.kind === "broken_link" && LINK_KINDS.some((k) => i.key.split(":")[2] === k)).length;
  const dates = roadmap?.dates_to_confirm ?? items.filter((i) => i.kind === "date" && !i.key.startsWith("proposal:")).length;
  // The suggested features Needs a decision lists and counts (the same read and filter as its panel).
  const suggested = (goalSuggestions?.suggestions ?? []).filter((s) => s.can_accept || s.can_reject).length;
  // PR 1320 re-review: a one-pager number fix (set_section_number) is the one-pager's, not the
  // roadmap's: it counts in the Inbox beyond the tabs, as a one-pager wording does.
  const asks = items.filter((i) => (i.kind === "proposal" && i.op !== "set_section_number") || i.kind === "draft" || (i.kind === "date" && i.key.startsWith("proposal:"))).length;
  // inbox-meeting-proposals fix: the Inbox's part the Roadmap tab counts too (a proposal on a
  // PRD question or a one-pager line or number is not the roadmap's).
  const inboxRoadmap = inbox
    ? inbox.simple_proposals.filter((x) => !["decide_question", "name_decider", "edit_line", "set_section_number"].includes(x.op)).length +
      inbox.simple_approvals.length +
      inbox.simple_goal_suggestions.length +
      (inbox.simple_track_suggestions?.filter((x) => !x.proposed).length ?? 0)
    : 0;
  const all = inbox ? waitingCount(inbox, questions ?? []) : 0;
  // qa-simple-decide-51: "Meetings live": the yellow count only when one is on now.
  // counts-failed-part: a failed meetings read shows no number, never the last one it read.
  const live = meetings?.live.length ?? 0;
  return {
    counts: {
      Decisions: items.length,
      Roadmap: links + dates + suggested + asks,
      "Roadmap links": links,
      "Roadmap dates": dates,
      "Roadmap suggested": suggested,
      "Roadmap asks": asks,
      Inbox: all,
      // What waits in the Inbox beyond what the tabs count (More sums it).
      "Inbox beyond the tabs": Math.max(0, all - inboxRoadmap),
      Meetings: live,
      "Meetings live": live,
    },
    failed: new Set([
      ...(waiting ? [] : ["Decisions"]),
      ...(waiting && goalSuggestions ? [] : ["Roadmap"]),
      ...(inbox && questions ? [] : ["Inbox", "Inbox beyond the tabs"]),
      ...(meetings ? [] : ["Meetings"]),
    ]),
  };
}

/**
 * The parts the rail's counts add up, each read on its own. The rail's own reads stop when it
 * unmounts (`signal`); a read it shares with the page (lib/api/shared-reads) runs on for the page.
 * simple-call-budget: each is stale-ok, so moving between pages shows the counts read a moment
 * ago at once instead of reading every list again; an answer that changed since reads them again.
 */
const rail = (staleOk: boolean) => (staleOk ? { headers: { [STALE_OK]: "1" } } : {});
const PART_READS = {
  waiting: (signal: AbortSignal, staleOk: boolean) => unwrap(api.GET("/v1/simple/decisions/waiting", { ...rail(staleOk), signal })),
  // A failed light count falls back to the one list (never a failed part).
  roadmap: (signal: AbortSignal, staleOk: boolean) => unwrap(api.GET("/v1/simple/roadmap/waiting", { ...rail(staleOk), signal })).catch(() => null),
  inbox: (signal: AbortSignal, staleOk: boolean) => railInbox(signal, staleOk),
  questions: (signal: AbortSignal, staleOk: boolean) => railQuestions(signal, staleOk),
  goals: (signal: AbortSignal, staleOk: boolean) => unwrap(api.GET("/v1/simple/goal-suggestions", { params: { query: { status: "open" } }, ...rail(staleOk), signal })),
  meetings: (signal: AbortSignal, staleOk: boolean) => unwrap(api.GET("/v1/simple/meetings", { ...rail(staleOk), signal })),
};
const PART_BY_URL = new Map<string, Part>([
  ["/v1/simple/decisions/waiting", "waiting"],
  ["/v1/simple/roadmap/waiting", "roadmap"],
  ["/v1/inbox", "inbox"],
  ["/v1/inbox/questions", "questions"],
  ["/v1/simple/goal-suggestions?status=open", "goals"],
  ["/v1/simple/meetings", "meetings"],
]);
type Part = keyof typeof PART_READS;
type Reads = { [P in Part]: Awaited<ReturnType<(typeof PART_READS)[P]>> };
type Got = { [P in Part]?: { ok: true; value: Reads[P] } | { ok: false } };
const PARTS = Object.keys(PART_READS) as Part[];

/** A count whose part failed (counts-wait review): its words say so, or alone when no number shows. */
function failedWords(words: string, n: number): string {
  return n > 0 ? `${words}; a part could not load` : "Could not load";
}

/** What a rail count counts, said in words (its accessible name and tooltip). */
function countWords(label: string, n: number, counts?: Record<string, number> | null): string {
  if (label === "Meetings") return `${n} ${n === 1 ? "meeting" : "meetings"} live now`;
  // roadmap-decide: Roadmap counts the broken links (as the roadmap and Home count them), the
  // dates to confirm and the changes and drafts sent to you, and says each.
  if (label === "Roadmap") {
    const links = counts?.["Roadmap links"] ?? 0;
    const dates = counts?.["Roadmap dates"] ?? 0;
    const suggested = counts?.["Roadmap suggested"] ?? 0;
    const asks = counts?.["Roadmap asks"] ?? n - links - dates - suggested;
    const features = suggested ? `${suggested} suggested ${suggested === 1 ? "feature" : "features"}, ` : "";
    return `${n} on the roadmap waiting on you: ${links} broken ${links === 1 ? "link" : "links"}, ${dates} ${dates === 1 ? "date" : "dates"} to confirm, ${features}${asks} ${asks === 1 ? "change or draft" : "changes or drafts"}`;
  }
  return `${n} waiting on you`;
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
  const read = useSimpleCounts(!!me);
  const counts = read?.counts ?? null;
  // counts-wait review: a count missing a part whose read failed shows the could-not-load mark (no number) or says it.
  const failedOf = (label: string) => !!read?.failed.has(label);
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
        className="sticky top-0 z-40 col-start-1 row-start-1 flex h-dvh w-[var(--simple-rail-width)] flex-col gap-1 bg-rail px-4 py-5 [border-right:var(--simple-rail-border)] max-[600px]:hidden simple-noprint"
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
  // inbox-meeting-proposals owner: the Inbox's count repeats what the tabs count (Roadmap's proposals), so More's sum takes
  // only the rest of it (fix: Oracle's dates, a goal's suggestions, a one-pager wording, a question's proposal light More).
  const summed = moreDests.filter((d) => d.label !== "Inbox");
  const inboxRest = moreDests.some((d) => d.label === "Inbox") ? (counts?.["Inbox beyond the tabs"] ?? 0) : 0;
  const moreCount = summed.reduce((sum, d) => sum + countOf(d), 0) + inboxRest;
  // qa4-simple-home-22: a count that needs nothing from you (Meetings with none live) is grey on the phone as on the rail; More is
  // yellow only when something in it waits on you.
  const quietOf = (d: Dest) => d.label === "Meetings" && !counts?.["Meetings live"];
  const moreQuiet = inboxRest === 0 && summed.every((d) => countOf(d) === 0 || quietOf(d));
  const moreFailed = summed.some((d) => failedOf(d.label)) || (moreDests.some((d) => d.label === "Inbox") && failedOf("Inbox beyond the tabs"));
  const shownOf = (d: Dest) => countOf(d) > 0 || failedOf(d.label);
  const tabBadge = (id: string, n: number, words: string, quiet = false, failed = false) =>
    (n > 0 || failed) && (
      <span
        id={id}
        data-testid={id}
        // A count's words are its name: on an element with a role, so assistive tech reads them.
        role="img"
        aria-label={failed ? failedWords(words, n) : words}
        title={failed ? failedWords(words, n) : words}
        className={`simple-count simple-count-tab tnum${quiet || n === 0 ? " simple-count-quiet" : ""}`}
      >
        {n > 0 ? n : <Icon name="alert" size={16} />}
      </span>
    );

  return (
    <>
      {/* qa-simple-home-6: from 1200 px the open Ask panel sits beside the page (it keeps the shell's third column), not over it. */}
      {askOpen && me && !/\/present\/?$/.test(pathname) && <span aria-hidden data-testid="simple-ask-room" className="simple-noprint col-start-3 row-start-1 hidden w-[400px] min-[1200px]:block" />}
      {/* fix4 qa-simple-roadmap-46: the rail's colour runs the page's full height (the sticky rail is one
       * screen tall), and the rail sits under a page's dimmed backdrop (z-35) like the page. */}
      <span aria-hidden data-testid="simple-nav-underlay" className="col-start-1 row-start-1 self-stretch bg-rail [border-right:var(--simple-rail-border)] max-[600px]:hidden simple-noprint" />
      <nav
        aria-label="Simple"
        data-testid="simple-nav"
        className="sticky top-0 z-30 col-start-1 row-start-1 flex h-dvh w-[var(--simple-rail-width)] flex-col gap-1 bg-rail px-4 py-5 [--focus-ring:var(--accent)] [border-right:var(--simple-rail-border)] max-[600px]:hidden simple-noprint"
      >
        <Link href={SIMPLE_HOME} aria-label="Product Oracle" data-testid="simple-nav-brand" className="mb-4 flex flex-none items-center gap-2.5 rounded-xl px-2">
          <Mark size={32} tone="current" className="block text-accent-ink" />
          <span className="font-display text-[18px] font-semibold whitespace-nowrap text-rail-active-text">Product Oracle</span>
        </Link>
        <ModeSwitch placement="wide" />
        {SIMPLE_DESTINATIONS.map((d) => {
          const n = counts?.[d.label] ?? 0;
          const failed = failedOf(d.label);
          const words = failed ? failedWords(countWords(d.label, n, counts), n) : countWords(d.label, n, counts);
          return (
            <Link
              key={d.href}
              href={d.href}
              data-testid={d.testId}
              aria-current={isActive(pathname, d) ? "page" : undefined}
              // The destination is the link's name; its count is the description (never "Meetings 3").
              aria-label={d.label}
              aria-describedby={shownOf(d) ? `${d.testId}-count` : undefined}
              className="flex h-12 items-center gap-3 rounded-xl px-3 text-[length:var(--simple-rail-label)] leading-6 font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text aria-[current=page]:bg-rail-active aria-[current=page]:font-semibold aria-[current=page]:text-rail-active-text"
            >
              <Icon name={d.icon} stroke={1.7} />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              {(n > 0 || failed) && (
                <span id={`${d.testId}-count`} data-testid={`${d.testId}-count`} role="img" aria-label={words} title={words} className={`simple-count tnum ${(d.label === "Meetings" && !counts?.["Meetings live"]) || n === 0 ? "simple-count-quiet" : ""}`}>
                  {n > 0 ? n : <Icon name="alert" size={16} />}
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
                (personLine); the email on one line (qa4-simple-home-20). With no name the avatar says the
                email to a screen reader (its "Account <email>" name), so this line is hidden from it. */}
            <span
              data-testid="simple-person-name"
              title={me?.email || me?.name || undefined}
              aria-hidden={!!me?.email && personLine(me) === me.email ? true : undefined}
              className={`font-semibold text-rail-active-text ${me?.email && personLine(me) === me.email ? "truncate text-[13px]" : "text-[15px] [overflow-wrap:break-word]"}`}
            >
              {/* qa4-simple-home-20: an email stays on one line, a size smaller so a short one shows whole; a long one is cut with an ellipsis (whole in its tooltip). */}
              {personLine(me)}
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
              className="simple-noprint fixed inset-x-0 bottom-0 z-[39] hidden h-[var(--phone-tab-bar)] grid-cols-5 bg-rail-foot px-1.5 [--focus-ring:var(--rail-bar)] [border-top:var(--simple-rail-border)] pt-1.5 pb-2 max-[600px]:grid"
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
                    aria-describedby={shownOf(d) ? `${id}-count` : undefined}
                    className={`relative flex min-w-0 flex-col items-center justify-center gap-[3px] rounded-[10px] text-[13px] leading-4 ${
                      active ? `bg-rail-active font-semibold text-rail-active-text ${TAB_BAR}` : "font-medium text-rail-text"
                    }`}
                  >
                    <Icon name={d.icon} stroke={1.7} />
                    {/* fix4 review: "One-pagers" fills a 390 px phone's fifth of the bar to the pixel; a hair tighter it is whole. */}
                    <span className="max-w-full truncate tracking-[-0.02em]">{d.label}</span>
                    {tabBadge(`${id}-count`, n, countWords(d.label, n, counts), quietOf(d), failedOf(d.label))}
                  </Link>
                );
              })}
              <button
                type="button"
                aria-label="More"
                aria-describedby={moreCount > 0 || moreFailed ? "simple-tab-more-count" : undefined}
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
                {tabBadge("simple-tab-more-count", moreCount, `${moreCount} in More`, moreQuiet, moreFailed)}
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
                          aria-describedby={shownOf(d) ? id : undefined}
                          className="relative flex flex-col items-center gap-1 rounded-xl py-2.5 text-sm font-medium text-text hover:bg-surface2 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
                        >
                          <Icon name={d.icon} />
                          {d.label}
                          {tabBadge(id, n, countWords(d.label, n, counts), quietOf(d), failedOf(d.label))}
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
