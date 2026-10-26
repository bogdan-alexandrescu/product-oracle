"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { AutonomyNote, useAutonomyLevel } from "@/lib/autonomy";
import { useCompanyZone } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

import { TEMPLATES, defaultPeriod, defaultTitle, templateOf, todayIso, type Period, type Update, type UpdateTemplate } from "./lib";

/**
 * New update (owners only; H8 §3), the same shape as the New PRD door: choose the template,
 * check the period (from the day after the last approved update of that template, else the
 * first of this month, through today) and the title, then Draft with Oracle: the draft is
 * started from the template, and Oracle's update_draft run writes it (quick depth for an
 * investor update, standard for a board update). At Observe (H11: Settings › Autonomy's
 * "Words for people outside") Oracle drafts no update: the dialog says so and only starts
 * the update from its template, for the owner to write.
 */
export function NewUpdateDialog({ updates, onClose }: { updates: Update[]; onClose: () => void }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const [template, setTemplate] = useState<UpdateTemplate>("investor-update");
  // The period's days are days in the Company time zone (#401).
  const today = todayIso(useCompanyZone());
  const [period, setPeriod] = useState<Period>(() => defaultPeriod(updates, "investor-update", today));
  // The title follows the template and period until the owner writes their own.
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const title = customTitle ?? defaultTitle(template, period);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = templateOf(template)!;
  const observing = useAutonomyLevel("external_messages") === "observe";

  function pick(t: UpdateTemplate) {
    setTemplate(t);
    setPeriod(defaultPeriod(updates, t, today));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Give the update a title");
    if (!period.from || !period.to) return setError("Choose the period's first and last day");
    if (period.from > period.to) return setError("The period starts after it ends");
    setBusy(true);
    setError(null);
    try {
      const draft = await unwrap(api.POST("/v1/drafts", { body: { kind: "update", title: title.trim(), template, period } }));
      if (observing) return router.push(`/documents/${draft.slug}`);
      const run = await unwrap(
        api.POST("/v1/runs", {
          body: { flow: "update_draft", document: draft.slug, knobs: { depth: chosen.depth, roles: {}, checkpoints: {} } },
        }),
      );
      await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: run.id } } }));
      router.push(`/documents/${draft.slug}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-update-title"
        tabIndex={-1}
        data-testid="new-update"
        className="w-full max-w-xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="new-update-title" className="font-display text-xl font-bold tracking-heading">
            New update
          </h2>
        </div>
        <form className="flex flex-col gap-4 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-text2">Template</legend>
            {TEMPLATES.map((t) => (
              <label
                key={t.key}
                data-testid={`update-template-${t.key}`}
                className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-button border bg-surface px-3 py-2.5 ${
                  template === t.key ? "border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong"
                }`}
              >
                <input
                  type="radio"
                  name="update-template"
                  value={t.key}
                  checked={template === t.key}
                  onChange={() => pick(t.key)}
                  className="mt-1"
                  data-autofocus={template === t.key ? "" : undefined}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold text-text">{t.name}</span>
                  <span className="text-sm text-text2">{t.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold text-text2">Period</legend>
            <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
              <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
                From
                <input type="date" className={INPUT} value={period.from} max={today} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
                To
                <input type="date" className={INPUT} value={period.to} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} />
              </label>
            </div>
            <p className="text-sm text-text2">From the day after the last approved {chosen.name.toLowerCase()}, through today.</p>
          </fieldset>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Title
            <input className={INPUT} value={title} maxLength={200} onChange={(e) => setCustomTitle(e.target.value)} />
          </label>
          {observing ? (
            <AutonomyNote testId="update-observing" onFollow={onClose}>
              Oracle is set to observe words for people outside, so it drafts no update. Start it from the template and write it yourself, or
              change this in
            </AutonomyNote>
          ) : (
            <p className="text-sm text-text2">
              Oracle drafts the product part at {chosen.depth} depth: metrics first, only dates a verified schedule basis supports, and the asks left for
              you to write. Owners and approvers see it; you decide what is said and approve it.
            </p>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {observing ? (busy ? "Starting…" : "Start from the template") : busy ? "Drafting…" : "Draft with Oracle"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
