import Link from "next/link";

import type { Schemas } from "@/lib/api/client";
import { datesInWords } from "@/lib/dates";

/*
 * decisions-reversed-or-trashed banner: an open draft's notes about the decisions it cited
 * (decision_notes, "D-12 Cut bulk export was reversed: <why>") and a read's left_out line
 * ("Left out, no longer standing: D-9 Ship alerts by email only (about a roadmap now in
 * Trash)."), drawn in the draft banner as plain words: "Decision 12 Cut bulk export", linked
 * to it in Company › Decisions.
 */

const decisionHref = (n: string) => `/company/decisions?d=${n}`;
/** "D-12" read out as "Decision 12" wherever a text names one unparsed. */
const plain = (text: string) => datesInWords(text.replace(/\bD-(\d+)\b/g, "Decision $1"));

function DecisionLink({ n, title }: { n: string; title: string }) {
  return (
    <Link href={decisionHref(n)} className="font-semibold underline underline-offset-2 hover:no-underline" data-testid="decision-note-link">
      Decision {n} {title}
    </Link>
  );
}

// oracle.decisions.standing.note_reversed: "D-<n> <title> was reversed[ on <day>]: <note>".
const NOTE = /^D-(\d+) (.+?) was (reversed|withdrawn|replaced by a later decision)( on [^:]+)?(?::\s*([\s\S]*))?$/;

function Note({ text }: { text: string }) {
  const m = NOTE.exec(text.trim());
  if (!m) return <>{plain(text)}</>;
  const [, n, title, why, on, note] = m;
  const said = note?.trim().replace(/\.$/, "");
  return (
    <>
      <DecisionLink n={n} title={title} /> was {why}
      {on ? datesInWords(on) : ""}; the next draft no longer relies on it.
      {said ? ` Why: ${plain(said)}.` : ""}
    </>
  );
}

/** The draft's decision notes, one line each; nothing when there are none. */
export function DecisionNotes({ notes, className = "" }: { notes: string[]; className?: string }) {
  const shown = [...new Set(notes.filter((n) => n.trim()))];
  if (!shown.length) return null;
  return (
    <ul className={`space-y-0.5 ${className}`} data-testid="decision-notes" aria-label="Decisions this draft cited">
      {shown.map((t) => (
        <li key={t} data-testid="decision-note">
          <Note text={t} />
        </li>
      ))}
    </ul>
  );
}

// oracle.decisions.standing.LeftOut.line: "D-<n> <title> (<why>)", joined by "; ".
const LEFT_OUT = /D-(\d+) (.+?) \(([^()]*)\)(?=; D-\d+ |\.?$)/g;
const PREFIX = "Left out, no longer standing: ";

/** A read's left_out entry as one quiet line; nothing when the read left nothing out. */
export function LeftOutLine({ leftOut, className = "" }: { leftOut?: Schemas["SimpleLeftOut"] | null; className?: string }) {
  if (!leftOut?.title) return null;
  const body = leftOut.title.startsWith(PREFIX) ? leftOut.title.slice(PREFIX.length) : null;
  const parts = body ? [...body.matchAll(LEFT_OUT)] : [];
  return (
    <p className={className} data-testid="left-out-line">
      {parts.length ? (
        <>
          {PREFIX}
          {parts.map((m, i) => (
            <span key={m[1]}>
              {i > 0 && "; "}
              <DecisionLink n={m[1]} title={m[2]} /> ({m[3]})
            </span>
          ))}
          .
        </>
      ) : (
        plain(leftOut.title)
      )}
    </p>
  );
}
