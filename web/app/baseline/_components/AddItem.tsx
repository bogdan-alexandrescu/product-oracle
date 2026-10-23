"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

import { Button, GoalTag, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type EntityOut, type GraphOut } from "@/lib/api/client";
import { errorMessage, useAuthRedirect } from "@/lib/use-query";

import { sortedGoals } from "./common";
import { byTitle } from "./order";

/** The kinds a person adds from the Baseline screen, in the form's order. */
export const ADD_KINDS = [
  { value: "goal", label: "Goal" },
  { value: "feature", label: "Feature" },
  { value: "product", label: "Product" },
  { value: "risk", label: "Risk" },
  { value: "assumption", label: "Assumption" },
  { value: "requirement", label: "Requirement" },
  { value: "strategy_choice", label: "Strategy choice" },
] as const satisfies readonly { value: EntityOut["type"]; label: string }[];

export type AddKind = (typeof ADD_KINDS)[number]["value"];

/** Why a viewer or commenter sees the add buttons disabled. */
export const ADD_REASON = "Only approvers and owners add items to the baseline.";

const CONTRIBUTION = [
  { value: "", label: "No link" },
  { value: "1", label: "Weak (1)" },
  { value: "2", label: "Medium (2)" },
  { value: "3", label: "Strong (3)" },
];

/** A key the API accepts (lowercase, digits, . _ -), unique enough: the title's words and a short suffix. */
function newKey(title: string) {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const suffix = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
  return `${slug || "item"}-${suffix}`;
}

/**
 * Add item (#337): kind, title and description; for a feature, its product and how much
 * it serves each goal. A person's item is confirmed and locked at once; a goal starts
 * proposed and is confirmed from its drawer (B2).
 */
export function AddItemSheet({
  kind: initial,
  graph,
  tags,
  onClose,
  onAdded,
}: {
  kind: AddKind;
  graph: GraphOut | undefined;
  tags: Map<string, string>;
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const id = useId();
  const onAuth = useAuthRedirect();
  const [kind, setKind] = useState<AddKind>(initial);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [product, setProduct] = useState("");
  const [goals, setGoals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const live = (graph?.entities ?? []).filter((e) => e.status !== "rejected");
  const products = live.filter((e) => e.type === "product").sort(byTitle);
  const goalRows = sortedGoals(graph);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Give the item a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/baseline/entities", {
          body: { type: kind, key: newKey(title.trim()), title: title.trim(), body: body.trim() || null, attrs: {}, origin: "user" },
        }),
      );
      const name = `“${title.trim()}”`;
      if (!out.entity) {
        onAdded(`${name} was saved as a proposal for an approver.`);
        return;
      }
      if (kind === "feature") {
        const src_id = out.entity.id;
        if (product) await unwrap(api.POST("/v1/baseline/edges", { body: { src_id, dst_id: product, type: "part_of", attrs: {}, origin: "user" } }));
        for (const [goal, c] of Object.entries(goals)) {
          if (!c) continue;
          await unwrap(
            api.POST("/v1/baseline/edges", {
              body: { src_id, dst_id: goal, type: "supports", attrs: { contribution: Number(c) }, origin: "user" },
            }),
          );
        }
      }
      onAdded(
        kind === "goal"
          ? `Added ${name}. New goals start proposed: confirm it from its panel once it is agreed.`
          : `Added ${name}. It is confirmed and locked against agent changes.`,
      );
    } catch (err) {
      if (!onAuth(err)) setError(errorMessage(err));
      setBusy(false);
    }
  }

  const label = "flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:p-0">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={submit}
        className="flex w-full max-w-lg min-w-0 flex-col rounded-inspector border border-line bg-surface text-text shadow-tip max-[600px]:min-h-dvh max-[600px]:rounded-none max-[600px]:border-0"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 font-display text-xl font-bold tracking-heading">
            Add an item
          </h2>
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="flex-1 space-y-4 px-5 py-4 text-[15px] max-[600px]:px-4">
          <div className={label}>
            <label htmlFor={`${id}-kind`}>Kind</label>
            <select id={`${id}-kind`} className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as AddKind)}>
              {ADD_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <label className={label}>
            Title
            <input className={INPUT} value={title} data-autofocus autoFocus onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className={label}>
            Description
            <textarea className={INPUT} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {kind === "feature" && (
            <>
              <div className={label}>
                <label htmlFor={`${id}-product`}>Product</label>
                <select id={`${id}-product`} className={INPUT} value={product} onChange={(e) => setProduct(e.target.value)}>
                  <option value="">Unassigned</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </div>
              {goalRows.length > 0 && (
                <fieldset className="flex min-w-0 flex-col gap-2">
                  <legend className="mb-1 text-[13px] font-semibold tracking-[0.02em] text-text2">Goals it serves</legend>
                  {goalRows.map((g) => (
                    <div key={g.id} className="flex min-w-0 flex-wrap items-center gap-2">
                      <GoalTag id={tags.get(g.id) ?? "G"} proposed={g.status === "proposed"} />
                      <label htmlFor={`${id}-goal-${g.id}`} className="min-w-0 flex-[1_1_10rem] truncate" title={g.title}>
                        {g.title}
                      </label>
                      <select
                        id={`${id}-goal-${g.id}`}
                        className={`${INPUT} w-auto flex-none`}
                        value={goals[g.id] ?? ""}
                        onChange={(e) => setGoals((m) => ({ ...m, [g.id]: e.target.value }))}
                      >
                        {CONTRIBUTION.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </fieldset>
              )}
            </>
          )}
          <p className="text-sm text-text2">
            {kind === "goal"
              ? "A new goal starts proposed; an approver confirms it."
              : "Your item is confirmed and locked: agents can then only propose changes to it."}
          </p>
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:sticky max-[600px]:bottom-0 max-[600px]:bg-surface max-[600px]:px-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Add
          </Button>
        </div>
      </form>
    </div>
  );
}
