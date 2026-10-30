"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ProblemList } from "@/components/TemplateBodyEditor";
import { ThemePreview } from "@/components/ThemePreview";
import { KeyField, keyValid } from "@/app/settings/_components/KeyField";
import { GrowingTextarea } from "@/app/settings/_components/GrowingTextarea";
import { Field, INPUT, SELECT } from "@/app/settings/_components/fields";
import { FormActions } from "@/app/settings/_components/FormActions";
import { Button, InfoTip, Notice, PageHeader, Panel } from "@/components/ds";
import { Loading } from "@/components/ui";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { errorMessage, useQuery } from "@/lib/use-query";

type ThemeKind = Schemas["ThemeOut"]["kind"];

/** New theme: a key and a name, starting from a copy of an existing theme; then the editor. */
export default function NewThemePage() {
  const router = useRouter();
  const themes = useQuery("themes|all", () => unwrap(api.GET("/v1/themes", { params: { query: { include_archived: true } } })));
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ThemeKind>("prd");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A key that is taken: said under the Key field.
  const [keyError, setKeyError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const base = themes.data?.find((t) => t.key === (from ?? "clean-document")) ?? themes.data?.[0];
  // qa-settings-28: why Create is disabled, said next to it.
  const reason = busy
    ? null
    : !key
      ? "Enter a key to create the theme."
      : !keyValid(key)
        ? "Fix the key to create the theme."
        : !name.trim()
          ? "Enter a name to create the theme."
          : !base
            ? "Loading the themes to start from…"
            : null;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!base) return;
    setBusy(true);
    setError(null);
    setKeyError(null);
    setProblems([]);
    try {
      const t = await unwrapProblems(
        api.POST("/v1/themes", {
          body: {
            key: key.trim(),
            name: name.trim(),
            kind,
            description: description.trim() || null,
            tokens: base.tokens,
            css: base.css,
            // A company theme's slide CSS comes along; built-ins have none (theirs is in code).
            slide_css: base.slide_css ?? null,
          },
        }),
      );
      router.push(`/settings/themes/${t.key}`);
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
          <Link href="/settings/themes" className="inline-flex items-center hover:text-text hover:underline max-[600px]:min-h-11">
            ← Themes
          </Link>
        }
        title="New theme"
      />
      {themes.error && <Notice tone="error">{themes.error}</Notice>}
      <div className="grid grid-cols-[420px_minmax(0,1fr)] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3">
        <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
          <Panel title="Details" bodyClassName="p-4 max-[600px]:p-3">
            <form id="new-theme" onSubmit={create} className="flex flex-col gap-3">
              <KeyField
                id="theme-key"
                value={key}
                onChange={(v) => {
                  setKey(v);
                  setKeyError(null);
                }}
                error={keyError}
                placeholder="company-brand"
              />
              <Field label="Name">
                <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Company brand" required />
              </Field>
              <Field label="For">
                <select className={`${SELECT} h-9 w-full`} value={kind} onChange={(e) => setKind(e.target.value as ThemeKind)}>
                  <option value="prd">PRD</option>
                  <option value="roadmap">Roadmap</option>
                  <option value="any">Any document</option>
                </select>
              </Field>
              <Field label="Description">
                <GrowingTextarea value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field
                label="Start from"
                htmlFor="theme-from"
                tip={
                  <InfoTip label="copying" align="start">
                    Its fonts, colours and CSS are copied; edit them next.
                  </InfoTip>
                }
              >
                {themes.loading ? (
                  <Loading />
                ) : (
                  <select
                    id="theme-from"
                    className={`${SELECT} h-9 w-full`}
                    value={base?.key ?? ""}
                    onChange={(e) => setFrom(e.target.value)}
                  >
                    {themes.data?.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <FormActions id="create-theme-reason" reason={reason} className="mt-1">
                <Button
                  type="submit"
                  variant="primary"
                  icon="plus"
                  disabled={busy || !base || !keyValid(key) || !name.trim()}
                  aria-describedby={reason ? "create-theme-reason" : undefined}
                >
                  {busy ? "Creating…" : "Create theme"}
                </Button>
              </FormActions>
            </form>
          </Panel>
          {error && <Notice tone="error">{error}</Notice>}
          {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
        </div>
        <Panel title="Preview" bodyClassName="p-4 max-[600px]:p-3">
          {base ? (
            <ThemePreview tokens={base.tokens} css={base.css} kind={kind === "roadmap" ? "roadmap" : "prd"} />
          ) : (
            <Loading />
          )}
        </Panel>
      </div>
    </>
  );
}
