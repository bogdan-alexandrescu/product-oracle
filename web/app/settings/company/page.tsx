"use client";

import { useState } from "react";

import { Button, confirmInPage, InfoTip, Notice, PageHeader, Panel, ViewOnly } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";
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

/** Common zones first; the browser's full list after. */
const ZONES = ["UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];

function zones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([current, ...ZONES, ...all])];
}

/**
 * The Company time zone (one setting, America/Los_Angeles by default): every date and time on screen, goals' today, the weekly report and rituals.
 * #370: only a role that can change it (owners) gets the form; others read the zone.
 */
function TimezonePanel({ canChange }: { canChange: boolean }) {
  const { refresh } = useMe();
  const settingQ = useQuery("settings|company_timezone", () =>
    unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: "company_timezone" } } })),
  );
  const stored = settingQ.data ? String(settingQ.data.value) : null;
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = edit ?? stored;

  async function save() {
    if (!zone) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out: Schemas["SettingOut"] = await unwrap(
        api.PUT("/v1/settings/{key}", { params: { path: { key: "company_timezone" } }, body: { value: zone } }),
      );
      settingQ.setData(() => out);
      setEdit(null);
      // Every screen reads the zone from GET /v1/me.
      void refresh();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="timezone" className="scroll-mt-4" data-testid="timezone-panel">
      <Panel
        title="Time zone"
        tools={
          <InfoTip label="time zone" side="bottom">
            Every date and time Oracle shows is in it, as are goals&apos; today, the weekly alignment report and rituals.
            Rituals on the old zone move with it.
          </InfoTip>
        }
      >
        {settingQ.error && (
          <div className="p-4">
            <Notice tone="error">{settingQ.error}</Notice>
          </div>
        )}
        {zone && !canChange && (
          <div className={ROW.replace("88px", "160px")} data-testid="timezone-value">
            <span className={ROW_LABEL}>Company time zone</span>
            <span className="text-[15px]">{zone}</span>
          </div>
        )}
        {zone && canChange && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className={ROW.replace("88px", "160px")}>
              <label htmlFor="company-timezone" className={ROW_LABEL}>
                Company time zone
              </label>
              <select
                id="company-timezone"
                className={`${SELECT_FIELD} max-w-72`}
                value={zone}
                onChange={(e) => {
                  setEdit(e.target.value);
                  setSaved(false);
                }}
              >
                {zones(zone).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
            {error && (
              <div className="px-4 pb-1 max-[600px]:px-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
              <Button type="submit" variant="solid" disabled={busy}>
                Save
              </Button>
              {saved && (
                <span role="status" className="text-sm font-semibold text-pass">
                  Saved
                </span>
              )}
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}

/**
 * H9 Pricing input: the pricing owner, the one person who decides prices (research [74]).
 * An active owner; unset, the earliest active owner. Owners only: others do not see it.
 */
function PricingOwnerPanel() {
  const settingQ = useQuery("settings|pricing_owner", () => unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: "pricing_owner" } } })));
  const membersQ = useQuery("members", () => unwrap(api.GET("/v1/members")));
  const owners = (membersQ.data ?? [])
    .filter((m) => m.role === "owner" && m.status === "active")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const stored = settingQ.data ? ((settingQ.data.value as string | null) ?? null) : undefined;
  // Unset reads as the earliest active owner, as the API does.
  const current = stored === undefined ? undefined : (owners.find((m) => m.id === stored) ?? owners[0])?.id;
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = edit ?? current ?? "";

  async function save() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out: Schemas["SettingOut"] = await unwrap(
        api.PUT("/v1/settings/{key}", { params: { path: { key: "pricing_owner" } }, body: { value: chosen } }),
      );
      settingQ.setData(() => out);
      setEdit(null);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const loadError = settingQ.error ?? membersQ.error;
  return (
    <div id="pricing-owner" className="scroll-mt-4" data-testid="pricing-owner-panel">
      <Panel
        title="Pricing owner"
        tools={
          <InfoTip label="pricing owner" side="bottom">
            The one person who decides prices. Oracle drafts pricing memos; the pricing owner decides from them in the decision log. The earliest
            owner until you choose another.
          </InfoTip>
        }
      >
        {loadError && (
          <div className="p-4">
            <Notice tone="error">{loadError}</Notice>
          </div>
        )}
        {current !== undefined && membersQ.data && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className={ROW.replace("88px", "160px")}>
              <label htmlFor="pricing-owner-select" className={ROW_LABEL}>
                Pricing owner
              </label>
              <select
                id="pricing-owner-select"
                className={`${SELECT_FIELD} max-w-72`}
                value={chosen}
                onChange={(e) => {
                  setEdit(e.target.value);
                  setSaved(false);
                }}
              >
                {owners.map((m) => (
                  <option key={m.id} value={m.id}>
                    {displayName(m.email, m.name)}
                  </option>
                ))}
              </select>
            </div>
            {error && (
              <div className="px-4 pb-1 max-[600px]:px-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
              <Button type="submit" variant="solid" disabled={busy || !chosen}>
                Save
              </Button>
              {saved && (
                <span role="status" className="text-sm font-semibold text-pass">
                  Saved
                </span>
              )}
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}

/** Settings > Company: the company-wide choices an owner makes: the planning horizons, the Company time zone and the pricing owner. */
export default function CompanySettingsPage() {
  // #370: Settings' gate answers a role that cannot read the company settings.
  const { can, capsReady } = useMe();
  // #401: the time zone is an owner's to change; a role that reads the page but changes nothing sees View only.
  const canChange = can("put_setting");
  return (
    <>
      <PageHeader title="Company" status={capsReady && can("get_setting_endpoint") && !canChange ? <ViewOnly /> : undefined} />
      {can("get_setting_endpoint") && (
        <div className="flex min-w-0 flex-col gap-4">
          <HorizonsPanel />
          <TimezonePanel canChange={canChange} />
          {/* H9: owners choose the pricing owner; others do not see the field. */}
          {canChange && can("list_members") && <PricingOwnerPanel />}
        </div>
      )}
    </>
  );
}
