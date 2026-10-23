"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { splitCodes, type CodeEntry, type CodeIndex } from "@/lib/code-index";
import { named, useCompanyCodes, useNames, type Named } from "@/lib/codes";
import { sectionHash } from "@/lib/section-link";

const OPEN_DELAY = 250;
const CLOSE_DELAY = 150;
const PHONE = "(max-width: 639px)";

/** One card is open at a time: opening one closes the last. */
let closeOpen: (() => void) | null = null;

/**
 * The one hover-and-tap card (#304) behind a chip. It opens on hover (after a short delay),
 * on keyboard focus and on tap, and closes with Escape and on a click outside. Below 640 px
 * it is a bottom sheet. The card sits in a portal, so a narrow table cell never clips it.
 */
export function HoverCard({
  trigger,
  label,
  children,
  className = "",
  unstyled = false,
  testId,
}: {
  /** The chip's content, drawn inside its button. */
  trigger: ReactNode;
  /** The button's accessible name. */
  label: string;
  children: ReactNode;
  className?: string;
  /** The trigger takes only `className` (a chip with its own styles). */
  unstyled?: boolean;
  testId?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; phone: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    clear();
    setOpen(true);
  };
  const hide = () => {
    clear();
    pinned.current = false;
    setOpen(false);
  };
  const later = (fn: () => void, ms: number) => {
    clear();
    timer.current = setTimeout(fn, ms);
  };

  useEffect(() => clear, []);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const phone = window.matchMedia(PHONE).matches;
    setAt({ top: r.bottom + 6, left: Math.max(12, Math.min(r.left, vw - 332)), phone });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (closeOpen) closeOpen();
    const mine = () => {
      pinned.current = false;
      setOpen(false);
    };
    closeOpen = mine;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !card.current?.contains(t)) hide();
    };
    const onScroll = (e: Event) => {
      if (!card.current?.contains(e.target as Node) && !window.matchMedia(PHONE).matches) hide();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (closeOpen === mine) closeOpen = null;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
    // hide only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stay = () => clear();
  const leave = () => {
    if (!pinned.current) later(() => setOpen(false), CLOSE_DELAY);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={testId}
        onMouseEnter={() => (open ? stay() : later(show, OPEN_DELAY))}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={(e) => {
          if (!card.current?.contains(e.relatedTarget as Node) && !pinned.current) setOpen(false);
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (pinned.current) hide();
          else {
            pinned.current = true;
            show();
          }
        }}
        className={unstyled ? className : `inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-goal text-left align-middle outline-offset-2 ${className}`}
      >
        {trigger}
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="tooltip"
            data-testid="code-card"
            data-sheet={at.phone ? "true" : undefined}
            onMouseEnter={stay}
            onMouseLeave={leave}
            onBlur={(e) => {
              if (!card.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== button.current && !pinned.current) setOpen(false);
            }}
            style={at.phone ? undefined : { top: at.top, left: at.left }}
            className={`z-[60] text-left text-sm leading-5 font-normal tracking-normal whitespace-normal text-text ${
              at.phone
                ? "fixed inset-x-0 bottom-0 rounded-t-inspector border-t border-line bg-surface px-4 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))] shadow-tip"
                : "fixed w-80 max-w-[calc(100vw-24px)] rounded-panel border border-line bg-surface p-3 shadow-tip"
            }`}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The card's head line ("Goal · confirmed") and its rows. */
export function CardEyebrow({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-[13px] font-semibold tracking-[0.02em] text-text2">{children}</span>;
}

/** The code, mono in a goal-tag box: `[G-B]`. */
export function CodeTag({ code, proposed = false }: { code: string; proposed?: boolean }) {
  return (
    <span
      data-testid="code-tag"
      className={`tnum inline-grid h-6 flex-none place-items-center rounded-goal px-[7px] font-mono text-[13px] leading-none font-medium ${
        proposed ? "bg-warn-bg text-warn" : "bg-accent-soft text-accent-ink"
      }`}
    >
      {code}
    </span>
  );
}

const STATE: Record<string, string> = { confirmed: "confirmed", proposed: "proposed", rejected: "rejected" };

type ChipProps = {
  kind: "goal" | "feature";
  entityKey?: string | null;
  entityId?: string | null;
  /** The title the caller knows; the card reads the company's lookup for the rest. */
  title?: string | null;
  proposed?: boolean;
};

/**
 * One shared code chip (#304): the code, then the name (`[G-B] Growth`), the name cut with
 * "…" where the cell is narrow, and the card behind it. The chip draws the title it is
 * given; the card, once opened, finds the goal or feature (by `entityId` or `entityKey`)
 * in the company's one cached lookup for its state, target and page.
 */
export function CodeChip({
  wrap = false,
  codeOnly = false,
  testId = "code-chip",
  ...p
}: ChipProps & {
  /** The name wraps onto two lines instead of being cut on one. */
  wrap?: boolean;
  /** Only the code (none when there is no code): the caller draws the name beside it. */
  codeOnly?: boolean;
  testId?: string;
}) {
  const n: Named = named(p.title ?? "", p.entityKey);
  const label = n.name || (p.kind === "goal" ? "Goal" : "Feature");
  if (codeOnly && !n.code) return null;
  return (
    <HoverCard
      testId={testId}
      label={n.code ? `${n.code} ${label}` : label}
      className={codeOnly ? "flex-none" : "max-w-full"}
      trigger={
        <>
          {n.code && <CodeTag code={n.code} proposed={p.proposed} />}
          {!codeOnly && (
            <span
              data-testid="code-name"
              className={`min-w-0 font-medium ${wrap ? "line-clamp-2" : "truncate"} ${p.proposed && !n.code ? "text-warn" : ""}`}
            >
              {label}
            </span>
          )}
        </>
      }
    >
      <CodeCard {...p} />
    </HoverCard>
  );
}

/** The card's body: mounted when the card opens, so the lookup loads only then. */
function CodeCard({ kind, entityKey, entityId, title, proposed }: ChipProps) {
  const names = useNames();
  const e = (entityId ? names?.byId.get(entityId) : undefined) ?? (entityKey ? names?.byKey.get(entityKey) : undefined);
  const n = named(e?.title ?? title ?? "", e?.key ?? entityKey);
  const status = e?.status ?? (proposed ? "proposed" : undefined);
  const label = n.name || (kind === "goal" ? "Goal" : "Feature");
  const line =
    kind === "goal"
      ? e?.attrs?.target != null && e.attrs.target !== ""
        ? `Target ${String(e.attrs.target)}`
        : null
      : typeof e?.attrs?.status === "string" && e.attrs.status
        ? e.attrs.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
        : null;
  return (
    <>
      <CardEyebrow>
        {kind === "goal" ? "Goal" : "Feature"}
        {status && STATE[status] ? ` · ${STATE[status]}` : ""}
      </CardEyebrow>
      <span className="flex min-w-0 items-start gap-2">
        {n.code && <CodeTag code={n.code} proposed={status === "proposed"} />}
        <span className="min-w-0 font-semibold break-words" data-testid="card-name">
          {label}
        </span>
      </span>
      {line && (
        <span className="tnum mt-1.5 block text-text2" data-testid="card-line">
          {line}
        </span>
      )}
      {e && (
        <Link href={`/baseline?entity=${e.id}`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent-ink hover:underline">
          Open
        </Link>
      )}
    </>
  );
}

/**
 * A known code in agent-written text (#305): the code as written, with a dotted underline,
 * and the same card as the app's own chips. The button's text is the text unchanged, so a
 * PRD section's anchorable text (comments, highlights) stays the same.
 */
export function NamedCode({ text, entry }: { text: string; entry: CodeEntry }) {
  return (
    <HoverCard
      unstyled
      testId="named-code"
      label={`${entry.code} ${entry.name}`}
      className="named-code cursor-help rounded-goal underline decoration-text2 decoration-dotted underline-offset-[3px] outline-offset-2"
      trigger={text}
    >
      <CardEyebrow>
        {entry.kind}
        {entry.from ? ` · ${entry.from}` : ""}
      </CardEyebrow>
      <span className="flex min-w-0 items-start gap-2">
        <CodeTag code={entry.code} proposed={entry.from === "proposed"} />
        <span className="min-w-0 font-semibold break-words" data-testid="card-name">
          {entry.name}
        </span>
      </span>
      {entry.line && (
        <span className="mt-1.5 block text-text2" data-testid="card-line">
          {entry.line}
        </span>
      )}
      {entry.members && (
        <ul className="mt-1.5 flex max-h-48 flex-col gap-0.5 overflow-y-auto text-text2" data-testid="card-members">
          {entry.members.map((m) => (
            <li key={m.code}>
              <span className="font-mono text-[13px]">{m.code}</span> {m.name}
            </li>
          ))}
        </ul>
      )}
      {entry.sectionKey ? (
        <a href={sectionHash(entry.sectionKey)} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent-ink hover:underline">
          Go to section
        </a>
      ) : entry.entityId ? (
        <Link href={`/baseline?entity=${entry.entityId}`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent-ink hover:underline">
          Open
        </Link>
      ) : null}
    </HoverCard>
  );
}

/** Text with each known code drawn as a NamedCode; unknown codes stay plain. */
export function withCodes(text: string, index: CodeIndex | undefined, key = "c"): ReactNode {
  if (!index?.size) return text;
  const pieces = splitCodes(text, index);
  if (pieces.length === 1 && typeof pieces[0] === "string") return text;
  return pieces.map((p, i) => (typeof p === "string" ? p : <NamedCode key={`${key}-${i}`} text={p.text} entry={p.entry} />));
}

/** Agent-written plain text (a proposal, a checkpoint note, an Inbox row) with the company's codes named. */
export function CodeText({ text }: { text: string }) {
  const index = useCompanyCodes();
  return <>{withCodes(text, index)}</>;
}
