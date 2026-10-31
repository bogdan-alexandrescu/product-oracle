"use client";

import { useEffect, useState } from "react";

import { Button, InfoTip, Notice, Panel } from "@/components/ds";
import {
  BRANDING_LIMITS,
  contrastOnWhite,
  deleteBrandLogo,
  getBranding,
  LOGO_TYPES,
  logoDataUrl,
  normalHex,
  passesAA,
  putBranding,
  uploadBrandLogo,
  type BrandingOut,
  type BrandLogo,
  type LogoVariant,
} from "@/lib/api/branding";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, INPUT, TEXTAREA } from "../_components/fields";

/** What the form holds: the fields as typed. */
type Form = { name: string; accent: string; disclaimer: string; mark: boolean };

const formOf = (b: BrandingOut): Form => ({ name: b.display_name, accent: b.accent ?? "", disclaimer: b.public_disclaimer, mark: b.oracle_mark });
const MARK_LABEL = "Show 'Made with Product Oracle' on shared pages";

/** The logos as data: URLs (the CSP allows no blob: images), by sha256. */
function useLogoUrls(logos: (BrandLogo | null | undefined)[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const missing = logos.filter((l): l is BrandLogo => !!l && !urls[l.sha256]);
  const key = missing.map((l) => l.sha256).join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    for (const logo of missing) {
      logoDataUrl(logo)
        .then((url) => alive && setUrls((u) => ({ ...u, [logo.sha256]: url })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // `key` names the missing logos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (logo: BrandLogo | null | undefined) => (logo ? urls[logo.sha256] : undefined);
}

/** Whether the API would refuse the accent: not a hex colour, or too light on white. */
const accentRefused = (accent: string) => {
  const hex = normalHex(accent);
  return !!accent.trim() && (!hex || !passesAA(contrastOnWhite(hex)));
};

/**
 * The contrast of the accent on white, as the API checks it (WCAG AA, 4.5:1). qa-settings-14:
 * the one place a refused accent is said; after a Save it is the field's alert.
 */
function ContrastResult({ accent, alert }: { accent: string; alert: boolean }) {
  const hex = normalHex(accent);
  const role = alert ? "alert" : undefined;
  if (!accent.trim()) return <span className="text-[13px] text-text2">No accent: Oracle&apos;s own</span>;
  if (!hex)
    return (
      <span role={role} className={`text-[13px] ${alert ? "font-semibold text-crit" : "text-text2"}`}>
        Not a hex colour like #0369a1
      </span>
    );
  const ratio = contrastOnWhite(hex);
  const ok = passesAA(ratio);
  return (
    <span role={ok ? undefined : role} className={`text-[13px] font-semibold ${ok ? "text-pass" : "text-crit"}`}>
      {ratio.toFixed(2)}:1 · {ok ? "Passes AA" : alert ? "Too light to read on white. Pick a darker one." : "Too light"}
    </span>
  );
}

/*
 * qa-settings-5: the preview's colours are fixed, whatever the app's theme: the dark theme maps
 * `white` and `black` (and the tokens) onto its own surface and text, so they are inline here.
 */
const PREVIEW_LIGHT = { background: "#ffffff", color: "#111827", border: "1px solid #d1d9e2" };
// qa-settings-16: each framed by an edge that shows on the app's light and dark backgrounds.
const PREVIEW_DARK = { background: "#111827", color: "#ffffff", border: "1px solid #6b7280" };

/** The live preview: the logo and name on a light header and on a dark slide. */
function Preview({ name, accent, light, dark }: { name: string; accent: string | null; light?: string; dark?: string }) {
  const edge = accent ? { borderBottom: `3px solid ${accent}` } : {};
  return (
    <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
      <div data-testid="brand-preview-light" className="flex h-16 items-center gap-3 rounded-lg px-4" style={{ ...PREVIEW_LIGHT, ...edge }}>
        {/* A data: URL: next/image would fetch it again through its optimiser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {light && <img src={light} alt={name} className="h-10 w-auto max-w-[200px] object-contain" />}
        <span className="truncate text-[15px] font-semibold" style={{ color: PREVIEW_LIGHT.color }}>
          {name}
        </span>
      </div>
      <div data-testid="brand-preview-dark" className="flex h-16 items-center gap-3 rounded-lg px-4" style={{ ...PREVIEW_DARK, ...edge }}>
        {/* A data: URL: next/image would fetch it again through its optimiser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {dark && <img src={dark} alt={name} className="h-10 w-auto max-w-[200px] object-contain" />}
        <span className="truncate text-[15px] font-semibold" style={{ color: PREVIEW_DARK.color }}>
          {name}
        </span>
      </div>
    </div>
  );
}

const UPLOAD =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold text-text hover:bg-surface2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:border-line has-[:disabled]:text-text2";

/**
 * qa-settings-20: a logo's upload as a button (the file input kept, out of sight, with the
 * field's name), and what is there now: the file just uploaded, the stored logo's size, or none.
 */
function LogoUpload({
  label,
  action,
  busy,
  logo,
  fileName,
  onFile,
}: {
  label: string;
  action: string;
  busy: boolean;
  logo: BrandLogo | null | undefined;
  fileName?: string;
  onFile: (file: File | undefined) => void;
}) {
  const now = fileName ?? (logo ? `${logo.width} × ${logo.height} px` : "None yet");
  return (
    <div className="flex min-w-56 flex-col gap-1.5">
      <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <label className={UPLOAD}>
          <input
            type="file"
            aria-label={label}
            accept={LOGO_TYPES}
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {logo ? `Replace ${action}` : `Upload ${action}`}
        </label>
        <span className="min-w-0 truncate text-[13px] text-text2" title={now}>
          {now}
        </span>
      </span>
    </div>
  );
}

/**
 * Which logo exports and decks use (owner decision, 2026-10-26): the dark one on a dark theme
 * background, the logo otherwise; with no dark logo, the logo everywhere. Lists the API's choice
 * for each built-in theme.
 */
function ThemeLogos({ brand }: { brand: BrandingOut }) {
  if (!brand.logo && !brand.logo_dark) return null;
  if (!brand.logo_dark) {
    return (
      <p data-testid="brand-theme-note" className="text-[13px] text-text2">
        With no dark logo, every export and deck uses the logo.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p data-testid="brand-theme-note" className="text-[13px] text-text2">
        Exports and decks use the dark logo on a dark background and the logo on a light one.
      </p>
      <ul data-testid="brand-theme-logos" className="flex flex-col gap-0.5 text-[13px] text-text2">
        {brand.theme_logos.map((t) => (
          <li key={t.key}>
            <span className="font-semibold text-text">{t.name}</span>
            {`: ${t.variant === "dark" ? "dark" : "light"} background, uses the ${t.variant === "dark" ? "dark logo" : "logo"}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * O5 lane 4: Settings › Company › Branding. The company's display name, logo (and an optional
 * dark one), accent, public disclaimer and the "Made with Product Oracle" mark; every export and
 * shared page uses them. Owners edit (`can_edit`); everyone else reads.
 */
export function BrandingPanel() {
  const brandQ = useQuery("branding", getBranding);
  const brand = brandQ.data;
  const [edit, setEdit] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Save tried with an accent the API refuses: said next to the field, not sent (qa-settings-14).
  const [accentTried, setAccentTried] = useState(false);
  const form = edit ?? (brand ? formOf(brand) : null);
  const urlOf = useLogoUrls([brand?.logo, brand?.logo_dark]);

  const set = (patch: Partial<Form>) => {
    if (!form) return;
    setEdit({ ...form, ...patch });
    setSaved(false);
    setError(null);
    if ("accent" in patch) setAccentTried(false);
  };

  async function run(action: () => Promise<BrandingOut>, after?: () => void) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out = await action();
      brandQ.setData(() => out);
      after?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const [fileNames, setFileNames] = useState<Partial<Record<LogoVariant, string>>>({});
  const upload = (file: File | undefined, variant: LogoVariant) => {
    if (file) void run(() => uploadBrandLogo(file, variant), () => setFileNames((n) => ({ ...n, [variant]: file.name })));
  };
  const remove = (variant: LogoVariant) =>
    void run(
      () => deleteBrandLogo(variant),
      () => setFileNames((n) => ({ ...n, [variant]: undefined })),
    );

  const save = () => {
    if (!form) return;
    if (accentRefused(form.accent)) {
      setSaved(false);
      setError(null);
      setAccentTried(true);
      return;
    }
    return run(
      () => putBranding({ display_name: form.name, accent: form.accent.trim() || null, public_disclaimer: form.disclaimer, oracle_mark: form.mark }),
      () => {
        setEdit(null);
        setSaved(true);
      },
    );
  };
  const accentAlert = accentTried && !!form && accentRefused(form.accent);

  const light = urlOf(brand?.logo);
  const dark = urlOf(brand?.logo_dark) ?? light;
  const previewAccent = form ? normalHex(form.accent) : null;
  return (
    <div id="branding" className="scroll-mt-4" data-testid="branding-panel">
      <Panel
        title="Branding"
        tools={
          <InfoTip label="branding" side="bottom">
            Every export and shared page carries the company&apos;s name and logo, in its accent colour.
          </InfoTip>
        }
      >
        {brandQ.error && (
          <div className="p-4">
            <Notice tone="error">{brandQ.error}</Notice>
          </div>
        )}
        {brand && form && (
          <div className="flex flex-col gap-4 p-4 max-[600px]:p-3">
            <Preview name={form.name.trim() || brand.display_name} accent={previewAccent} light={light} dark={dark} />
            {brand.logo && (
              <p className="text-[13px] text-text2">
                Logo <span data-testid="brand-logo-size">{`${brand.logo.width} × ${brand.logo.height} px`}</span>
              </p>
            )}
            <ThemeLogos brand={brand} />
            {brand.can_edit ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <div className="flex flex-wrap items-end gap-3">
                  <LogoUpload
                    label="Logo"
                    action="logo"
                    busy={busy}
                    logo={brand.logo}
                    fileName={brand.logo ? fileNames.light : undefined}
                    onFile={(f) => upload(f, "light")}
                  />
                  <LogoUpload
                    label="Dark logo"
                    action="dark logo"
                    busy={busy}
                    logo={brand.logo_dark}
                    fileName={brand.logo_dark ? fileNames.dark : undefined}
                    onFile={(f) => upload(f, "dark")}
                  />
                  {brand.logo && (
                    <Button variant="ghost" disabled={busy} onClick={() => remove("light")}>
                      Remove logo
                    </Button>
                  )}
                  {brand.logo_dark && (
                    <Button variant="ghost" disabled={busy} onClick={() => remove("dark")}>
                      Remove dark logo
                    </Button>
                  )}
                </div>
                <p className="text-[13px] text-text2">PNG, JPEG or WebP, at most 512 KB and 2,000 × 2,000 px. Shown at most 40 px high.</p>
                <Field label="Display name">
                  <input
                    className={`${INPUT} max-w-96`}
                    maxLength={BRANDING_LIMITS.name}
                    placeholder="Your company's name"
                    value={form.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </Field>
                {!brand.display_name && (
                  <p data-testid="brand-name-hint" className="-mt-2 text-[13px] text-text2">
                    Exports print no company name until you add one.
                  </p>
                )}
                <div className="flex flex-col gap-1.5">
                  <Field label="Accent">
                    <span className="flex items-center gap-2">
                      {/* qa-settings-20: the swatch shows the colour, or says there is none. */}
                      <span
                        aria-hidden
                        data-testid="accent-swatch"
                        // qa-settings-15: "None" in the form's own 13 px, the swatch widening to hold it.
                        className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg border border-line-strong px-1.5 text-[13px] font-semibold text-text2"
                        style={previewAccent ? { background: previewAccent } : undefined}
                      >
                        {previewAccent ? "" : "None"}
                      </span>
                      <input
                        className={`${INPUT} max-w-40`}
                        placeholder="e.g. #0369a1"
                        aria-invalid={accentAlert || undefined}
                        aria-describedby="accent-contrast"
                        spellCheck={false}
                        value={form.accent}
                        onChange={(e) => set({ accent: e.target.value })}
                      />
                    </span>
                  </Field>
                  <span id="accent-contrast" data-testid="accent-contrast">
                    <ContrastResult accent={form.accent} alert={accentAlert} />
                  </span>
                </div>
                <Field label="Public disclaimer">
                  <textarea
                    className={TEXTAREA}
                    rows={3}
                    maxLength={BRANDING_LIMITS.disclaimer}
                    value={form.disclaimer}
                    onChange={(e) => set({ disclaimer: e.target.value })}
                  />
                </Field>
                <label className="flex items-center gap-2 text-[15px]">
                  <input type="checkbox" checked={form.mark} onChange={(e) => set({ mark: e.target.checked })} />
                  {MARK_LABEL}
                </label>
                {error && <Notice tone="error">{error}</Notice>}
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <Button type="submit" variant="solid" disabled={busy}>
                    Save branding
                  </Button>
                  {saved && (
                    <span role="status" className="text-sm font-semibold text-pass">
                      Saved
                    </span>
                  )}
                </div>
              </form>
            ) : (
              <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[15px] max-[600px]:grid-cols-1">
                <dt className="font-semibold">Display name</dt>
                <dd>{brand.display_name || "None yet"}</dd>
                <dt className="font-semibold">Accent</dt>
                <dd>{brand.accent ?? "Oracle's own"}</dd>
                <dt className="font-semibold">Public disclaimer</dt>
                <dd>{brand.public_disclaimer}</dd>
                <dt className="font-semibold">Made with Product Oracle</dt>
                <dd>{brand.oracle_mark ? "Shown on shared pages" : "Not shown"}</dd>
              </dl>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
