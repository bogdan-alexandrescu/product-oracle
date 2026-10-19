"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Field, INPUT, SELECT, TEXTAREA } from "@/app/settings/_components/fields";
import {
  Button,
  Chip,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  PageHeader,
  Panel,
  SegmentedControl,
  Split,
} from "@/components/ds";
import { ProblemList } from "@/components/TemplateBodyEditor";
import { SlidePreview, ThemePreview } from "@/components/ThemePreview";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { formatDateTime } from "@/lib/format";
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

const KIND_LABEL: Record<ThemeKind, string> = { prd: "PRD", roadmap: "Roadmap", any: "Any document" };

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
  const [edit, setEdit] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveProblems, setSaveProblems] = useState<Problem[]>([]);
  const [previewView, setPreviewView] = useState<"document" | "slides">("document");
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
  const other = problems.filter((p) => p.code !== "insufficient_contrast");
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
            <input className={INPUT} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
      </InspectorSection>
      <InspectorSection label="Facts">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.key}</span>}>Key</InspectorRow>
        <InspectorRow value={formatDateTime(t.updated_at)}>Updated</InspectorRow>
        {t.archived_at && <InspectorRow value={formatDateTime(t.archived_at)}>Archived</InspectorRow>}
      </InspectorSection>
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
    </Inspector>
  );

  return (
    <>
      <PageHeader
        back={BACK}
        title={t.name}
        status={chips(false)}
        action={
          <Button variant="primary" icon="check" onClick={save} disabled={busy !== null || !changed || invalid || live.pending}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        }
      />
      <Split inspector={inspector}>
        {(notice || error || contrast.length > 0 || other.length > 0) && (
          <div className="flex flex-col gap-2">
            {notice && <Notice tone="pass">{notice}</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            {saveProblems.length > 0 && <ProblemList problems={saveProblems} testId="save-problems" />}
            {contrast.length > 0 && (
              <div role="alert" data-testid="contrast-errors" className="rounded-button bg-crit-bg px-3 py-2 text-sm text-crit">
                <p className="font-semibold">Low contrast</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {contrast.map((p, i) => (
                    <li key={i}>{p.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {other.length > 0 && <ProblemList problems={other} testId="theme-problems" />}
          </div>
        )}

        <div className="grid items-start gap-4 max-[600px]:gap-3 min-[1280px]:grid-cols-2">
          <div className="min-w-0 min-[1280px]:sticky min-[1280px]:top-4 min-[1280px]:col-start-2 min-[1280px]:row-start-1">
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
          </div>

          <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3 min-[1280px]:col-start-1 min-[1280px]:row-start-1">
            <Group title="Colours">
              <div className="grid gap-3 sm:grid-cols-2">
                {COLOURS.map((c) => {
                  const bad = contrast.some((p) => p.message.startsWith(`colors.${c.name} `));
                  return (
                    <div key={c.name} className="flex items-end gap-2">
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
                          value={colors[c.name] ?? ""}
                          onChange={(e) => setTokens("colors", { [c.name]: e.target.value.trim() })}
                          className={`${INPUT} font-mono ${bad ? "border-crit ring-1 ring-crit" : ""}`}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </Group>

            <Group title="Type">
              <div className="flex flex-col gap-3">
                {FONTS.map((f) => (
                  <Field key={f.name} label={f.label}>
                    <input
                      className={`${INPUT} font-mono text-sm`}
                      value={tokens.fonts?.[f.name] ?? ""}
                      onChange={(e) => setTokens("fonts", { [f.name]: e.target.value || null })}
                    />
                  </Field>
                ))}
              </div>
            </Group>

            <Group title="Spacing and page">
              <div className="grid gap-3 sm:grid-cols-2">
                {SPACING.map((s) => (
                  <Field key={s.name} label={s.label}>
                    <input
                      type="number"
                      step={s.step}
                      min={s.min}
                      max={s.max}
                      className={`${INPUT} tnum`}
                      value={tokens.spacing?.[s.name] ?? ""}
                      onChange={(e) =>
                        setTokens("spacing", { [s.name]: e.target.value === "" ? null : Number(e.target.value) })
                      }
                    />
                  </Field>
                ))}
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
                  <InfoTip label="built-in slides" align="start">
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
        </div>
      </Split>
    </>
  );
}
