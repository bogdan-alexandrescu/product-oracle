"use client";

import { useState } from "react";

import { Button } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { Modal } from "./Modal";

/**
 * qa-company-40: the file's columns in plain words, each with an example and whether it is
 * needed. The import reads these headers as they are (any case; a space for an underscore),
 * and results and reasons as their labels.
 */
const SAMPLE: { column: string; example: string; needed: boolean }[] = [
  { column: "Result", example: "Lost", needed: true },
  { column: "Account", example: "Acme Ltd", needed: true },
  { column: "Segment", example: "Mid-market", needed: false },
  { column: "Plan", example: "Team", needed: false },
  { column: "Annual value", example: "12000", needed: false },
  { column: "Currency", example: "USD", needed: false },
  { column: "Decided on", example: "2026-09-14", needed: true },
  { column: "Reason", example: "Price", needed: true },
  { column: "Reason note", example: "Wanted a smaller plan", needed: false },
  { column: "Alternative", example: "Spreadsheets", needed: false },
  { column: "Price quoted", example: "20 per seat", needed: false },
];

/** A sample file built in the browser: the header row and one example row. */
const SAMPLE_CSV = `${SAMPLE.map((c) => c.column).join(",")}\n${SAMPLE.map((c) => c.example).join(",")}\n`;
const SAMPLE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`;

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
          A CSV file whose first row names these columns, one deal per row after it. Result, Account, Decided on and Reason are needed; the
          others may be left empty. Dates are written year-month-day. At most 2,000 rows and 1 MB.
        </p>
        <table data-testid="import-sample" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-text2">
              <th className="py-1 pr-3 font-semibold">Column</th>
              <th className="py-1 pr-3 font-semibold">Example</th>
              <th className="py-1 font-semibold">Needed</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE.map((c) => (
              <tr key={c.column} className="border-b border-line last:border-b-0">
                <td className="py-1 pr-3 font-medium">{c.column}</td>
                <td className="py-1 pr-3 tnum">{c.example}</td>
                <td className="py-1 text-text2">{c.needed ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <a href={SAMPLE_HREF} download="win-and-loss-sample.csv" data-testid="import-sample-download" className="self-start text-sm font-medium text-accent-ink hover:underline">
          Download a sample CSV
        </a>
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
