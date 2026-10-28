"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Field, INPUT, SELECT, TEXTAREA } from "@/app/settings/_components/fields";
import {
  Button,
  Chip,
  Dialog,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  PageHeader,
  ViewOnly,
  Panel,
  SegmentedControl,
} from "@/components/ds";
import { ProblemList } from "@/components/TemplateBodyEditor";
import { SlidePreview, ThemePreview } from "@/components/ThemePreview";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useLive } from "@/lib/use-live";
import { errorMessage, useQuery } from "@/lib/use-query";

type ThemeOut = Schemas["ThemeOut"];
type Tokens = Schemas["ThemeTokens"];
type ThemeKind = ThemeOut["kind"];

type Form = { name: string; description: string; kind: ThemeKind; tokens: Tokens; css: string; slide_css: string };

const COLOURS: { name: string; label: string; hint: string }[] = [
  { name: "text", label: "Text", hint: "Body text" },
  { name: "heading", label: "Heading", hint: "Headings" },
  { name: "muted", label: "Muted", hint: "Captions, status line" },
  { name: "accent", label: "Accent", hint: "Links, rules under titles" },
  { name: "background", label: "Background", hint: "Page" },
  { name: "rule", label: "Rule", hint: "Table and card borders" },
  { name: "surface", label: "Surface", hint: "Boxes, code" },
];

const FONTS = [
  { name: "body", label: "Body font" },
  { name: "heading", label: "Heading font" },
  { name: "mono", label: "Monospace font" },
] as const;

const SPACING = [
  { name: "base_size_pt", label: "Base size (pt)", step: 0.5, min: 6, max: 20 },
  { name: "line_height", label: "Line height", step: 0.05, min: 1, max: 2.5 },
  { name: "page_margin_mm", label: "Page margin (mm)", step: 1, min: 5, max: 40 },
  { name: "section_gap_rem", label: "Section gap (rem)", step: 0.1, min: 0, max: 6 },
] as const;

const FEATURES = [
  { name: "toc", label: "Table of contents" },
  { name: "status_header", label: "Status header" },
  { name: "numbered_headings", label: "Numbered headings" },
  { name: "legend", label: "Legend on every page" },
  { name: "appendix_break", label: "Appendix on a new page" },
] as const;

/**
 * qa-settings-7: the API names a token by its path ("colors.text"); people see the field's
 * label ("Text colour"). Unknown names still read as words.
 */
const FIELD_LABEL: Record<string, string> = {
  ...Object.fromEntries(COLOURS.map((c) => [`colors.${c.name}`, `${c.label} colour`])),
  ...Object.fromEntries(FONTS.map((f) => [`fonts.${f.name}`, f.label])),
  ...Object.fromEntries(SPACING.map((s) => [`spacing.${s.name}`, s.label])),
  "page.size": "Page size",
  "page.orientation": "Orientation",
};
const FIELD_PATH = /\b(colors|fonts|spacing|page)\.([a-z0-9_]+)\b/g;
const GROUP_WORD: Record<string, string> = { colors: "colour", fonts: "font", spacing: "", page: "" };

function fieldLabel(group: string, name: string): string {
  const known = FIELD_LABEL[`${group}.${name}`];
  if (known) return known;
  const words = name.replace(/_/g, " ");
  return `${words[0].toUpperCase()}${words.slice(1)}${GROUP_WORD[group] ? ` ${GROUP_WORD[group]}` : ""}`;
}

/** The field a problem is about ("colors.text"), when its message starts with one. */
function problemField(p: Problem): string | null {
  const m = /^(colors|fonts|spacing|page)\.([a-z0-9_]+)\b/.exec(p.message);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** A problem's message with field labels for the API's paths: "Text colour must be…". */
function plainMessage(message: string): string {
  return message.replace(FIELD_PATH, (_, group: string, name: string, at: number) => {
    const label = fieldLabel(group, name);
    return at === 0 ? label : label[0].toLowerCase() + label.slice(1);
  });
}

const plainProblem = (p: Problem): Problem => ({ ...p, message: plainMessage(p.message) });

/** A field's problems, under it, named by the control's aria-describedby (qa-settings-7). */
function FieldProblems({ id, problems }: { id: string; problems: Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul id={id} data-testid="field-problem" className="space-y-0.5 text-sm text-crit">
      {problems.map((p, i) => (
        <li key={i}>{plainMessage(p.message)}</li>
      ))}
    </ul>
  );
}

const KIND_LABEL: Record<ThemeKind, string> = {
  prd: "PRD",
  roadmap: "Roadmap",
  vision: "Vision",
  strategy: "Product strategy",
  update: "Update",
  pricing: "Pricing memo",
  any: "Any document",
};

function formOf(t: ThemeOut): Form {
  return {
    name: t.name,
    description: t.description ?? "",
    kind: t.kind,
    tokens: t.tokens,
    css: t.css,
    slide_css: t.slide_css ?? "",
  };
}

/** #abc → #aabbcc; anything that is not a hex colour → black (for <input type="color">). */
function pickerValue(v: string | undefined): string {
  if (!v || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return "#000000";
  return v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}`.toLowerCase() : v.toLowerCase();
}

/**
 * A group of the editor. The title is passed as a node, so the panel carries no aria-label
 * of its own and labels like "Slide CSS" name only their control.
 */
function Group({ title, tools, children }: { title: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <Panel title={<>{title}</>} tools={tools} bodyClassName="p-4 max-[600px]:p-3">
      {children}
    </Panel>
  );
}

const SELECT_FULL = `${SELECT} h-9 w-full`;

const BACK = (
  <Link href="/settings/themes" className="hover:text-text hover:underline">
    ← Themes
  </Link>
);

const validate = (body: { tokens: Tokens; css: string; slide_css: string | null }) =>
  unwrap(api.POST("/v1/themes/validate", { body }));

/** Editor of a theme's tokens and CSS, with a live preview and live validation. */
export function ThemeDetail({ themeKey: key }: { themeKey: string }) {
  const q = useQuery(`theme|${key}`, () => unwrap(api.GET("/v1/themes/{key}", { params: { path: { key } } })));
  const t = q.data;
  // #370: approvers and owners change themes; other roles read them and the preview only.
  const { can, capsReady } = useMe();
  const canEdit = can("update_theme");
  const [edit, setEdit] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveProblems, setSaveProblems] = useState<Problem[]>([]);
  const [previewView, setPreviewView] = useState<"document" | "slides">("document");
  const [largePreview, setLargePreview] = useState(false);
  const form = edit ?? (t ? formOf(t) : null);
  const live = useLive(
    { tokens: form?.tokens ?? {}, css: form?.css ?? "", slide_css: form?.slide_css || null },
    validate,
    300,
    form !== null,
  );

  if (q.error) {
    return (
      <>
        <PageHeader back={BACK} title="Theme" />
        <Notice tone="error">{q.error}</Notice>
      </>
    );
  }
  if (!t || !form) {
    return (
      <>
        <PageHeader back={BACK} title="Theme" />
        <Loading />
      </>
    );
  }

  const tokens = form.tokens;
  const colors = tokens.colors ?? {};
  const changed = JSON.stringify(form) !== JSON.stringify(formOf(t));
  const problems = live.data?.problems ?? [];
  const contrast = problems.filter((p) => p.code === "insufficient_contrast");
  // A problem about a colour, font or spacing field shows under that field (when the editor
  // is there); the rest (CSS, page) on top.
  const inline = (p: Problem) =>
    canEdit && p.code !== "insufficient_contrast" && /^(colors|fonts|spacing)\./.test(problemField(p) ?? "") ? problemField(p) : null;
  const byField = new Map<string, Problem[]>();
  for (const p of problems) {
    const field = inline(p);
    if (field) byField.set(field, [...(byField.get(field) ?? []), p]);
  }
  const other = problems.filter((p) => p.code !== "insufficient_contrast" && !inline(p));
  const fieldProblems = (field: string) => byField.get(field) ?? [];
  const problemId = (field: string) => `problem-${field.replace(".", "-")}`;
  const invalid = live.data ? !live.data.valid : false;

  const set = (patch: Partial<Form>) => {
    setEdit({ ...form, ...patch });
    setNotice(null);
  };
  const setTokens = <G extends keyof Tokens>(group: G, values: Partial<NonNullable<Tokens[G]>>) =>
    set({ tokens: { ...tokens, [group]: { ...(tokens[group] as object), ...values } } });

  async function run(label: string, call: () => Promise<ThemeOut>, done: string) {
    setBusy(label);
    setError(null);
    setSaveProblems([]);
    setNotice(null);
    try {
      const next = await call();
      q.setData(() => next);
      setEdit(null);
      setNotice(done);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : errorMessage(e));
      if (e instanceof ProblemsError) setSaveProblems(e.problems);
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run(
      "save",
      () =>
        unwrapProblems(
          api.PATCH("/v1/themes/{key}", {
            params: { path: { key } },
            body: {
              name: form.name.trim(),
              description: form.description.trim() || null,
              kind: form.kind,
              tokens: form.tokens,
              css: form.css,
              // Built-in themes keep their slide design in code: no slide CSS to send.
              ...(t.builtin ? {} : { slide_css: form.slide_css.trim() ? form.slide_css : null }),
            },
          }),
        ),
      "Theme saved. New exports use it; documents already exported keep their files.",
    );
  const archive = () =>
    run(
      "archive",
      () => unwrap(api.DELETE("/v1/themes/{key}", { params: { path: { key } } })),
      "Archived: hidden from the new-draft picker. Documents using it still export with it.",
    );
  const restore = () =>
    run("restore", () => unwrap(api.POST("/v1/themes/{key}/restore", { params: { path: { key } } })), "Restored.");

  const previewKind = form.kind === "roadmap" ? "roadmap" : "prd";
  const chips = (hero: boolean) => (
    <>
      <Chip hero={hero} kind="acc">
        {KIND_LABEL[t.kind]}
      </Chip>
      {t.builtin && (
        <Chip hero={hero} kind="na">
          Built-in
        </Chip>
      )}
      {t.archived_at && (
        <Chip hero={hero} kind="warn">
          Archived
        </Chip>
      )}
    </>
  );

  const inspector = (
    <Inspector eyebrow="Theme" title={t.name} label="Theme details" chips={chips(true)}>
      {canEdit && (
        <InspectorSection label="Details">
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <input className={INPUT} value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="For">
              <select className={SELECT_FULL} value={form.kind} onChange={(e) => set({ kind: e.target.value as ThemeKind })}>
                {(Object.keys(KIND_LABEL) as ThemeKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Description">
              <textarea
                rows={3}
                className={TEXTAREA}
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            </Field>
          </div>
        </InspectorSection>
      )}
      {!canEdit && t.description && (
        <InspectorSection label="Description">
          <p className="text-[15px] text-text">{t.description}</p>
        </InspectorSection>
      )}
      <InspectorSection label="Facts">
        <InspectorRow value={formatDateTime(t.updated_at)}>Updated</InspectorRow>
        {t.archived_at && <InspectorRow value={formatDateTime(t.archived_at)}>Archived</InspectorRow>}
      </InspectorSection>
      {canEdit && (
        <InspectorSection>
          {t.archived_at ? (
            <Button onClick={restore} disabled={busy !== null}>
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : (
            <Button onClick={archive} disabled={busy !== null}>
              {busy === "archive" ? "Archiving…" : "Archive"}
            </Button>
          )}
        </InspectorSection>
      )}
      <InspectorSection label="For developers">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.key}</span>}>Key</InspectorRow>
      </InspectorSection>
    </Inspector>
  );

  return (
    <>
      <PageHeader
        back={BACK}
        title={t.name}
        status={
          <>
            {chips(false)}
            {capsReady && !canEdit && <ViewOnly />}
          </>
        }
        action={
          canEdit && (
            <Button variant="primary" icon="check" onClick={save} disabled={busy !== null || !changed || invalid || live.pending}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          )
        }
      />
      {/* Split's grid, but stacked (a phone) the details and Archive come first (qa-settings-35). */}
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3">
        <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
          {(notice || error || contrast.length > 0 || other.length > 0) && (
            <div className="flex flex-col gap-2">
              {notice && <Notice tone="pass">{notice}</Notice>}
              {error && <Notice tone="error">{error}</Notice>}
              {saveProblems.length > 0 && <ProblemList problems={saveProblems.map(plainProblem)} testId="save-problems" />}
              {contrast.length > 0 && (
                <div role="alert" data-testid="contrast-errors" className="rounded-button bg-crit-bg px-3 py-2 text-sm text-crit">
                  <p className="font-semibold">Low contrast</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {contrast.map((p, i) => (
                      <li key={i}>{plainMessage(p.message)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {other.length > 0 && <ProblemList problems={other.map(plainProblem)} testId="theme-problems" />}
            </div>
          )}

          {/* Side by side only where the preview gets a readable width (qa-settings-21). */}
          <div className="grid items-start gap-4 max-[600px]:gap-3 min-[1600px]:grid-cols-2">
            <div className="min-w-0 min-[1600px]:sticky min-[1600px]:top-4 min-[1600px]:col-start-2 min-[1600px]:row-start-1">
              <Panel
                title={<>Preview</>}
                tools={
                  <>
                    <SegmentedControl
                      label="Preview of"
                      size="sm"
                      value={previewView}
                      onChange={setPreviewView}
                      items={[
                        { value: "document", label: "Document" },
                        { value: "slides", label: "Slides" },
                      ]}
                    />
                    <InfoTip label="the preview">
                      {previewView === "document"
                        ? `A sample ${previewKind === "roadmap" ? "roadmap" : "PRD"} with these settings.`
                        : "The sample's brief as Present mode and the deck PDF show it."}{" "}
                      Unsaved changes show here first.
                    </InfoTip>
                    <Button variant="ghost" onClick={() => setLargePreview(true)}>
                      Enlarge
                    </Button>
                  </>
                }
                bodyClassName="p-4 max-[600px]:p-3"
              >
                {previewView === "document" ? (
                  <ThemePreview tokens={form.tokens} css={form.css} kind={previewKind} />
                ) : (
                  <SlidePreview
                    tokens={form.tokens}
                    slideCss={t.builtin ? null : form.slide_css || null}
                    kind={previewKind}
                    variant={t.builtin ? t.key : null}
                  />
                )}
              </Panel>
              {largePreview && (
                <Dialog
                  title={`${form.name.trim() || t.name} ${previewView === "document" ? "preview" : "slides"}`}
                  size="lg"
                  onClose={() => setLargePreview(false)}
                  testId="theme-preview-dialog"
                >
                  {previewView === "document" ? (
                    <ThemePreview tokens={form.tokens} css={form.css} kind={previewKind} testId="theme-preview-large" tall />
                  ) : (
                    <SlidePreview
                      tokens={form.tokens}
                      slideCss={t.builtin ? null : form.slide_css || null}
                      kind={previewKind}
                      variant={t.builtin ? t.key : null}
                      testId="slide-preview-large"
                      tall
                    />
                  )}
                </Dialog>
              )}
            </div>

            {canEdit && (
              <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3 min-[1600px]:col-start-1 min-[1600px]:row-start-1">
                <Group title="Colours">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {COLOURS.map((c) => {
                      const field = `colors.${c.name}`;
                      const own = fieldProblems(field);
                      const bad = own.length > 0 || contrast.some((p) => problemField(p) === field);
                      return (
                        <div key={c.name} className="flex min-w-0 flex-col gap-1">
                          <div className="flex items-end gap-2">
                            <input
                              type="color"
                              aria-label={`${c.label} colour picker`}
                              value={pickerValue(colors[c.name])}
                              onChange={(e) => setTokens("colors", { [c.name]: e.target.value })}
                              className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-line-strong bg-surface p-0.5"
                            />
                            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                              <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2" title={c.hint}>
                                {c.label}
                              </span>
                              <input
                                aria-label={c.label}
                                aria-invalid={bad || undefined}
                                aria-describedby={own.length > 0 ? problemId(field) : undefined}
                                value={colors[c.name] ?? ""}
                                onChange={(e) => setTokens("colors", { [c.name]: e.target.value.trim() })}
                                className={`${INPUT} font-mono ${bad ? "border-crit ring-1 ring-crit" : ""}`}
                              />
                            </label>
                          </div>
                          <FieldProblems id={problemId(field)} problems={own} />
                        </div>
                      );
                    })}
                  </div>
                </Group>

                <Group title="Type">
                  <div className="flex flex-col gap-3">
                    {FONTS.map((f) => {
                      const field = `fonts.${f.name}`;
                      const own = fieldProblems(field);
                      return (
                        <div key={f.name} className="flex min-w-0 flex-col gap-1">
                          <Field label={f.label}>
                            {/* A font stack is long: it wraps, not cut (qa-settings-20); Enter adds no line break. */}
                            <textarea
                              rows={2}
                              spellCheck={false}
                              aria-invalid={own.length > 0 || undefined}
                              aria-describedby={own.length > 0 ? problemId(field) : undefined}
                              className={`${TEXTAREA} resize-none font-mono text-sm leading-5 ${own.length > 0 ? "border-crit ring-1 ring-crit" : ""}`}
                              value={tokens.fonts?.[f.name] ?? ""}
                              onChange={(e) => setTokens("fonts", { [f.name]: e.target.value.replace(/\n/g, " ") || null })}
                            />
                          </Field>
                          <FieldProblems id={problemId(field)} problems={own} />
                        </div>
                      );
                    })}
                  </div>
                </Group>

                <Group title="Spacing and page">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {SPACING.map((s) => {
                      const field = `spacing.${s.name}`;
                      const own = fieldProblems(field);
                      return (
                        <div key={s.name} className="flex min-w-0 flex-col gap-1">
                          <Field label={s.label}>
                            <input
                              type="number"
                              step={s.step}
                              min={s.min}
                              max={s.max}
                              aria-invalid={own.length > 0 || undefined}
                              aria-describedby={own.length > 0 ? problemId(field) : undefined}
                              className={`${INPUT} tnum ${own.length > 0 ? "border-crit ring-1 ring-crit" : ""}`}
                              value={tokens.spacing?.[s.name] ?? ""}
                              onChange={(e) =>
                                setTokens("spacing", { [s.name]: e.target.value === "" ? null : Number(e.target.value) })
                              }
                            />
                          </Field>
                          <FieldProblems id={problemId(field)} problems={own} />
                        </div>
                      );
                    })}
                    <Field label="Page size">
                      <select
                        className={SELECT_FULL}
                        value={tokens.page?.size ?? "A4"}
                        onChange={(e) =>
                          setTokens("page", { size: e.target.value as "A4" | "Letter", orientation: tokens.page?.orientation ?? "portrait" })
                        }
                      >
                        <option value="A4">A4</option>
                        <option value="Letter">Letter</option>
                      </select>
                    </Field>
                    <Field label="Orientation">
                      <select
                        className={SELECT_FULL}
                        value={tokens.page?.orientation ?? "portrait"}
                        onChange={(e) =>
                          setTokens("page", {
                            size: tokens.page?.size ?? "A4",
                            orientation: e.target.value as "portrait" | "landscape",
                          })
                        }
                      >
                        <option value="portrait">Portrait</option>
                        <option value="landscape">Landscape</option>
                      </select>
                    </Field>
                  </div>
                </Group>

                <Group title="Features">
                  <div className="grid gap-2 text-[15px] sm:grid-cols-2">
                    {FEATURES.map((f) => (
                      <label key={f.name} className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--accent)]"
                          checked={!!tokens.features?.[f.name]}
                          onChange={(e) => setTokens("features", { [f.name]: e.target.checked })}
                        />
                        {f.label}
                      </label>
                    ))}
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        checked={tokens.features?.page_fit === "one_page"}
                        onChange={(e) => setTokens("features", { page_fit: e.target.checked ? "one_page" : null })}
                      />
                      Must fit on one page
                    </label>
                  </div>
                </Group>

                <Group
                  title="CSS"
                  tools={
                    <InfoTip label="extra rules">
                      Extra rules applied after the tokens. Colours are available as <code>var(--color-accent)</code> and so on; no
                      @import or external URLs.
                    </InfoTip>
                  }
                >
                  <textarea
                    aria-label="CSS"
                    rows={8}
                    spellCheck={false}
                    value={form.css}
                    onChange={(e) => set({ css: e.target.value })}
                    className={`${TEXTAREA} font-mono text-sm leading-5`}
                  />
                </Group>

                <Group
                  title="Slide CSS"
                  tools={
                    t.builtin ? undefined : (
                      <InfoTip label="slide rules">
                        Rules for Present mode and the deck PDF, applied after the shared slide layout. Each slide is a{" "}
                        <code>.slide</code> inside <code>.deck</code>, with <code>.slide-title</code> and <code>.slide-body</code>;
                        the PowerPoint export uses the colours and fonts only. Same limits as the CSS above.
                      </InfoTip>
                    )
                  }
                >
                  {t.builtin ? (
                    <p data-testid="slide-css-builtin" className="flex items-center gap-2 text-[15px] text-text2">
                      Built-in themes keep their own slide design.
                      <InfoTip label="built-in theme design" align="start">
                        It cannot be edited. To write slide CSS, create a new theme from this one.
                      </InfoTip>
                    </p>
                  ) : (
                    <textarea
                      aria-label="Slide CSS"
                      rows={8}
                      spellCheck={false}
                      value={form.slide_css}
                      onFocus={() => setPreviewView("slides")}
                      onChange={(e) => set({ slide_css: e.target.value })}
                      placeholder=".deck .slide-title { text-transform: uppercase; }"
                      className={`${TEXTAREA} font-mono text-sm leading-5`}
                    />
                  )}
                </Group>
              </div>
            )}
          </div>
        </div>
        <div className="min-w-0 xl:sticky xl:top-4 max-[1100px]:order-first">{inspector}</div>
      </div>
    </>
  );
}
