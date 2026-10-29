"use client";

import { useState } from "react";

import { Button, Dialog } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

type Entry = Schemas["ChangelogEntryOut"];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * New entry (#344): a changelog entry written by hand, saved as a draft. A public entry needs
 * its release date; an internal one defaults to today. Edit, Publish and Withdraw follow on
 * the entry's row.
 */
export function NewEntryDialog({
  categories,
  categoryLabel,
  onClose,
  onCreated,
}: {
  categories: Entry["category"][];
  categoryLabel: Record<Entry["category"], string>;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [category, setCategory] = useState<Entry["category"]>("added");
  const [audience, setAudience] = useState<Entry["audience"]>("internal");
  const [firstDay] = useState(today);
  const [releasedOn, setReleasedOn] = useState(firstDay);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsDate = audience === "public" && !releasedOn;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/changelog", {
          body: { category, audience, title: title.trim(), body: body.trim(), released_on: releasedOn || null },
        }),
      );
      await onCreated();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const canSubmit = !!title.trim() && !needsDate;

  return (
    <Dialog
      title="New entry"
      testId="new-entry-dialog"
      dirty={!!title || !!body || category !== "added" || audience !== "internal" || releasedOn !== firstDay}
      onClose={onClose}
      onSubmit={() => {
        if (canSubmit && !busy) void create();
      }}
      actions={
        <Button type="submit" variant="primary" disabled={busy || !canSubmit}>
          {busy ? "Adding…" : "Add entry"}
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-3 max-[600px]:grid-cols-1">
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Category
          <select className={INPUT} value={category} onChange={(e) => setCategory(e.target.value as Entry["category"])}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Audience
          <select className={INPUT} value={audience} onChange={(e) => setAudience(e.target.value as Entry["audience"])}>
            <option value="internal">Internal</option>
            <option value="public">Public</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Released on
          <input type="date" className={INPUT} value={releasedOn} onChange={(e) => setReleasedOn(e.target.value)} />
        </label>
      </div>
      {needsDate && <p className="text-sm text-text2">A public entry needs its release date.</p>}
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        Title
        <input className={INPUT} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} data-autofocus="" />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        What changed
        <textarea className={`${INPUT} min-h-24`} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="text-sm text-text2">
        The entry starts as a draft. Internal entries are for everyone at the company; an approver publishes public ones.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Dialog>
  );
}
