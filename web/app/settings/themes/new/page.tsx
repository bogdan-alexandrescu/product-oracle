"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ProblemList } from "@/components/TemplateBodyEditor";
import { ThemePreview } from "@/components/ThemePreview";
import { Button, ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
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
  const [problems, setProblems] = useState<Problem[]>([]);
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
    <div className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 text-sm">
        <Link href="/settings/themes" className="text-neutral-500 hover:text-neutral-900 hover:underline">
          ← Themes
        </Link>
      </p>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-neutral-900">New theme</h1>
      {themes.error && <ErrorNote>{themes.error}</ErrorNote>}
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={create} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">Key</span>
            <input
              className={`${INPUT} font-mono`}
              value={key}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="company-brand"
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              title="Lowercase letters, digits and hyphens"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">Name</span>
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Company brand" required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">For</span>
            <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as ThemeKind)}>
              <option value="prd">PRD</option>
              <option value="roadmap">Roadmap</option>
              <option value="any">Any document</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">Description</span>
            <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">Start from</span>
            {themes.loading ? (
              <Loading />
            ) : (
              <select className={INPUT} value={base?.key ?? ""} onChange={(e) => setFrom(e.target.value)}>
                {themes.data?.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <span className="mt-1 block text-xs text-neutral-500">Its fonts, colours and CSS are copied; edit them next.</span>
          </label>
          <Button type="submit" variant="primary" disabled={busy || !base || !key || !name}>
            {busy ? "Creating…" : "Create theme"}
          </Button>
          {error && <ErrorNote>{error}</ErrorNote>}
          {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
        </form>
        <div>
          {base && <ThemePreview tokens={base.tokens} css={base.css} kind={kind === "roadmap" ? "roadmap" : "prd"} />}
        </div>
      </div>
    </div>
  );
}
