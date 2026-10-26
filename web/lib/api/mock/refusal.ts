/**
 * The API's read-time rewrite of a stored error (oracle.claude_accounts.pool.readable_refusal,
 * #556, #561 review): each ISO moment in words in the Company time zone (one with no offset is
 * UTC; one that is no moment stays as it was), and a refusal ends its sentence. `past`: the
 * item failed, so the refusal says what was so when it ran, not now.
 */
import { inWords } from "@/lib/format";

import { companyZone } from "./connections";

const LEAD = /^No (other )?Claude account can take this call/;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/g;
const PAST: [RegExp, string][] = [
  [LEAD, "No $1Claude account could take this call"],
  [/\bevery Claude account is spent\b/g, "every Claude account was spent"],
  [/\bevery Claude account is paused, draining or needs a sign-in\b/g, "every Claude account was paused, draining or needed a sign-in"],
  [/\bno Claude account is registered\b/g, "no Claude account was registered"],
  [
    /\bno Claude account has a recent usage reading; the next sweep reads them\b/g,
    "no Claude account had a recent usage reading; the next sweep was due to read them",
  ],
  [/\bthe earliest window clears\b/g, "the earliest window was due to clear"],
];

function moment(iso: string, zone: string): string {
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`;
  // Python's fromisoformat refuses a month 13 or an hour 99; Date rolls some over, so check the fields too.
  const [y, mo, d, h, mi] = iso.match(/\d+/g)!.map(Number);
  const at = new Date(utc);
  if (Number.isNaN(at.getTime()) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || y < 1) return iso;
  return inWords(at.toISOString(), zone);
}

export function readableRefusal(text: string | null | undefined, past = false): string | null {
  if (!text) return text ?? null;
  const zone = companyZone();
  let out = text.replace(ISO, (m) => moment(m, zone));
  if (!LEAD.test(out)) return out;
  if (past) for (const [pattern, then] of PAST) out = out.replace(pattern, then);
  if (!/[.!?]\s*$/.test(out)) out = `${out.trimEnd()}.`;
  return out;
}
