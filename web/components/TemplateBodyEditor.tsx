"use client";

import type { ReactNode } from "react";

import { Button, Chip, InfoTip, Label } from "@/components/ds";
import { INPUT, TEXTAREA } from "@/app/settings/_components/fields";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { problemText, type Problem } from "@/lib/api/problems";
import { useLive, type Live } from "@/lib/use-live";
import { useQuery } from "@/lib/use-query";

export type TemplateCheck = Schemas["TemplateValidateOut"];

/** A minimal body that passes validation: what "New template" starts from. */
export const TEMPLATE_SKELETON = `---
theme: clean-document
# When to suggest this template, in a few words. Left empty, it is not saved.
suggest_when: ""
brief: [problem, solution]
---

# <Title> {#title}

## Problem {#problem}
<!-- The customer problem, in the customer's terms. -->

## Solution {#solution}
<!-- What we will build, as conclusions. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. -->
`;

/**
 * Each section id's heading as written in the body ("problem" → "Problem"), so the
 * editor names sections in words. Level 1-3 headings outside code fences, as the API reads them.
 */
export function sectionTitles(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let fence = false;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^ {0,3}#{1,3}\s+(.*?)\s*\{#([A-Za-z0-9_-]+)\}\s*#*\s*$/.exec(line);
    if (m && !out.has(m[2])) out.set(m[2], m[1].trim() || m[2]);
  }
  return out;
}

/**
 * A section's name for people (qa-settings-27): its heading as written, except a placeholder
 * heading ("<Feature> PRD", "<Title>"), which names the title section "Title" (others lose the
 * angle brackets). A section without a heading keeps its id.
 */
export function sectionName(titles: Map<string, string>, key: string): string {
  const heading = titles.get(key);
  if (!heading) return key === "title" ? "Title" : key;
  if (!/<[^>]*>/.test(heading)) return heading;
  return key === "title" ? "Title" : heading.replace(/[<>]/g, "").trim() || key;
}

/** Section ids as their names, comma-separated ("none" when there are none). */
export function sectionNames(titles: Map<string, string>, keys: string[]): string {
  return keys.map((k) => sectionName(titles, k)).join(", ") || "none";
}

/**
 * Theme names by key (qa-settings-26): templates suggest a theme by its key, people read its
 * name. Archived themes included, so an old suggestion still reads as a name.
 */
const keyInWords = (key: string) => {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** All themes, kept in one place so the name lookup and a theme <select> share one fetch. */
function useThemesQuery() {
  return useQuery("themes|all", () => unwrap(api.GET("/v1/themes", { params: { query: { include_archived: true } } })));
}

export function useThemeNames(): (key: string | null | undefined) => string {
  const q = useThemesQuery();
  // Until the names load, "…"; when they cannot load, the key in words, never "…" for good.
  return (key) => (key ? (q.data?.find((t) => t.key === key)?.name ?? (q.data ? key : q.error ? keyInWords(key) : "…")) : "—");
}

/** Themes a template can suggest, by key and name (qa-F-75: a theme is picked by its name). */
export function useThemeOptions(): { key: string; name: string }[] {
  const q = useThemesQuery();
  return q.data ?? [];
}

const validateBody = (body: string) => unwrap(api.POST("/v1/templates/validate", { body: { body } }));

/**
 * Live (debounced) validation of a template body by POST /v1/templates/validate. Call it in
 * the page when the save button sits outside the editor (top-right), and pass it as `live`.
 */
export function useTemplateCheck(value: string, enabled = true): Live<TemplateCheck> {
  return useLive(value, validateBody, 400, enabled);
}

/** Validation problems of a template body, with line numbers. */
export function ProblemList({ problems, testId = "problems" }: { problems: Problem[]; testId?: string }) {
  return (
    <ul data-testid={testId} className="space-y-1 rounded-button bg-crit-bg px-3 py-2 text-sm text-crit">
      {problems.map((p, i) => (
        <li key={i}>{problemText(p)}</li>
      ))}
    </ul>
  );
}

/** Findings on a body or a stored version that do not block anything by themselves. */
export function WarningList({ warnings }: { warnings: Problem[] }) {
  return (
    <ul data-testid="template-warnings" className="mt-1 space-y-1 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
      {warnings.map((w, i) => (
        <li key={i}>{problemText(w)}</li>
      ))}
    </ul>
  );
}

/** How to fix `no_brief_sections` (O1g): every template marks the sections it presents. */
export function BriefFix() {
  return (
    <div data-testid="brief-fix" className="rounded-button border border-line bg-surface2 px-3 py-2 text-sm text-text">
      <p className="flex items-center gap-2 font-semibold">
        Mark the brief, either:
        <InfoTip label="the brief" align="start">
          The brief is the sections Present mode shows, one per slide.
        </InfoTip>
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          <code className="font-mono text-[13px]">brief: [summary, problem, decisions]</code> in the front matter
        </li>
        <li>
          <code className="font-mono text-[13px]">{"# Full version {#full}"}</code> after the brief sections
        </li>
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ sections as rows (F-75)

/**
 * A section as edited in rows: its heading, its guide (the comment under it, told to the
 * writer or Oracle) and whether it shows in the brief. `id` is the section's stored id; a row
 * added in the editor (not saved yet) has none, so its id is made from its heading, the same
 * way a new template's key is made from its name.
 */
export type Sec = { id: string; heading: string; guide: string; brief: boolean };

/** A new row, before it has a heading of its own. */
export const BLANK_SEC: Sec = { id: "", heading: "", guide: "", brief: false };

/** An id made from a name ("Launch brief" → "launch-brief"). */
export const keyFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** A guide as a Markdown comment's words: "-->" would close the comment and spill the rest into the body. */
export const commentSafe = (text: string) => text.trim().replace(/-{2,}>/g, "->");

/** Every template ends with this section (the template check asks for it). */
export const SOURCES_BODY = "## Sources and data points {#sources}\n<!-- The only place for sources, numbers and evidence. -->\n";

/** A template body's theme and sections, read as rows, plus whatever else the body carries
 * (the title heading and the Sources section) unchanged, since rows do not edit those. */
export type ParsedTemplate = {
  theme: string;
  /** Other front matter lines (e.g. a stored `template:` key, `suggest_when:`), kept as written. */
  frontExtra: string[];
  /** The title heading line, kept as written (rows do not edit it). */
  titleLine: string;
  secs: Sec[];
  /** "## Sources and data points {#sources}" through the end of the body, kept as written. */
  sourcesBlock: string;
};

const HEADING_RE = /^(#{1,3})\s+(.*?)\s*\{#([A-Za-z0-9_-]+)\}\s*$/;
const COMMENT_RE = /^\s*<!--\s*(.*?)\s*-->\s*$/;

/**
 * A template body read back into rows (qa-F-75): its theme and ordered level-2 sections, each
 * with at most one single-line guide comment, ending with Sources and data points. Anything
 * else — a missing theme, nested or multi-line sections, a table, content with no heading —
 * returns null, so the page falls back to the Markdown editor instead of guessing.
 */
export function parseTemplateSections(body: string): ParsedTemplate | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd === -1) return null;

  let theme: string | null = null;
  let briefIds: string[] | null = null;
  const frontExtra: string[] = [];
  for (const l of lines.slice(1, fmEnd)) {
    if (l.trim() === "") continue;
    const tm = /^theme:\s*(.*)$/.exec(l);
    if (tm) {
      theme = tm[1].trim();
      continue;
    }
    const bm = /^brief:\s*(.*)$/.exec(l);
    if (bm) {
      briefIds = bm[1]
        .trim()
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    frontExtra.push(l);
  }
  if (!theme) return null;

  let i = fmEnd + 1;
  while ((lines[i] ?? "").trim() === "") i++;
  if (!/^#\s+.*\{#title\}\s*$/.test(lines[i] ?? "")) return null;
  const titleLine = lines[i];
  i++;
  while ((lines[i] ?? "").trim() === "") i++;

  const secs: Sec[] = [];
  while (i < lines.length) {
    const m = HEADING_RE.exec(lines[i] ?? "");
    if (!m) return null;
    const [, hashes, headingText, id] = m;
    if (id === "sources") return { theme, frontExtra, titleLine, secs, sourcesBlock: lines.slice(i).join("\n") };
    if (hashes.length !== 2) return null; // rows only model flat level-2 sections
    i++;
    let guide = "";
    const cm = COMMENT_RE.exec(lines[i] ?? "");
    if (cm) {
      guide = cm[1];
      i++;
    } else if ((lines[i] ?? "").trim() !== "" && !HEADING_RE.test(lines[i] ?? "")) {
      return null; // real content, not a plain guide comment: cannot be shown as a row
    }
    while ((lines[i] ?? "") === "") i++;
    secs.push({ id, heading: headingText.trim(), guide, brief: briefIds ? briefIds.includes(id) : false });
  }
  return null; // ran off the end without a Sources section
}

/** The Markdown written from a parsed template's theme and rows (the inverse of
 * `parseTemplateSections`): the title line, front matter and Sources section are kept as
 * given; sections with no heading are dropped (qa-F-75, same as a new template's sections). */
export function serializeTemplateSections(parsed: Pick<ParsedTemplate, "theme" | "frontExtra" | "titleLine" | "sourcesBlock"> & { secs: Sec[] }): string {
  const keyed = parsed.secs.filter((s) => s.heading.trim()).map((s) => ({ ...s, key: s.id || keyFromName(s.heading) || "section" }));
  const lines = [
    "---",
    ...parsed.frontExtra,
    `theme: ${parsed.theme}`,
    `brief: [${keyed
      .filter((s) => s.brief)
      .map((s) => s.key)
      .join(", ")}]`,
    "---",
    "",
    parsed.titleLine,
    "",
    ...keyed.flatMap((s) => [`## ${s.heading.trim()} {#${s.key}}`, ...(s.guide.trim() ? [`<!-- ${commentSafe(s.guide)} -->`] : []), ""]),
    // `sourcesBlock` keeps its own trailing newline; joined after the blank-line separator above.
    parsed.sourcesBlock,
  ];
  return lines.join("\n");
}

/** A guide box that grows to show all its words. */
function growGuide(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

/**
 * Sections edited as named rows (qa-F-75), the way a new template starts: one row per section
 * with its heading, its guide and "Show in the brief", ending with a fixed Sources and data
 * points row. Used by New template and, when a stored template's body parses, by its own page.
 */
export function SectionRows({ secs, onChange }: { secs: Sec[]; onChange: (secs: Sec[]) => void }) {
  const set = (i: number, patch: Partial<Sec>) => onChange(secs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="flex flex-col gap-2" data-testid="template-sections">
      {secs.map((s, i) => (
        <div
          key={i}
          data-testid="template-section"
          className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-line bg-surface2 p-2 max-[700px]:grid-cols-1"
        >
          <input
            aria-label={`Section ${i + 1} heading`}
            className={INPUT}
            value={s.heading}
            onChange={(e) => set(i, { heading: e.target.value })}
            placeholder="Heading"
          />
          <textarea
            rows={1}
            ref={growGuide}
            aria-label={`Section ${i + 1} guide`}
            className={`${INPUT} resize-none overflow-hidden`}
            value={s.guide}
            onChange={(e) => {
              set(i, { guide: e.target.value });
              growGuide(e.target);
            }}
            placeholder="What goes here"
          />
          <label className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={s.brief}
              onChange={(e) => set(i, { brief: e.target.checked })}
            />
            Show in the brief
          </label>
          <Button
            variant="ghost"
            icon="x"
            aria-label={`Remove ${s.heading.trim() || "this section"}`}
            onClick={() => onChange(secs.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-center gap-2 rounded-lg border border-dashed border-line p-2 text-[15px] text-text2 max-[700px]:grid-cols-1">
        <span className="px-3 font-semibold text-text">Sources and data points</span>
        <span className="px-3">
          <InfoTip label="sources and data points">Always last: the only place for sources, numbers and evidence.</InfoTip>
        </span>
      </div>
      <span>
        <Button icon="plus" onClick={() => onChange([...secs, { ...BLANK_SEC }])}>
          Add a section
        </Button>
      </span>
    </div>
  );
}

/**
 * The live check's status line (qa-F-75: plain words, never the raw `theme` / `brief` keys):
 * "Valid." (or the problem count), the sections by name, the theme by name, and which sections
 * are in the brief, by name. `value` is the body the check ran against, used only to read each
 * section's name from its heading.
 */
export function CheckStatus({ live, value }: { live: Live<TemplateCheck>; value: string }) {
  const check = live.data;
  const titles = sectionTitles(value);
  const named = (keys: string[]) => keys.map((k) => sectionName(titles, k)).join(", ");
  const themeName = useThemeNames();
  return (
    <div aria-live="polite" className="flex min-h-6 flex-col gap-2 text-sm">
      {live.error && <p className="text-crit">{live.error}</p>}
      {!check && !live.error && <p className="text-text2">Checking…</p>}
      {check && check.valid && (
        <p data-testid="validation-ok" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Chip kind="pass" dot>
            {live.pending ? "Checking…" : "Valid."}
          </Chip>
          <Label>Sections:</Label>
          <span data-testid="section-names" className="min-w-0 break-words">
            {named(check.section_keys)}
          </span>
          {check.suggested_theme && (
            <>
              <Label>· Theme:</Label>
              <span data-testid="check-theme">{themeName(check.suggested_theme)}</span>
            </>
          )}
          {check.brief_sections.length > 0 && (
            <>
              <Label>· In the brief:</Label>
              <span data-testid="brief-sections" className="min-w-0 break-words">
                {named(check.brief_sections)}
              </span>
            </>
          )}
        </p>
      )}
      {check && check.warnings.length > 0 && <WarningList warnings={check.warnings} />}
      {check && !check.valid && (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-2">
            <Chip kind="crit" dot>
              <span className="tnum">{check.problems.length}</span> problem{check.problems.length > 1 ? "s" : ""}
              {live.pending ? " · checking…" : ""}
            </Chip>
          </p>
          <ProblemList problems={check.problems} />
          {check.problems.some((p) => p.code === "no_brief_sections") && <BriefFix />}
        </div>
      )}
    </div>
  );
}

/**
 * Markdown editor of a template body, validated live (debounced) by
 * POST /v1/templates/validate. `children` renders below it with the latest check, so
 * the parent can disable its save button while the body is invalid or being checked.
 * Pass `live` (from useTemplateCheck) when the parent needs the check itself.
 */
export function TemplateBodyEditor({
  value,
  onChange,
  label = "Body",
  rows = 22,
  live: given,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  rows?: number;
  live?: Live<TemplateCheck>;
  children?: (state: { check: TemplateCheck | undefined; pending: boolean }) => ReactNode;
}) {
  const own = useTemplateCheck(value, !given);
  const live = given ?? own;
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5">
        <label className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2" htmlFor="template-body">
          {label}
        </label>
        <InfoTip label="template rules" align="start" side="bottom">
          Every heading ends with <code>{"{#id}"}</code>; the last section is{" "}
          <code>## Sources and data points {"{#sources}"}</code>. Saving adds a new version; documents keep the version they
          started from.
        </InfoTip>
      </span>
      <textarea
        id="template-body"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className={`${TEXTAREA} font-mono text-sm leading-5`}
      />
      <CheckStatus live={live} value={value} />
      {children?.({ check: live.data, pending: live.pending })}
    </div>
  );
}
