"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { Button, confirmInPage, InfoTip, Notice, PageHeader, Panel, ViewOnly } from "@/components/ds";
import { BRANDING_OPS } from "@/lib/api/branding";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { zoneName } from "@/lib/format";
import { displayName } from "@/lib/names";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { ZONE_NOT_SET } from "@/lib/zone";

import { INPUT, SELECT_FIELD } from "../_components/fields";
import { setupHome } from "../_nav";
import { BrandingPanel } from "./BrandingPanel";

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

/** qa-settings-6: Later's months checked before saving, in the API's words (oracle.tenant_settings_api). */
function laterError(f: Form): string | null {
  const from = Number(f.from);
  const to = Number(f.to);
  const nextEnds = 3 * (Number(f.short) + Number(f.medium));
  if (!Number.isInteger(from) || !f.from.trim() || from < nextEnds || from > 36)
    return `'From' must start after Next ends (at least ${nextEnds} months) and be at most 36 months.`;
  if (!Number.isInteger(to) || !f.to.trim() || to <= from || to > 60) return "'To' must be after 'From' and at most 60 months.";
  return null;
}

/** The Home whose Set up checklist opened the page (?from=setup), or null. */
function useSetupHome(): string | null {
  return useSyncExternalStore(
    () => () => {},
    () => setupHome(new URLSearchParams(window.location.search)),
    () => null,
  );
}

/**
 * A section's "Saved"; opened from Set up, with the way back to the Home it came from
 * (qa-onboarding-16, -33: every Set up section says it, Simple's setup card back to Simple).
 */
function SavedNote({ testId }: { testId?: string }) {
  const home = useSetupHome();
  return (
    <span role="status" className="text-sm font-semibold text-pass" data-testid={testId}>
      Saved
      {home && (
        <>
          {" · "}
          <Link href={home} className="text-accent-ink hover:underline">
            Back to Home
          </Link>
        </>
      )}
    </span>
  );
}

/** qa-settings-13: why Save waits, beside it, while nothing has changed. */
function SaveHint({ testId, children }: { testId: string; children: string }) {
  return (
    <span data-testid={testId} className="text-sm text-text2">
      {children}
    </span>
  );
}

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
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = edit ?? stored;
  const changed = !!form && !!stored && !sameForm(form, stored);

  async function put(value: Horizons | null) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out: Schemas["SettingOut"] = await unwrap(
        api.PUT("/v1/settings/{key}", { params: { path: { key: "planning_horizons" } }, body: { value } }),
      );
      settingQ.setData(() => out);
      setEdit(null);
      setSaved(value !== null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!(await confirmInPage({ action: "Reset to defaults", message: "Go back to the default horizons?" }))) return;
    await put(null);
  }

  const set = (patch: Partial<Form>) => {
    if (!form) return;
    setEdit({ ...form, ...patch });
    setFieldError(null);
    // qa-settings-14: an earlier save's problem goes once the horizons change again.
    setError(null);
    setSaved(false);
  };
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
              const wrong = laterError(form);
              setFieldError(wrong);
              if (!wrong) void put(valueOf(form));
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
                  aria-invalid={fieldError?.startsWith("'From'") || undefined}
                  aria-describedby={fieldError ? "horizon-later-error" : undefined}
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
                  aria-invalid={fieldError?.startsWith("'To'") || undefined}
                  aria-describedby={fieldError ? "horizon-later-error" : undefined}
                  className={MONTHS}
                  value={form.to}
                  onChange={(e) => set({ to: e.target.value })}
                />
                <span className="text-text2">months</span>
                {fieldError && (
                  <p id="horizon-later-error" role="alert" className="w-full text-[13px] font-semibold text-crit">
                    {fieldError}
                  </p>
                )}
              </div>
            </div>
            {error && (
              <div className="px-4 pb-1 max-[600px]:px-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
              {/* qa-settings-18: Save, as every other panel; with the defaults unchanged it confirms them
                  (Set up's Check the planning horizons). qa-settings-13: otherwise only after a change. */}
              <Button type="submit" variant="solid" disabled={busy || !(changed || setting.is_default)}>
                Save
              </Button>
              {!saved && !changed && (
                <SaveHint testId="horizons-save-reason">
                  {setting.is_default ? "Save keeps the default horizons." : "Change a horizon to save it."}
                </SaveHint>
              )}
              {saved && <SavedNote testId="horizons-saved" />}
              {!setting.is_default && (
                <Button variant="ghost" disabled={busy} onClick={() => void reset()} className="ml-auto">
                  Reset to defaults
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
const ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

type ZoneOption = { zone: string; label: string; minutes: number };

/** A zone's offset from UTC now, in minutes and as "UTC+5:30" ("UTC" for none). */
function zoneOffset(zone: string): { minutes: number; text: string } {
  let raw = "";
  try {
    // The zone's offset, not a date: nothing here is shown in another zone.
    // eslint-disable-next-line no-restricted-syntax
    raw = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return { minutes: 0, text: "UTC" };
  }
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!m) return { minutes: 0, text: "UTC" };
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  return { minutes, text: `UTC${m[1]}${m[2]}${m[3] ? `:${m[3]}` : ""}` };
}

/** qa-settings-19: a zone in Home's words (lib/format zoneName) with its offset. */
function zoneOption(zone: string): ZoneOption {
  const { minutes, text } = zoneOffset(zone);
  const name = zoneName(zone);
  return { zone, minutes, label: zone === "UTC" ? name : `${name} · ${text}` };
}

/** The common zones, then every other zone by offset and name. */
function zoneOptions(): { common: ZoneOption[]; rest: ZoneOption[] } {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const common = ZONES.map(zoneOption);
  const rest = all
    .filter((z) => !ZONES.includes(z))
    .map(zoneOption)
    .sort((a, b) => a.minutes - b.minutes || a.label.localeCompare(b.label));
  return { common, rest };
}

const matches = (o: ZoneOption, q: string) => !q || o.label.toLowerCase().includes(q) || o.zone.toLowerCase().replace(/_/g, " ").includes(q);

/**
 * qa-settings-12: the Company time zone in one searchable picker (a combobox): typing narrows
 * the list right under the field, Common first; a pick fills it. Unset, it reads "Not set ·
 * Pacific is used". Arrows move through the list, Enter picks (the first match when none is
 * marked), Escape closes it and keeps the zone.
 */
function ZonePicker({
  id,
  zone,
  options,
  onPick,
}: {
  id: string;
  zone: string;
  options: { common: ZoneOption[]; rest: ZoneOption[] };
  onPick: (zone: string) => void;
}) {
  // What is typed while the list is open; null: closed, the field shows the zone.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const open = query !== null;
  const chosen = zone ? (options.common.find((o) => o.zone === zone) ?? options.rest.find((o) => o.zone === zone) ?? zoneOption(zone)) : null;
  // Opening keeps the saved zone in the field, selected so typing replaces it; until then
  // the whole list shows.
  const q = query === null || query === chosen?.label ? "" : query.trim().toLowerCase();
  const common = options.common.filter((o) => matches(o, q));
  const rest = options.rest.filter((o) => matches(o, q));
  const list = [...common, ...rest];
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-option-${i}`;

  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // optionId reads only `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const close = () => {
    setQuery(null);
    setActive(-1);
  };
  const pick = (o: ZoneOption) => {
    onPick(o.zone);
    close();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setQuery(chosen?.label ?? "");
      if (list.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a < 0 ? (step > 0 ? 0 : list.length - 1) : (a + step + list.length) % list.length));
    } else if (e.key === "Enter" && open) {
      // Picks, never submits the form with a half-typed zone.
      e.preventDefault();
      const o = list[active >= 0 ? active : 0];
      if (o && (active >= 0 || q)) pick(o);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const item = (o: ZoneOption, i: number) => (
    <div
      key={o.zone}
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      data-zone={o.zone}
      className={`flex min-h-9 cursor-pointer items-center px-3 py-1.5 text-[15px] ${i === active ? "bg-surface2" : "hover:bg-surface2"} ${
        o.zone === zone ? "font-semibold text-accent-ink" : "text-text"
      }`}
      onClick={() => pick(o)}
    >
      {o.label}
    </div>
  );
  const heading = "px-3 pt-2 pb-1 text-[13px] font-semibold text-text2";

  return (
    <div className="relative min-w-0 max-w-96">
      <input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        data-zone={zone}
        className={INPUT}
        placeholder={open ? "Type a city or zone" : ZONE_NOT_SET}
        title={chosen?.label}
        value={open ? (query ?? "") : (chosen?.label ?? "")}
        onFocus={(e) => {
          const input = e.currentTarget;
          setQuery(chosen?.label ?? "");
          requestAnimationFrame(() => input.select());
        }}
        onClick={() => !open && setQuery(chosen?.label ?? "")}
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Time zones"
          // Keep focus in the field, so a click picks before blur closes the list.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-inspector border border-line bg-surface py-1 shadow-tip"
        >
          {common.length > 0 && (
            <div role="group" aria-label="Common">
              <div role="presentation" className={heading}>
                Common
              </div>
              {common.map((o, i) => item(o, i))}
            </div>
          )}
          {rest.length > 0 && (
            <div role="group" aria-label="All time zones">
              <div role="presentation" className={heading}>
                All time zones
              </div>
              {rest.map((o, i) => item(o, common.length + i))}
            </div>
          )}
          {list.length === 0 && <p className="px-3 py-1.5 text-[15px] text-text2">No time zone matches.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The Company time zone (one setting; unset, America/Los_Angeles is used): every date and time on screen, goals' today, the weekly report and rituals.
 * #370: only a role that can change it (owners) gets the form; others read the zone.
 */
function TimezonePanel({ canChange }: { canChange: boolean }) {
  const { refresh } = useMe();
  const settingQ = useQuery("settings|company_timezone", () =>
    unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: "company_timezone" } } })),
  );
  // qa-settings-8: unset reads "Not set · Pacific is used", as Home and Notifications say.
  const isDefault = !!settingQ.data?.is_default;
  const stored = settingQ.data ? (isDefault ? "" : String(settingQ.data.value)) : null;
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = edit ?? stored;
  const options = useMemo(() => zoneOptions(), []);
  // qa-settings-13: Save once another zone is picked.
  const changed = !!zone && zone !== stored;

  async function save() {
    // With none chosen there is nothing to save: the zone stays unset (Pacific is used meanwhile).
    if (!zone || !changed) return;
    const value = zone;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out: Schemas["SettingOut"] = await unwrap(
        api.PUT("/v1/settings/{key}", { params: { path: { key: "company_timezone" } }, body: { value } }),
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
        {zone !== null && !canChange && (
          <div className={ROW.replace("88px", "160px")} data-testid="timezone-value">
            <span className={ROW_LABEL}>Company time zone</span>
            <span className="text-[15px]">{zone ? zoneName(zone) : ZONE_NOT_SET}</span>
          </div>
        )}
        {zone !== null && canChange && (
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
              <ZonePicker
                id="company-timezone"
                zone={zone}
                options={options}
                onPick={(z) => {
                  setEdit(z);
                  setError(null);
                  setSaved(false);
                }}
              />
            </div>
            {error && (
              <div className="px-4 pb-1 max-[600px]:px-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
              <Button type="submit" variant="solid" disabled={busy || !changed}>
                Save
              </Button>
              {!saved && !changed && (
                <SaveHint testId="timezone-save-reason">{zone ? "Pick another time zone to save it." : "Pick a time zone to save it."}</SaveHint>
              )}
              {saved && <SavedNote testId="timezone-saved" />}
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
  // qa-settings-13: Save once another owner is picked.
  const changed = !!chosen && chosen !== current;

  async function save() {
    if (!changed) return;
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
  // Why Save waits: one owner has no one to pick; with none chosen yet, the earliest decides.
  const earliest = owners[0] ? displayName(owners[0].email, owners[0].name) : "";
  const pricingHint =
    owners.length === 1
      ? `${earliest} is the only owner: make another member an owner to choose someone else.`
      : stored === null
        ? `Not chosen yet: the earliest owner, ${earliest}, decides until you pick someone else.`
        : "Pick another owner to save it.";
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
              {/* qa-settings-21: the panel says Pricing owner; the field says what the owner does. */}
              <label htmlFor="pricing-owner-select" className={ROW_LABEL}>
                Decides prices
              </label>
              <select
                id="pricing-owner-select"
                className={`${SELECT_FIELD} max-w-72`}
                value={chosen}
                onChange={(e) => {
                  setEdit(e.target.value);
                  setError(null);
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
              <Button type="submit" variant="solid" disabled={busy || !changed}>
                Save
              </Button>
              {!saved && !changed && <SaveHint testId="pricing-owner-save-reason">{pricingHint}</SaveHint>}
              {saved && <SavedNote />}
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}

/**
 * Settings > Company: the company-wide choices an owner makes: the planning horizons, the Company
 * time zone, the pricing owner and the branding (O5 lane 4). Every member reads the branding.
 */
export default function CompanySettingsPage() {
  // #370: Settings' gate answers a role that cannot read the company settings or the branding.
  const { can, capsReady } = useMe();
  // #401: the time zone is an owner's to change; a role that reads the page but changes nothing sees View only.
  const canChange = can("put_setting");
  const readsSettings = can("get_setting_endpoint");
  const readsBranding = can(BRANDING_OPS.get);
  return (
    <>
      <PageHeader title="Company" status={capsReady && (readsSettings || readsBranding) && !canChange ? <ViewOnly /> : undefined} />
      <div className="flex min-w-0 flex-col gap-4">
        {/* qa-onboarding-25: a role that cannot change them (a Set up link, a shared link) reads why. */}
        {capsReady && !canChange && <Notice testId="company-owner-only">Only owners set horizons and the time zone.</Notice>}
        {readsSettings && (
          <>
            <HorizonsPanel />
            <TimezonePanel canChange={canChange} />
            {/* H9: owners choose the pricing owner; others do not see the field. */}
            {canChange && can("list_members") && <PricingOwnerPanel />}
          </>
        )}
        {readsBranding && <BrandingPanel />}
      </div>
    </>
  );
}
