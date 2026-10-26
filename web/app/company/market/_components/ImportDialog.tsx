"use client";

import { useState } from "react";

import { Button } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { Modal } from "./Modal";

const COLUMNS = "result, account, segment, plan, annual_value, currency, decided_on, reason, reason_note, alternative, price_quoted";

/** POST /v1/deal-outcomes/import with the file as text/csv. */
function importCsv(text: string, dryRun: boolean): Promise<Schemas["ImportOut"]> {
  return unwrap(
    api.POST("/v1/deal-outcomes/import", {
      params: { query: { dry_run: dryRun } },
      body: text,
      bodySerializer: (b) => b,
      headers: { "Content-Type": "text/csv" },
    }),
  );
}

const rows = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

/**
 * Import CSV (H9): a dry run first shows the rows to create and the rows refused with their
 * line numbers (the header is line 1); Import then creates the good rows. At most 2,000 rows
 * and 1 MB.
 */
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [check, setCheck] = useState<Schemas["ImportOut"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    setCheck(null);
    setError(null);
    if (!file) return;
    if (file.size > 1024 * 1024) return setError("The file is larger than 1 MB");
    const content = await file.text();
    setText(content);
    setName(file.name);
    setBusy(true);
    try {
      setCheck(await importCsv(content, true));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (text == null) return;
    setBusy(true);
    setError(null);
    try {
      await importCsv(text, false);
      onImported();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal id="import-deals-title" title="Import win and loss" testId="import-deals" onClose={onClose}>
      <div className="flex flex-col gap-4 px-5 py-4 max-[600px]:px-4">
        <p className="text-sm text-text2">
          A CSV file with a header row naming the columns {COLUMNS}. Result, account, decided_on (YYYY-MM-DD) and reason are needed. At most 2,000 rows and 1 MB.
        </p>
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          CSV file
          <input type="file" accept=".csv,text/csv" data-autofocus="" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {busy && !check && <p className="text-sm text-text2">Checking {name}…</p>}
        {check && (
          <div className="flex flex-col gap-2" data-testid="import-check">
            <p className="text-[15px] font-semibold" data-testid="import-create">
              {rows(check.created)} to create
            </p>
            {check.unmatched_alternatives.length > 0 && (
              <p className="text-sm text-text2" data-testid="import-unmatched">
                Not one of your alternatives, kept as text in the note: {check.unmatched_alternatives.join(", ")}
              </p>
            )}
            {check.skipped.length > 0 && (
              <div>
                <p className="text-[15px] font-semibold" data-testid="import-refused-count">
                  {rows(check.skipped.length)} refused
                </p>
                <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="import-refused">
                  {check.skipped.map((s) => (
                    <li key={s.line} data-testid="import-refused-row">
                      <span className="font-semibold">Line {s.line}:</span> {s.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !check || check.created === 0} onClick={() => void run()}>
            {check ? `Import ${rows(check.created)}` : "Import"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
