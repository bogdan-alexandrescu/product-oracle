"use client";

import { useState } from "react";

import { Button, confirmInPage, InfoTip, Notice, PageHeader, Panel } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { INPUT, SELECT_FIELD } from "../_components/fields";

/** The planning_horizons setting (oracle.tenant_settings_api): B2 Goals framework. */
type Horizons = { short_quarters: number; medium_quarters: number; long_from_months: number; long_to_months: number };
/** What the form holds: the number inputs as typed. */
type Form = { short: string; medium: string; from: string; to: string };

const NOW = [
  { value: "1", label: "Current quarter" },
  { value: "2", label: "Current and next quarter" },
];
const NEXT = [
  { value: "1", label: "Next quarter" },
  { value: "2", label: "Next 2 quarters" },
  { value: "3", label: "Next 3 quarters" },
  { value: "4", label: "Next 4 quarters" },
];
const ROW = "grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 max-[600px]:grid-cols-1 max-[600px]:gap-1.5 max-[600px]:px-3";
const ROW_LABEL = "text-[15px] font-semibold";
/** A months field: INPUT at a fixed width. */
const MONTHS = INPUT.replace("w-full", "w-20");

function formOf(h: Horizons): Form {
  return { short: String(h.short_quarters), medium: String(h.medium_quarters), from: String(h.long_from_months), to: String(h.long_to_months) };
}

function valueOf(f: Form): Horizons {
  return { short_quarters: Number(f.short), medium_quarters: Number(f.medium), long_from_months: Number(f.from), long_to_months: Number(f.to) };
}

const sameForm = (a: Form, b: Form) => a.short === b.short && a.medium === b.medium && a.from === b.from && a.to === b.to;

/** Horizons (A1): what Now, Next and Later mean on this company's roadmaps. Owners only. */
function HorizonsPanel() {
  const settingQ = useQuery("settings|planning_horizons", () =>
    unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: "planning_horizons" } } })),
  );
  const setting = settingQ.data;
  const stored = setting ? formOf(setting.value as Horizons) : null;
  // Edits over the stored value; null: showing it unchanged.
  const [edit, setEdit] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = edit ?? stored;
  const changed = !!form && !!stored && !sameForm(form, stored);

  async function put(value: Horizons | null) {
    setBusy(true);
    setError(null);
    try {
      const out: Schemas["SettingOut"] = await unwrap(
        api.PUT("/v1/settings/{key}", { params: { path: { key: "planning_horizons" } }, body: { value } }),
      );
      settingQ.setData(() => out);
      setEdit(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!(await confirmInPage({ action: "Reset", message: "Go back to the default horizons?" }))) return;
    await put(null);
  }

  const set = (patch: Partial<Form>) => form && setEdit({ ...form, ...patch });
  return (
    <div id="horizons" className="scroll-mt-4">
      <Panel
        title="Horizons"
        tools={
          <InfoTip label="horizons" side="bottom">
            Roadmaps use these for Now, Next and Later. Runs already under way keep what they started with.
          </InfoTip>
        }
      >
        {settingQ.error && (
          <div className="p-4">
            <Notice tone="error">{settingQ.error}</Notice>
          </div>
        )}
        {form && setting && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void put(valueOf(form));
            }}
          >
            <div className={ROW}>
              <label htmlFor="horizon-now" className={ROW_LABEL}>
                Now
              </label>
              <select id="horizon-now" className={`${SELECT_FIELD} max-w-72`} value={form.short} onChange={(e) => set({ short: e.target.value })}>
                {NOW.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={`${ROW} border-t border-line`}>
              <label htmlFor="horizon-next" className={ROW_LABEL}>
                Next
              </label>
              <select id="horizon-next" className={`${SELECT_FIELD} max-w-72`} value={form.medium} onChange={(e) => set({ medium: e.target.value })}>
                {NEXT.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={`${ROW} border-t border-line`}>
              <span className={ROW_LABEL}>Later</span>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-[15px]">
                <label htmlFor="horizon-from" className="text-[13px] font-semibold text-text2">
                  From
                </label>
                <input
                  id="horizon-from"
                  type="number"
                  inputMode="numeric"
                  min={3}
                  max={36}
                  className={MONTHS}
                  value={form.from}
                  onChange={(e) => set({ from: e.target.value })}
                />
                <label htmlFor="horizon-to" className="text-[13px] font-semibold text-text2">
                  To
                </label>
                <input
                  id="horizon-to"
                  type="number"
                  inputMode="numeric"
                  min={4}
                  max={60}
                  className={MONTHS}
                  value={form.to}
                  onChange={(e) => set({ to: e.target.value })}
                />
                <span className="text-text2">months</span>
              </div>
            </div>
            {error && (
              <div className="px-4 pb-1 max-[600px]:px-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
              {changed ? (
                <Button type="submit" variant="solid" disabled={busy}>
                  Save
                </Button>
              ) : (
                setting.is_default && (
                  <Button type="submit" variant="solid" disabled={busy} icon="check">
                    Confirm
                  </Button>
                )
              )}
              {!setting.is_default && (
                <Button variant="ghost" disabled={busy} onClick={() => void reset()} className="ml-auto">
                  Reset
                </Button>
              )}
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}

/** Settings > Company: the company-wide choices an owner makes; first, the planning horizons. */
export default function CompanySettingsPage() {
  // #370: Settings' gate answers a role that cannot read the company settings.
  const { can } = useMe();
  return (
    <>
      <PageHeader title="Company" />
      {can("get_setting_endpoint") && (
        <div className="flex min-w-0 flex-col gap-4">
          <HorizonsPanel />
        </div>
      )}
    </>
  );
}
