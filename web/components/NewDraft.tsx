"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";

import { ThemeThumbnail } from "@/components/ThemePreview";
import { Badge, Button, ErrorNote, INPUT, Loading } from "@/components/ui";
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
    <fieldset className="text-sm">
      <legend className="mb-1.5 font-medium text-neutral-800">{question}</legend>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((o) => {
          const checked = (value ?? null) === o.value;
          return (
            <label
              key={String(o.value)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 ${
                checked ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() => onChange(o.value)}
              />
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
    <label className="block text-sm">
      <span className="mb-1.5 block font-medium text-neutral-800">{label}</span>
      <input
        type="number"
        min={0}
        className={`${INPUT} w-28`}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))))}
      />
      {hint && <span className="ml-2 text-xs text-neutral-500">{hint}</span>}
    </label>
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

// ---------------------------------------------------------------- picker

type Pick = { key: string | null; source: "user" | "company" };

const recommend = (body: Schemas["RecommendIn"]) => unwrap(api.POST("/v1/drafts/recommend", { body }));

/** New-draft picker: a few questions, the recommended template and theme, overrides, create. */
export function NewDraft({ kind }: { kind: Kind }) {
  const router = useRouter();
  const { role } = useMe();
  const isOwner = role === "owner";
  const label = kind === "prd" ? "PRD" : "roadmap";
  const [prd, setPrd] = useState<PrdAnswers>({});
  const [roadmap, setRoadmap] = useState<RoadmapAnswers>({});
  const [templatePick, setTemplatePick] = useState<Pick | null>(null);
  const [themePick, setThemePick] = useState<Pick | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<"create" | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const last = useLastChoice(kind);

  const input: Schemas["RecommendIn"] = kind === "prd" ? { kind, prd } : { kind, roadmap };
  const live = useLive(input, recommend, 250);
  const rec = live.data;
  const themes = useQuery(`themes|${kind}`, () => unwrap(api.GET("/v1/themes", { params: { query: { kind } } })));
  const defaults = useQuery("draft-defaults", () => unwrap(api.GET("/v1/drafts/defaults")));
  const company = defaults.data?.[kind] ?? null;

  const answered = Object.values(kind === "prd" ? prd : roadmap).some((v) => v != null);
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
      localStorage.setItem(storageKey(kind), JSON.stringify({ template: templateKey, theme: themeKey }));
      router.push(`/documents/${out.slug}`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : errorMessage(err));
      setBusy(null);
    }
  }

  const companyTemplateName = company && templates.find((t) => t.key === company.template)?.name;
  const companyThemeName = company?.theme && themes.data?.find((t) => t.key === company.theme)?.name;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 text-sm">
        <Link href="/documents" className="text-neutral-500 hover:text-neutral-900 hover:underline">
          ← Documents
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-neutral-900">New {label}</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Answer what you can; every question is optional. The template and theme follow your answers, and you can change
        either below.
      </p>

      <form onSubmit={create} className="space-y-8">
        <section aria-labelledby="questions-heading" className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 id="questions-heading" className="mb-3 text-sm font-semibold text-neutral-700">
            About this {label}
          </h2>
          <div className="space-y-4">
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

        <section aria-labelledby="recommendation-heading">
          <h2 id="recommendation-heading" className="mb-2 text-sm font-semibold text-neutral-700">
            Recommendation
          </h2>
          {live.error && <ErrorNote>{live.error}</ErrorNote>}
          {!rec && !live.error && <Loading />}
          {rec && (
            <div
              data-testid="recommendation"
              aria-live="polite"
              className={`rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm ${live.pending ? "opacity-60" : ""}`}
            >
              <p className="text-neutral-900">
                <span className="font-semibold" data-testid="recommended-template">
                  {rec.template.name}
                </span>
                {rec.theme && <span className="text-neutral-600"> with the {rec.theme.name} theme</span>}
              </p>
              <p data-testid="recommendation-reason" className="mt-0.5 text-neutral-700">
                {rec.reason}
              </p>
              {rec.variant && rec.variant !== "team" && (
                <p className="mt-0.5 text-xs text-neutral-500">
                  Variant: {rec.variant}
                  {rec.group_by ? ` · grouped by ${rec.group_by}` : ""}
                </p>
              )}
              {rec.warnings.length > 0 && (
                <ul data-testid="recommendation-warnings" className="mt-2 space-y-1">
                  {rec.warnings.map((w, i) => (
                    <li key={i} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {company && (
            <p data-testid="company-default" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
              Company default: <span className="font-medium text-neutral-800">{companyTemplateName ?? company.template}</span>
              {company.theme && <span>with {companyThemeName ?? company.theme}</span>}
              <Button size="sm" variant="ghost" onClick={applyCompany}>
                Use company default
              </Button>
            </p>
          )}
        </section>

        <section aria-labelledby="template-heading">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h2 id="template-heading" className="text-sm font-semibold text-neutral-700">
              Template
            </h2>
            {templateSource === "last" && <Badge tone="blue">Your last choice</Badge>}
            {templateSource === "company" && <Badge tone="blue">Company default</Badge>}
            {rec && templateKey !== rec.template.key && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTemplatePick({ key: rec.template.key, source: "user" });
                  setThemePick(null);
                }}
              >
                Use the recommended template
              </Button>
            )}
          </div>
          <div role="radiogroup" aria-labelledby="template-heading" className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => {
              const checked = t.key === templateKey;
              return (
                <label
                  key={t.key}
                  data-testid={`template-option-${t.key}`}
                  className={`flex cursor-pointer gap-2.5 rounded-lg border bg-white p-3 text-sm ${
                    checked ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    className="mt-0.5"
                    checked={checked}
                    onChange={() => {
                      setTemplatePick({ key: t.key, source: "user" });
                      if (themePick?.source !== "user") setThemePick(null);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-neutral-900">{t.name}</span>
                    {rec?.template.key === t.key && (
                      <>
                        {" "}
                        <Badge tone="green">Recommended</Badge>
                      </>
                    )}
                    {t.description && <span className="mt-0.5 block text-xs text-neutral-600">{t.description}</span>}
                    {t.suggest_when && <span className="mt-0.5 block text-xs text-neutral-400">When: {t.suggest_when}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="theme-heading">
          <h2 id="theme-heading" className="mb-1 text-sm font-semibold text-neutral-700">
            Theme
          </h2>
          {rec && themeKey === rec.theme?.key && rec.theme_reason && (
            <p className="mb-2 text-xs text-neutral-500">{rec.theme_reason}</p>
          )}
          {themes.error && <ErrorNote>{themes.error}</ErrorNote>}
          {themes.loading && <Loading />}
          <div role="radiogroup" aria-labelledby="theme-heading" className="flex flex-wrap gap-3">
            {themes.data?.map((t) => {
              const checked = t.key === themeKey;
              return (
                <label
                  key={t.key}
                  data-testid={`theme-option-${t.key}`}
                  className={`flex w-[178px] cursor-pointer flex-col gap-1.5 rounded-lg border bg-white p-2 text-sm ${
                    checked ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  <ThemeThumbnail tokens={t.tokens} css={t.css} kind={kind} />
                  <span className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="theme"
                      checked={checked}
                      onChange={() => setThemePick({ key: t.key, source: "user" })}
                    />
                    <span className="font-medium text-neutral-900">{t.name}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-800">Title</span>
            <input
              className={INPUT}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "prd" ? "Saved addresses at checkout" : "Product roadmap, next two quarters"}
              required
            />
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy !== null || !templateKey || !title.trim()}>
              {busy === "create" ? "Creating…" : "Create draft"}
            </Button>
            {template && (
              <span className="text-sm text-neutral-600">
                {template.name} v{template.latest_version}
                {themeKey && ` · ${themes.data?.find((t) => t.key === themeKey)?.name ?? themeKey}`}
              </span>
            )}
            {isOwner && (
              <Button
                className="ml-auto"
                onClick={makeDefault}
                disabled={busy !== null || !templateKey}
                title={`New ${label}s start with this template and theme unless someone picks another`}
              >
                {busy === "default" ? "Saving…" : "Make company default"}
              </Button>
            )}
          </div>
          {notice && (
            <p role="status" className="mt-3 text-sm text-emerald-800">
              {notice}
            </p>
          )}
          {error && (
            <div className="mt-3">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
        </section>
      </form>
    </div>
  );
}
