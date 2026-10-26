"use client";

import type { Schemas } from "@/lib/api/client";

type Finding = Schemas["LeakFindingOut"];

/** The leak check's finding codes, as a person reads them. */
const FINDING: Record<string, string> = {
  person_name: "Person name",
  email_or_phone: "Email or phone",
  customer_name: "Customer name",
  alternative_name: "Alternative name",
  internal_code: "Internal code",
  internal_host: "Internal address",
  internal_document: "Approvers-only document",
  decision: "Decision",
  pricing: "Plan or price",
  internal_note: "Internal note",
  money_or_metric: "Money or metric",
  date: "Date",
  internal_title_copy: "Internal title copy",
};
export const findingLabel = (code: string) => FINDING[code] ?? code.replace(/_/g, " ");
export const findingText = (f: Finding) => `${findingLabel(f.code)}: ${f.words.join(", ")}`;

/** A text's parts, each as "where" reads it: ["the public title", "Faster import"]. */
export type Places = [string, string | null | undefined][];

const plain = (s: string) => ` ${(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")} `;

/** Where in `places` the finding's words are: "in the intro", "in the public title and the public description". */
function where(f: Finding, places: Places): string {
  const at = places.filter(([, text]) => text && f.words.some((w) => plain(text).includes(plain(w)))).map(([name]) => name);
  return at.length ? `in ${at.join(" and ")}` : "in this text";
}

/** A finding in words: what was found and where ("Decision: “…” in the public description"). */
export function findingSentence(f: Finding | { code: string; words?: string[] }, places: Places): string {
  const words = f.words ?? [];
  if (!words.length) return `${findingLabel(f.code)}: found in this text`;
  return `${findingLabel(f.code)}: ${words.map((w) => `“${w}”`).join(", ")} ${where({ code: f.code, severity: "warning", words }, places)}`;
}

/**
 * An item text's warnings, each in words with one "I checked this" tick per kind (owner
 * decision, 2026-10-26). `codes` are the kinds to tick; `findings` give their words.
 */
export function WarningTicks({
  codes,
  findings,
  places,
  ticked,
  onTick,
}: {
  codes: string[];
  findings: Finding[];
  places: Places;
  ticked: string[];
  onTick: (code: string, on: boolean) => void;
}) {
  if (!codes.length) return null;
  return (
    <fieldset className="flex flex-col gap-1.5 rounded-button border border-line px-3 py-2">
      <legend className="px-1 text-sm font-semibold">Warnings to check</legend>
      <ul className="flex flex-col gap-2">
        {codes.map((code) => (
          <li key={code} data-testid="public-warning" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="min-w-0 flex-1 break-words">{findingSentence(findings.find((f) => f.code === code) ?? { code }, places)}</span>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`${findingLabel(code)}: I checked this`}
                checked={ticked.includes(code)}
                onChange={(e) => onTick(code, e.target.checked)}
              />
              I checked this
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
