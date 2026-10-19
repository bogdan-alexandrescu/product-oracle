"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";

import {
  Button,
  Chip,
  Icon,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  Page,
  PageHeader,
  Panel,
  Split,
} from "@/components/ds";
import { ThemeThumbnail } from "@/components/ThemePreview";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { unwrapProblems, ProblemsError } from "@/lib/api/problems";
import { useMe } from "@/lib/me";
import { useLive } from "@/lib/use-live";
import { errorMessage, useQuery } from "@/lib/use-query";

type Kind = "prd" | "roadmap";
type PrdAnswers = Schemas["PrdAnswers"];
type RoadmapAnswers = Schemas["RoadmapAnswers"];
type Choice = Schemas["Choice"];

// ---------------------------------------------------------------- questions

type Option<V> = { value: V; label: string };
const YES_NO: Option<boolean>[] = [
  { value: true, label: "Yes" },
  { value: false, label: "No" },
];

const PRD_QUESTIONS = [
  {
    field: "decision",
    question: "What should this document decide?",
    options: [
      { value: "start_or_not", label: "Whether to start at all" },
      { value: "commit_build", label: "Commit to building it" },
      { value: "bet_fixed_time", label: "Bet a fixed amount of time" },
      { value: "choose_between", label: "Choose between options" },
      { value: "technical_design", label: "How to build it" },
    ],
  },
  {
    field: "size",
    question: "How big and how new is it?",
    options: [
      { value: "small_change", label: "A small change" },
      { value: "new_feature", label: "A new feature" },
      { value: "new_product", label: "A new product or market" },
    ],
  },
  {
    field: "readers",
    question: "Who reads and approves it?",
    options: [
      { value: "founder", label: "The founder" },
      { value: "product_eng", label: "Product and engineering" },
      { value: "leadership", label: "Leadership or the board" },
      { value: "engineers_or_agents", label: "Engineers or coding agents" },
    ],
  },
  { field: "model_driven", question: "Does its output come from a model or agent?", options: YES_NO },
] as const satisfies { field: keyof PrdAnswers; question: string; options: Option<unknown>[] }[];

const ROADMAP_QUESTIONS = [
  {
    field: "audience",
    question: "Who reads it first?",
    options: [
      { value: "board", label: "Board or investors" },
      { value: "team", label: "The product team" },
      { value: "engineering", label: "Engineering" },
      { value: "public", label: "Customers (public)" },
    ],
  },
  { field: "external_dates", question: "Are there real external dates (a launch, contract or event)?", options: YES_NO },
  {
    field: "horizon",
    question: "How far ahead does it look?",
    options: [
      { value: "one_cycle", label: "One cycle" },
      { value: "one_two_quarters", label: "One or two quarters" },
      { value: "up_to_two_years", label: "Up to two years" },
    ],
  },
  {
    field: "planning_style",
    question: "How does the team plan?",
    options: [
      { value: "cycles", label: "Fixed cycles" },
      { value: "sprints", label: "Sprints" },
      { value: "continuous", label: "Continuous flow" },
    ],
  },
  { field: "tracker_connected", question: "Is an engineering tracker connected?", options: YES_NO },
  { field: "show_capacity", question: "Show team capacity?", options: YES_NO },
  { field: "public_version", question: "Also publish a public version?", options: YES_NO },
] as const satisfies { field: keyof RoadmapAnswers; question: string; options: Option<unknown>[] }[];

function Question<V extends string | boolean>({
  name,
  question,
  options,
  value,
  onChange,
}: {
  name: string;
  question: string;
  options: readonly Option<V>[];
  value: V | null | undefined;
  onChange: (v: V | null) => void;
}) {
  const choices: Option<V | null>[] = [{ value: null, label: "Not sure" }, ...options];
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[15px] font-semibold text-text">{question}</legend>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((o) => {
          const checked = (value ?? null) === o.value;
          return (
            <label
              key={String(o.value)}
              className={`inline-flex h-8 cursor-pointer items-center rounded-lg border px-3 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                checked && o.value === null
                  ? "border-accent-mid bg-accent-soft text-accent-ink"
                  : checked
                  ? "border-accent bg-accent text-on-accent"
                  : o.value === null
                    ? "border-line bg-surface text-text2 hover:bg-surface2"
                    : "border-line-strong bg-surface text-text hover:bg-surface2"
              }`}
            >
              <input type="radio" name={name} className="sr-only" checked={checked} onChange={() => onChange(o.value)} />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function NumberQuestion({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="flex items-end gap-2">
      <label className="block">
        <span className="mb-1.5 block text-[15px] font-semibold text-text">{label}</span>
        <input
          type="number"
          min={0}
          className={`${INPUT} tnum w-28`}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))))}
        />
      </label>
      {hint && (
        <span className="pb-2">
          <InfoTip label={label} align="start">
            {hint}
          </InfoTip>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- last choice (localStorage)

const storageKey = (kind: Kind) => `po-new-draft-${kind}`;
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

function useLastChoice(kind: Kind): Choice | null {
  const raw = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(storageKey(kind)),
    () => null,
  );
  return useMemo(() => {
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as Choice;
      return typeof c?.template === "string" ? c : null;
    } catch {
      return null;
    }
  }, [raw]);
}

// ---------------------------------------------------------------- template and theme choice

type Pick = { key: string | null; source: "user" | "company" };

const recommend = (body: Schemas["RecommendIn"]) => unwrap(api.POST("/v1/drafts/recommend", { body }));

/**
 * The recommended template and theme for `input`, with the user's overrides: shared by
 * the new-draft picker and Build roadmap (O4b). Before any answer the last choice wins.
 */
export function useDraftChoice(input: Schemas["RecommendIn"]) {
  const kind = input.kind;
  const [templatePick, setTemplatePick] = useState<Pick | null>(null);
  const [themePick, setThemePick] = useState<Pick | null>(null);
  const last = useLastChoice(kind);

  const live = useLive(input, recommend, 250);
  const rec = live.data;
  const themes = useQuery(`themes|${kind}`, () => unwrap(api.GET("/v1/themes", { params: { query: { kind } } })));

  const answered = Object.values((kind === "prd" ? input.prd : input.roadmap) ?? {}).some((v) => v != null);
  const templates = rec?.templates ?? [];
  const has = (k: string | null | undefined) => !!k && templates.some((t) => t.key === k);
  const themeKeys = new Set((themes.data ?? []).map((t) => t.key));
  const hasTheme = (k: string | null | undefined): k is string => !!k && themeKeys.has(k);

  // Template: an explicit pick, else (before any answer) the last choice, else the recommendation.
  const useLast = !templatePick && !answered && has(last?.template);
  const templateKey = (templatePick && has(templatePick.key) ? templatePick.key : null) ?? (useLast ? last!.template : rec?.template.key ?? null);
  const template = templates.find((t) => t.key === templateKey) ?? null;
  const templateSource = templatePick && has(templatePick.key) ? templatePick.source : useLast ? "last" : "recommended";

  // Theme: an explicit pick, else the last choice with its template, else the recommendation
  // (for the recommended template) or the chosen template's suggestion.
  let themeKey: string | null = null;
  if (themePick && (themePick.key === null || hasTheme(themePick.key))) themeKey = themePick.key;
  else if (useLast && hasTheme(last?.theme)) themeKey = last!.theme!;
  else if (templateKey === rec?.template.key) themeKey = rec?.theme?.key ?? null;
  else if (hasTheme(template?.suggested_theme)) themeKey = template!.suggested_theme;
  else themeKey = rec?.theme?.key ?? null;

  return { kind, live, rec, themes, templates, template, templateKey, templateSource, themeKey, themePick, setTemplatePick, setThemePick };
}

type DraftChoice = ReturnType<typeof useDraftChoice>;

/** The template cards and theme thumbnails of a draft choice, with the recommended marks. */
export function TemplateThemePicker({ choice }: { choice: DraftChoice }) {
  const { kind, rec, themes, templates, templateKey, templateSource, themeKey, themePick, setTemplatePick, setThemePick } = choice;
  // Unique per picker: Next keeps visited pages mounted, and same-named radios would share a group.
  const id = useId();
  return (
    <>
      <section aria-labelledby={`${id}-template`}>
        <div className="mb-2.5 flex min-h-8 flex-wrap items-center gap-2.5">
          <h2 id={`${id}-template`} className="font-display text-lg leading-6 font-bold tracking-[-0.01em]">
            Template
          </h2>
          {templateSource === "last" && <Chip kind="acc">Your last choice</Chip>}
          {templateSource === "company" && <Chip kind="acc">Company default</Chip>}
          {rec && templateKey !== rec.template.key && (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setTemplatePick({ key: rec.template.key, source: "user" });
                setThemePick(null);
              }}
            >
              Use recommended
            </Button>
          )}
        </div>
        <div role="radiogroup" aria-labelledby={`${id}-template`} className="grid gap-2 sm:grid-cols-2">
          {templates.map((t) => {
            const checked = t.key === templateKey;
            return (
              <label
                key={t.key}
                data-testid={`template-option-${t.key}`}
                title={[t.description, t.suggest_when && `When: ${t.suggest_when}`].filter(Boolean).join("\n") || undefined}
                className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-button border bg-surface px-3 py-2.5 ${
                  checked ? "border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong"
                }`}
              >
                <input
                  type="radio"
                  name={`${id}-template`}
                  className="mt-1 size-4 flex-none accent-[var(--accent)]"
                  checked={checked}
                  onChange={() => {
                    setTemplatePick({ key: t.key, source: "user" });
                    if (themePick?.source !== "user") setThemePick(null);
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold text-text">{t.name}</span>
                    {rec?.template.key === t.key && (
                      <Chip kind="pass" className="flex-none">
                        Recommended
                      </Chip>
                    )}
                  </span>
                  {t.description && <span className="mt-0.5 block truncate text-sm text-text2">{t.description}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={`${id}-theme`}>
        <div className="mb-2.5 flex min-h-8 items-center gap-2.5">
          <h2 id={`${id}-theme`} className="font-display text-lg leading-6 font-bold tracking-[-0.01em]">
            Theme
          </h2>
          {rec && themeKey === rec.theme?.key && rec.theme_reason && (
            <InfoTip label="the recommended theme" align="start">
              {rec.theme_reason}
            </InfoTip>
          )}
        </div>
        {themes.error && <ErrorNote>{themes.error}</ErrorNote>}
        {themes.loading && <Loading />}
        <div role="radiogroup" aria-labelledby={`${id}-theme`} className="flex flex-wrap gap-3">
          {themes.data?.map((t) => {
            const checked = t.key === themeKey;
            return (
              <label
                key={t.key}
                data-testid={`theme-option-${t.key}`}
                className={`flex w-[178px] cursor-pointer flex-col gap-1.5 rounded-button border bg-surface p-2 ${
                  checked ? "border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong"
                }`}
              >
                <ThemeThumbnail tokens={t.tokens} css={t.css} kind={kind} />
                <span className="flex min-w-0 items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${id}-theme`}
                    className="size-4 flex-none accent-[var(--accent)]"
                    checked={checked}
                    onChange={() => setThemePick({ key: t.key, source: "user" })}
                  />
                  <span className="truncate text-sm font-semibold text-text">{t.name}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>
    </>
  );
}

/** Remembers a draft's template and theme as the user's last choice for the kind. */
function saveLastChoice(kind: Kind, template: string, theme: string | null) {
  localStorage.setItem(storageKey(kind), JSON.stringify({ template, theme }));
}

// ---------------------------------------------------------------- picker

/** New-draft picker: a few questions, the recommended template and theme, overrides, create. */
export function NewDraft({ kind }: { kind: Kind }) {
  const router = useRouter();
  const { role } = useMe();
  const isOwner = role === "owner";
  const label = kind === "prd" ? "PRD" : "roadmap";
  const [prd, setPrd] = useState<PrdAnswers>({});
  const [roadmap, setRoadmap] = useState<RoadmapAnswers>({});
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<"create" | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const choice = useDraftChoice(kind === "prd" ? { kind, prd } : { kind, roadmap });
  const { live, rec, themes, templates, template, templateKey, themeKey, setTemplatePick, setThemePick } = choice;
  const defaults = useQuery("draft-defaults", () => unwrap(api.GET("/v1/drafts/defaults")));
  const company = defaults.data?.[kind] ?? null;

  const setAnswer = <K extends keyof PrdAnswers>(k: K, v: PrdAnswers[K]) => setPrd((a) => ({ ...a, [k]: v }));
  const setRoad = <K extends keyof RoadmapAnswers>(k: K, v: RoadmapAnswers[K]) => setRoadmap((a) => ({ ...a, [k]: v }));

  function applyCompany() {
    if (!company) return;
    setTemplatePick({ key: company.template, source: "company" });
    setThemePick({ key: company.theme ?? null, source: "company" });
  }

  async function makeDefault() {
    if (!templateKey) return;
    setBusy("default");
    setError(null);
    setNotice(null);
    try {
      const next = await unwrapProblems(
        api.PUT("/v1/drafts/defaults", {
          body: { ...(defaults.data ?? {}), [kind]: { template: templateKey, theme: themeKey } },
        }),
      );
      defaults.setData(() => next);
      setNotice(`Company default for new ${label}s saved.`);
    } catch (e) {
      setError(e instanceof ProblemsError ? e.problems.map((p) => p.message).join(" ") : e instanceof Error && e.message ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!templateKey || !title.trim()) return;
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const out = await unwrapProblems(
        api.POST("/v1/drafts", { body: { kind, title: title.trim(), template: templateKey, theme: themeKey } }),
      );
      saveLastChoice(kind, templateKey, themeKey);
      router.push(`/documents/${out.slug}`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : errorMessage(err));
      setBusy(null);
    }
  }

  const companyTemplateName = company && templates.find((t) => t.key === company.template)?.name;
  const companyThemeName = company?.theme && themes.data?.find((t) => t.key === company.theme)?.name;

  const themeName = themeKey ? (themes.data?.find((t) => t.key === themeKey)?.name ?? themeKey) : null;
  const formId = `new-draft-${kind}`;

  const inspector = (
    <div data-testid="recommendation-panel" aria-live="polite" className={live.pending ? "opacity-70" : ""}>
      <Inspector
        label="Recommendation"
        eyebrow="Recommended"
        title={rec ? <span data-testid="recommended-template">{rec.template.name}</span> : live.error ? "–" : "…"}
        chips={
          rec && (
            <>
              {rec.theme && <Chip hero>{rec.theme.name}</Chip>}
              {rec.variant && rec.variant !== "team" && <Chip hero>{rec.variant}</Chip>}
              {rec.group_by && rec.variant && rec.variant !== "team" && <Chip hero>by {rec.group_by}</Chip>}
            </>
          )
        }
      >
        {live.error && (
          <InspectorSection>
            <ErrorNote>{live.error}</ErrorNote>
          </InspectorSection>
        )}
        {rec && (
          <InspectorSection
            label="Why"
            tools={
              // I3 rule 1: the reasoning is prose, so it sits behind the (i).
              <InfoTip label="the recommendation">
                <span data-testid="recommendation-reason">{rec.reason}</span>
              </InfoTip>
            }
          >
            <div data-testid="recommendation">
              <p className="font-semibold text-text">
                {rec.company_default?.template === rec.template.key ? "Company default" : "Fits your answers"}
              </p>
              {rec.warnings.length > 0 && (
                <ul data-testid="recommendation-warnings" className="mt-2.5 flex flex-col gap-1.5">
                  {rec.warnings.map((w, i) => (
                    <li key={i} className="flex gap-2 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
                      <Icon name="alert" size={16} className="mt-0.5 flex-none" />
                      <span className="min-w-0">{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </InspectorSection>
        )}
        <InspectorSection label="Selected">
          <InspectorRow value={template ? `v${template.latest_version}` : undefined}>{template?.name ?? "–"}</InspectorRow>
          <InspectorRow>{themeName ?? "No theme"}</InspectorRow>
        </InspectorSection>
        {(company || isOwner) && (
          <InspectorSection label="Company default">
            {company && (
              <div data-testid="company-default" className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {companyTemplateName ?? company.template}
                  {company.theme && <span className="font-normal text-text2"> · {companyThemeName ?? company.theme}</span>}
                </span>
                <Button variant="solid" onClick={applyCompany}>
                  Use company default
                </Button>
              </div>
            )}
            {isOwner && (
              <div className={`flex items-center gap-2 ${company ? "mt-2.5" : ""}`}>
                <Button onClick={makeDefault} disabled={busy !== null || !templateKey}>
                  {busy === "default" ? "Saving…" : "Make company default"}
                </Button>
                <InfoTip label="company default" align="start" side="bottom">
                  New {label}s start with this template and theme unless someone picks another.
                </InfoTip>
              </div>
            )}
          </InspectorSection>
        )}
      </Inspector>
    </div>
  );

  return (
    <Page>
      <PageHeader
        back={
          <Link
            href={kind === "roadmap" ? "/roadmap" : "/documents"}
            className="inline-flex items-center gap-1 font-medium text-text2 hover:text-text"
          >
            <Icon name="back" size={16} />
            {kind === "roadmap" ? "Roadmap" : "PRDs"}
          </Link>
        }
        title={`New ${label}`}
        status={
          <InfoTip label={`new ${label}s`} align="start" side="bottom">
            Answer what you can; every question is optional. The template and theme follow your answers, and you can
            change either.
          </InfoTip>
        }
        action={
          <Button form={formId} type="submit" variant="primary" icon="plus" disabled={busy !== null || !templateKey || !title.trim()}>
            {busy === "create" ? "Creating…" : "Create draft"}
          </Button>
        }
      />

      <form id={formId} onSubmit={create}>
        <Split inspector={inspector}>
          {notice && <Notice tone="pass">{notice}</Notice>}
          {error && <ErrorNote>{error}</ErrorNote>}
          <Panel bodyClassName="p-4">
            <label className="block">
              <span className="mb-1.5 block text-[15px] font-semibold text-text">Title</span>
              <input
                className={INPUT}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === "prd" ? "Saved addresses at checkout" : "Product roadmap, next two quarters"}
                required
              />
            </label>
          </Panel>

          <Panel as="div" bodyClassName="p-4">
            <section aria-labelledby="questions-heading">
              <h2 id="questions-heading" className="mb-3 font-display text-lg leading-6 font-bold tracking-[-0.01em]">
                About this {label}
              </h2>
              <div className="flex flex-col gap-4">
                {kind === "prd" &&
                  PRD_QUESTIONS.map((q) => (
                    <Question
                      key={q.field}
                      name={q.field}
                      question={q.question}
                      options={q.options as readonly Option<string | boolean>[]}
                      value={prd[q.field]}
                      onChange={(v) => setAnswer(q.field, v as never)}
                    />
                  ))}
                {kind === "roadmap" && (
                  <>
                    {ROADMAP_QUESTIONS.map((q) => (
                      <Question
                        key={q.field}
                        name={q.field}
                        question={q.question}
                        options={q.options as readonly Option<string | boolean>[]}
                        value={roadmap[q.field]}
                        onChange={(v) => setRoad(q.field, v as never)}
                      />
                    ))}
                    <div className="flex flex-wrap gap-6">
                      <NumberQuestion label="How many teams?" value={roadmap.teams} onChange={(v) => setRoad("teams", v)} />
                      <NumberQuestion
                        label="Confirmed goals"
                        hint="From the baseline; change it to plan ahead."
                        value={roadmap.confirmed_goals ?? rec?.confirmed_goals}
                        onChange={(v) => setRoad("confirmed_goals", v)}
                      />
                    </div>
                  </>
                )}
              </div>
            </section>
          </Panel>

          <Panel as="div" bodyClassName="flex flex-col gap-6 p-4">
            <TemplateThemePicker choice={choice} />
          </Panel>
        </Split>
      </form>
    </Page>
  );
}
