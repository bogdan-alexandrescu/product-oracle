"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Field, INPUT, SELECT_FIELD } from "@/app/settings/_components/fields";
import { FormActions } from "@/app/settings/_components/FormActions";
import { KEY_RE } from "@/app/settings/_components/KeyField";
import { GrowingTextarea } from "@/app/settings/_components/GrowingTextarea";
import { Button, InfoTip, Notice, PageHeader, Panel, confirmInPage } from "@/components/ds";
import {
  ProblemList,
  SOURCES_BODY,
  SectionRows,
  TemplateBodyEditor,
  keyFromName,
  serializeTemplateSections,
  useTemplateCheck,
  type Sec,
} from "@/components/TemplateBodyEditor";
import { ApiError, api, unwrap } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { errorMessage, useQuery } from "@/lib/use-query";

const START: Sec[] = [
  { id: "", heading: "Problem", guide: "The customer problem, in the customer's terms.", brief: true },
  { id: "", heading: "Solution", guide: "What we will build, as conclusions.", brief: true },
  { id: "", heading: "Launch plan", guide: "Who hears about it, when and how.", brief: false },
];

/** The template's Markdown, written from the fields. */
function bodyOf(theme: string, when: string, secs: Sec[]) {
  return serializeTemplateSections({
    theme,
    frontExtra: [`suggest_when: ${JSON.stringify(when.trim())}`],
    titleLine: "# <Title> {#title}",
    secs,
    sourcesBlock: SOURCES_BODY,
  });
}

/**
 * New template (QD4 a, cards and fields): a template is made from fields, one row per section
 * with its heading, its guide and "Show in the brief", ending with Sources and data points. The
 * Markdown is one click away under Edit as Markdown. The details keep its name (its key is made
 * from the name), kind, theme and when to suggest it.
 */
export default function NewTemplatePage() {
  const router = useRouter();
  const themes = useQuery("new-template-themes", () => unwrap(api.GET("/v1/themes")));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"prd" | "roadmap">("prd");
  const [theme, setTheme] = useState("clean-document");
  const [when, setWhen] = useState("");
  const [secs, setSecs] = useState<Sec[]>(START);
  // The Markdown, once opened under Edit as Markdown; null while the fields are shown.
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A key that is taken: said under the name.
  const [keyError, setKeyError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const body = raw ?? bodyOf(theme, when, secs);
  const live = useTemplateCheck(body);
  const key = keyFromName(name);
  // qa-settings-28: why Create is disabled, said next to it.
  const reason = busy
    ? null
    : !name.trim() || !key
      ? "Enter a name to create the template."
      : !KEY_RE.test(key)
        ? "Make the name at least two letters or digits long."
        : live.pending || !live.data
        ? "Checking the template…"
        : !live.data.valid
          ? "Fix the problems in the template to create it."
          : null;

  // Back to fields drops the Markdown: typed changes ask first.
  async function toggleMarkdown() {
    if (raw == null) return setRaw(bodyOf(theme, when, secs));
    if (
      raw !== bodyOf(theme, when, secs) &&
      !(await confirmInPage({
        title: "Discard your changes?",
        message: "The fields do not hold what you typed in the Markdown. Going back to them throws it away.",
        action: "Discard",
        cancel: "Keep editing",
        destructive: true,
      }))
    )
      return;
    setRaw(null);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setKeyError(null);
    setProblems([]);
    try {
      const t = await unwrapProblems(
        api.POST("/v1/templates", { body: { key, name: name.trim(), kind, description: when.trim() || null, body } }),
      );
      router.push(`/settings/templates/${t.key}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setKeyError(err.message);
      else setError(err instanceof Error && err.message ? err.message : errorMessage(err));
      if (err instanceof ProblemsError) setProblems(err.problems);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        back={
          <Link href="/settings/templates" className="inline-flex items-center hover:text-text hover:underline max-[600px]:min-h-11">
            ← Templates
          </Link>
        }
        title="New template"
      />
      <form
        id="new-template"
        onSubmit={create}
        className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3"
      >
        <div className="flex min-w-0 flex-col gap-4 max-[1100px]:order-2 max-[600px]:gap-3">
          {error && <Notice tone="error">{error}</Notice>}
          {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
          <Panel
            title={raw == null ? "Sections" : "Markdown"}
            tools={
              <>
                {raw == null && (
                  <InfoTip label="sections" align="start">
                    Every document from this template has these sections, in this order. The guide is what the writer, or
                    Oracle, is told to put there.
                  </InfoTip>
                )}
                <Button variant="ghost" onClick={() => void toggleMarkdown()} data-testid="toggle-markdown">
                  {raw == null ? "Edit as Markdown" : "Back to fields"}
                </Button>
              </>
            }
            bodyClassName="p-4 max-[600px]:p-3"
          >
            {raw == null ? (
              <SectionRows secs={secs} onChange={setSecs} />
            ) : (
              <TemplateBodyEditor value={raw} onChange={setRaw} live={live} />
            )}
            <FormActions id="create-template-reason" reason={reason} sticky className="mt-3">
              <Button
                type="submit"
                variant="primary"
                icon="plus"
                disabled={busy || !!reason}
                aria-describedby={reason ? "create-template-reason" : undefined}
              >
                {busy ? "Creating…" : "Create template"}
              </Button>
            </FormActions>
          </Panel>
        </div>
        <Panel title="Details" bodyClassName="flex flex-col gap-3 p-4 max-[600px]:p-3" className="max-[1100px]:order-1">
          <Field label="Name">
            <input
              className={`${INPUT} placeholder:italic placeholder:text-text2/70`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setKeyError(null);
              }}
              placeholder="e.g. Launch brief"
              required
              data-testid="template-name"
            />
          </Field>
          <span className="-mt-1 flex items-center gap-1.5 text-sm text-text2">
            <span data-testid="template-key">
              {key ? (
                <>
                  Key: <b className="font-semibold text-text">{key}</b>
                </>
              ) : (
                "Key: —"
              )}
            </span>
            <InfoTip label="the key" align="start">
              Made from the name. It cannot change later.
            </InfoTip>
          </span>
          {keyError && (
            <p role="alert" className="-mt-1 text-sm font-medium text-crit" data-testid="template-key-error">
              {keyError}
            </p>
          )}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Kind</legend>
            <div className="flex gap-4 text-[15px]">
              {(["prd", "roadmap"] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-1.5">
                  <input type="radio" name="kind" className="size-4 accent-[var(--accent)]" checked={kind === k} onChange={() => setKind(k)} />
                  {k === "prd" ? "PRD" : "Roadmap"}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Theme">
            <select className={SELECT_FIELD} value={theme} onChange={(e) => setTheme(e.target.value)} disabled={raw != null}>
              {(themes.data ?? [{ key: "clean-document", name: "Clean document" }]).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When to suggest it">
            <GrowingTextarea
              className="min-h-20"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              placeholder="e.g. A launch that needs sales and support ready on the day"
            />
          </Field>
        </Panel>
      </form>
    </>
  );
}
