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

/** The contrast of the accent on white, as the API checks it (WCAG AA, 4.5:1). */
function ContrastResult({ accent }: { accent: string }) {
  const hex = normalHex(accent);
  if (!accent.trim()) return <span className="text-[13px] text-text2">No accent: Oracle&apos;s own</span>;
  if (!hex) return <span className="text-[13px] text-text2">Not a hex colour</span>;
  const ratio = contrastOnWhite(hex);
  const ok = passesAA(ratio);
  return (
    <span className={`text-[13px] font-semibold ${ok ? "text-pass" : "text-crit"}`}>
      {ratio.toFixed(2)}:1 · {ok ? "Passes AA" : "Too light"}
    </span>
  );
}

/** The live preview: the logo and name on a light header and on a dark slide. */
function Preview({ name, accent, light, dark }: { name: string; accent: string | null; light?: string; dark?: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
      <div
        data-testid="brand-preview-light"
        className="flex h-16 items-center gap-3 rounded-lg border border-line bg-white px-4"
        style={accent ? { borderBottom: `3px solid ${accent}` } : undefined}
      >
        {/* A data: URL: next/image would fetch it again through its optimiser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {light && <img src={light} alt={name} className="h-10 w-auto max-w-[200px] object-contain" />}
        <span className="truncate text-[15px] font-semibold text-[#111]">{name}</span>
      </div>
      <div
        data-testid="brand-preview-dark"
        className="flex h-16 items-center gap-3 rounded-lg bg-[#111827] px-4"
        style={accent ? { borderBottom: `3px solid ${accent}` } : undefined}
      >
        {/* A data: URL: next/image would fetch it again through its optimiser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {dark && <img src={dark} alt={name} className="h-10 w-auto max-w-[200px] object-contain" />}
        <span className="truncate text-[15px] font-semibold text-white">{name}</span>
      </div>
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
  const form = edit ?? (brand ? formOf(brand) : null);
  const urlOf = useLogoUrls([brand?.logo, brand?.logo_dark]);

  const set = (patch: Partial<Form>) => {
    if (!form) return;
    setEdit({ ...form, ...patch });
    setSaved(false);
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

  const upload = (file: File | undefined, variant: LogoVariant) => {
    if (file) void run(() => uploadBrandLogo(file, variant));
  };

  const save = () =>
    form &&
    run(
      () => putBranding({ display_name: form.name, accent: form.accent.trim() || null, public_disclaimer: form.disclaimer, oracle_mark: form.mark }),
      () => {
        setEdit(null);
        setSaved(true);
      },
    );

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
                  <Field label="Logo" className="min-w-56">
                    <input
                      type="file"
                      accept={LOGO_TYPES}
                      disabled={busy}
                      className="text-[13px]"
                      onChange={(e) => {
                        upload(e.target.files?.[0], "light");
                        e.target.value = "";
                      }}
                    />
                  </Field>
                  <Field label="Dark logo" className="min-w-56">
                    <input
                      type="file"
                      accept={LOGO_TYPES}
                      disabled={busy}
                      className="text-[13px]"
                      onChange={(e) => {
                        upload(e.target.files?.[0], "dark");
                        e.target.value = "";
                      }}
                    />
                  </Field>
                  {brand.logo && (
                    <Button variant="ghost" disabled={busy} onClick={() => void run(() => deleteBrandLogo("light"))}>
                      Remove logo
                    </Button>
                  )}
                  {brand.logo_dark && (
                    <Button variant="ghost" disabled={busy} onClick={() => void run(() => deleteBrandLogo("dark"))}>
                      Remove dark logo
                    </Button>
                  )}
                </div>
                <p className="text-[13px] text-text2">PNG, JPEG or WebP, at most 512 KB and 2,000 × 2,000 px. Shown at most 40 px high.</p>
                <Field label="Display name">
                  <input className={`${INPUT} max-w-96`} maxLength={BRANDING_LIMITS.name} value={form.name} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <div className="flex flex-col gap-1.5">
                  <Field label="Accent">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-9 shrink-0 rounded-lg border border-line-strong"
                        style={{ background: previewAccent ?? "transparent" }}
                      />
                      <input
                        className={`${INPUT} max-w-40 font-mono`}
                        placeholder="#0369a1"
                        spellCheck={false}
                        value={form.accent}
                        onChange={(e) => set({ accent: e.target.value })}
                      />
                    </span>
                  </Field>
                  <span data-testid="accent-contrast">
                    <ContrastResult accent={form.accent} />
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
                <dd>{brand.display_name}</dd>
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
