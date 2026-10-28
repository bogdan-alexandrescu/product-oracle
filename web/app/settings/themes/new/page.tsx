"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ProblemList } from "@/components/TemplateBodyEditor";
import { ThemePreview } from "@/components/ThemePreview";
import { Field, INPUT, SELECT, TEXTAREA } from "@/app/settings/_components/fields";
import { Button, InfoTip, Notice, PageHeader, Panel } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { errorMessage, useQuery } from "@/lib/use-query";

type ThemeKind = Schemas["ThemeOut"]["kind"];

/** The API's key rule (KEY_PATTERN in api/oracle/templates/schemas.py). */
const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  const [problems, setProblems] = useState<Problem[]>([]);
  // qa-settings-32: say why Create is not ready, next to the field that needs it.
  const keyWrong = key !== "" && !KEY.test(key.trim());
  const missing = [!key.trim() && "a key", !name.trim() && "a name"].filter(Boolean) as string[];
  const base = themes.data?.find((t) => t.key === (from ?? "clean-document")) ?? themes.data?.[0];

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!base) return;
    setBusy(true);
    setError(null);
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
      setError(err instanceof Error && err.message ? err.message : errorMessage(err));
      if (err instanceof ProblemsError) setProblems(err.problems);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        back={
          <Link href="/settings/themes" className="hover:text-text hover:underline">
            ← Themes
          </Link>
        }
        title="New theme"
        action={
          <Button
            type="submit"
            form="new-theme"
            variant="primary"
            icon="plus"
            disabled={busy || !base || missing.length > 0 || keyWrong}
          >
            {busy ? "Creating…" : "Create theme"}
          </Button>
        }
      />
      {themes.error && <Notice tone="error">{themes.error}</Notice>}
      <div className="grid grid-cols-[420px_minmax(0,1fr)] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3">
        <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
          <Panel title="Details" bodyClassName="p-4 max-[600px]:p-3">
            <form id="new-theme" onSubmit={create} className="flex flex-col gap-3">
              {missing.length > 0 && (
                <p data-testid="create-needs" className="text-sm text-text2">
                  To create the theme, add {missing.join(" and ")}.
                </p>
              )}
              <Field
                label="Key"
                htmlFor="theme-key"
                tip={
                  <InfoTip label="allowed characters" align="start">
                    Lowercase letters, numbers and dashes. It cannot change later.
                  </InfoTip>
                }
              >
                <input
                  id="theme-key"
                  className={`${INPUT} font-mono placeholder:font-sans placeholder:italic`}
                  value={key}
                  onChange={(e) => setKey(e.target.value.toLowerCase())}
                  placeholder="e.g. company-brand"
                  pattern="[a-z0-9][a-z0-9-]{0,62}"
                  title="Lowercase letters, numbers and dashes"
                  aria-invalid={keyWrong || undefined}
                  aria-describedby={keyWrong ? "theme-key-error" : undefined}
                  required
                />
                {keyWrong && (
                  <p id="theme-key-error" data-testid="key-error" className="text-sm text-crit">
                    Use only lowercase letters, numbers and dashes, starting with a letter or number (no spaces).
                  </p>
                )}
              </Field>
              <Field label="Name">
                <input
                  className={`${INPUT} placeholder:italic`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Company brand"
                  required
                />
              </Field>
              <Field label="For">
                <select className={`${SELECT} h-9 w-full`} value={kind} onChange={(e) => setKind(e.target.value as ThemeKind)}>
                  <option value="prd">PRD</option>
                  <option value="roadmap">Roadmap</option>
                  <option value="any">Any document</option>
                </select>
              </Field>
              <Field label="Description">
                <textarea rows={3} className={TEXTAREA} value={description} onChange={(e) => setDescription(e.target.value)} />
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
