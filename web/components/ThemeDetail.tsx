"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { ProblemList } from "@/components/TemplateBodyEditor";
import { SlidePreview, ThemePreview } from "@/components/ThemePreview";
import { Badge, Button, ErrorNote, INPUT, Loading } from "@/components/ui";
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-neutral-200 bg-white p-4">
      <legend className="px-1 text-sm font-semibold text-neutral-700">{title}</legend>
      {children}
    </fieldset>
  );
}

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
      <div className="mx-auto max-w-6xl px-6 py-8">
        <ErrorNote>{q.error}</ErrorNote>
      </div>
    );
  }
  if (!t || !form) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Loading />
      </div>
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <p className="mb-2 text-sm">
        <Link href="/settings/themes" className="text-neutral-500 hover:text-neutral-900 hover:underline">
          ← Themes
        </Link>
      </p>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{t.name}</h1>
        <Badge tone="blue">{KIND_LABEL[t.kind]}</Badge>
        {t.builtin && <Badge>Built-in</Badge>}
        {t.archived_at && <Badge tone="amber">Archived</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {t.archived_at ? (
            <Button onClick={restore} disabled={busy !== null}>
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : (
            <Button onClick={archive} disabled={busy !== null}>
              {busy === "archive" ? "Archiving…" : "Archive"}
            </Button>
          )}
          <Button variant="primary" onClick={save} disabled={busy !== null || !changed || invalid || live.pending}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <p className="mb-6 text-sm text-neutral-500">
        <span className="font-mono">{t.key}</span> · updated {formatDateTime(t.updated_at)}
        {t.archived_at && ` · archived ${formatDateTime(t.archived_at)}`}
      </p>

      {notice && (
        <p role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {error && (
        <div className="mb-4 space-y-2">
          <ErrorNote>{error}</ErrorNote>
          {saveProblems.length > 0 && <ProblemList problems={saveProblems} testId="save-problems" />}
        </div>
      )}
      {contrast.length > 0 && (
        <div
          role="alert"
          data-testid="contrast-errors"
          className="mb-4 rounded-md border-2 border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          <p className="font-semibold">Text would be hard to read. Fix the contrast before saving:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {contrast.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      {other.length > 0 && (
        <div className="mb-4">
          <ProblemList problems={other} testId="theme-problems" />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Group title="Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-600">Name</span>
                <input className={INPUT} value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-600">For</span>
                <select className={INPUT} value={form.kind} onChange={(e) => set({ kind: e.target.value as ThemeKind })}>
                  {(Object.keys(KIND_LABEL) as ThemeKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block text-neutral-600">Description</span>
                <input className={INPUT} value={form.description} onChange={(e) => set({ description: e.target.value })} />
              </label>
            </div>
          </Group>

          <Group title="Colours">
            <div className="grid gap-2 sm:grid-cols-2">
              {COLOURS.map((c) => {
                const bad = contrast.some((p) => p.message.startsWith(`colors.${c.name} `));
                return (
                  <div key={c.name} className="flex items-center gap-2 text-sm">
                    <input
                      type="color"
                      aria-label={`${c.label} colour picker`}
                      value={pickerValue(colors[c.name])}
                      onChange={(e) => setTokens("colors", { [c.name]: e.target.value })}
                      className="h-8 w-9 shrink-0 cursor-pointer rounded border border-neutral-300 bg-white p-0.5"
                    />
                    <label className="flex min-w-0 flex-1 flex-col">
                      <span className="text-xs text-neutral-600" title={c.hint}>
                        {c.label}
                      </span>
                      <input
                        aria-label={c.label}
                        aria-invalid={bad || undefined}
                        value={colors[c.name] ?? ""}
                        onChange={(e) => setTokens("colors", { [c.name]: e.target.value.trim() })}
                        className={`${INPUT} font-mono ${bad ? "border-rose-400 ring-1 ring-rose-300" : ""}`}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </Group>

          <Group title="Type">
            <div className="space-y-2">
              {FONTS.map((f) => (
                <label key={f.name} className="block text-sm">
                  <span className="mb-1 block text-neutral-600">{f.label}</span>
                  <input
                    className={`${INPUT} font-mono text-xs`}
                    value={tokens.fonts?.[f.name] ?? ""}
                    onChange={(e) => setTokens("fonts", { [f.name]: e.target.value || null })}
                  />
                </label>
              ))}
            </div>
          </Group>

          <Group title="Spacing and page">
            <div className="grid gap-3 sm:grid-cols-2">
              {SPACING.map((s) => (
                <label key={s.name} className="block text-sm">
                  <span className="mb-1 block text-neutral-600">{s.label}</span>
                  <input
                    type="number"
                    step={s.step}
                    min={s.min}
                    max={s.max}
                    className={INPUT}
                    value={tokens.spacing?.[s.name] ?? ""}
                    onChange={(e) =>
                      setTokens("spacing", { [s.name]: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                </label>
              ))}
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-600">Page size</span>
                <select
                  className={INPUT}
                  value={tokens.page?.size ?? "A4"}
                  onChange={(e) =>
                    setTokens("page", { size: e.target.value as "A4" | "Letter", orientation: tokens.page?.orientation ?? "portrait" })
                  }
                >
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-600">Orientation</span>
                <select
                  className={INPUT}
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
              </label>
            </div>
          </Group>

          <Group title="Features">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <label key={f.name} className="inline-flex items-center gap-2 text-sm text-neutral-800">
                  <input
                    type="checkbox"
                    checked={!!tokens.features?.[f.name]}
                    onChange={(e) => setTokens("features", { [f.name]: e.target.checked })}
                  />
                  {f.label}
                </label>
              ))}
              <label className="inline-flex items-center gap-2 text-sm text-neutral-800">
                <input
                  type="checkbox"
                  checked={tokens.features?.page_fit === "one_page"}
                  onChange={(e) => setTokens("features", { page_fit: e.target.checked ? "one_page" : null })}
                />
                Must fit on one page
              </label>
            </div>
          </Group>

          <Group title="CSS">
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-neutral-500">
                Extra rules applied after the tokens. Colours are available as <code>var(--color-accent)</code> and so on; no
                @import or external URLs.
              </span>
              <textarea
                aria-label="CSS"
                rows={8}
                spellCheck={false}
                value={form.css}
                onChange={(e) => set({ css: e.target.value })}
                className={`${INPUT} font-mono text-xs`}
              />
            </label>
          </Group>

          <Group title="Slide CSS">
            {t.builtin ? (
              <p data-testid="slide-css-builtin" className="text-sm text-neutral-600">
                Built-in themes keep their own slide design, which cannot be edited. To write slide CSS, create a new theme from
                this one.
              </p>
            ) : (
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-neutral-500">
                  Rules for Present mode and the deck PDF, applied after the shared slide layout. Each slide is a{" "}
                  <code>.slide</code> inside <code>.deck</code>, with <code>.slide-title</code> and <code>.slide-body</code>; the
                  PowerPoint export uses the colours and fonts only. Same limits as the CSS above.
                </span>
                <textarea
                  aria-label="Slide CSS"
                  rows={8}
                  spellCheck={false}
                  value={form.slide_css}
                  onFocus={() => setPreviewView("slides")}
                  onChange={(e) => set({ slide_css: e.target.value })}
                  placeholder=".deck .slide-title { text-transform: uppercase; }"
                  className={`${INPUT} font-mono text-xs`}
                />
              </label>
            )}
          </Group>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-neutral-700">Preview</h2>
            <div role="group" aria-label="Preview of" className="ml-auto inline-flex rounded-md border border-neutral-300 text-xs">
              {(["document", "slides"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={previewView === v}
                  onClick={() => setPreviewView(v)}
                  className={`px-2.5 py-1 first:rounded-l-md last:rounded-r-md ${
                    previewView === v ? "bg-neutral-900 text-white" : "bg-white text-neutral-700 hover:bg-neutral-50"
                  }`}
                >
                  {v === "document" ? "Document" : "Slides"}
                </button>
              ))}
            </div>
          </div>
          {previewView === "document" ? (
            <>
              <ThemePreview tokens={form.tokens} css={form.css} kind={form.kind === "roadmap" ? "roadmap" : "prd"} />
              <p className="mt-1 text-xs text-neutral-500">
                A sample {form.kind === "roadmap" ? "roadmap" : "PRD"} with these settings. Unsaved changes show here first.
              </p>
            </>
          ) : (
            <>
              <SlidePreview
                tokens={form.tokens}
                slideCss={t.builtin ? null : form.slide_css || null}
                kind={form.kind === "roadmap" ? "roadmap" : "prd"}
                variant={t.builtin ? t.key : null}
              />
              <p className="mt-1 text-xs text-neutral-500">
                The sample&apos;s brief as Present mode and the deck PDF show it. Unsaved changes show here first.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
