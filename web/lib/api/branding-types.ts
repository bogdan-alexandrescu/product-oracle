/**
 * O5 lane 4 company branding: the API's shapes (from the generated schema) and the pure
 * helpers the page and the mock share. No imports of the transport, so the mock can use
 * them too.
 */
import type { components } from "@/lib/api/schema";
import type { Operation } from "@/lib/me";

type S = components["schemas"];

/** A stored logo: re-encoded to PNG by the API, served at `url` to members. */
export type BrandLogo = S["BrandLogo"];
/** GET /v1/branding (`can_edit`: owners only). */
export type BrandingOut = S["BrandingOut"];
/** PUT /v1/branding. */
export type BrandingIn = S["BrandingIn"];

export type LogoVariant = "light" | "dark";

/** The branding operations (their operationIds). */
export const BRANDING_OPS = {
  get: "get_branding",
  put: "put_branding",
  upload: "upload_brand_logo",
  remove: "delete_brand_logo",
  logo: "get_brand_logo",
} as const satisfies Record<string, Operation>;

/** Limits the API enforces (oracle.branding). */
export const BRANDING_LIMITS = { name: 80, disclaimer: 500, logoBytes: 512 * 1024, logoPx: 2000 } as const;
export const DEFAULT_DISCLAIMER = "This roadmap shows our current plans. It is not a commitment, and plans and timing can change.";
export const TOO_LIGHT = "This colour is too light to read on white. Pick a darker one.";
export const LOGO_TYPES = "image/png,image/jpeg,image/webp";

/** "#rrggbb" or "#rgb" as "#rrggbb" in lower case; null when it is not a hex colour. */
export function normalHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  return null;
}

/** WCAG 2 contrast ratio of a hex colour against white (#ffffff). */
export function contrastOnWhite(hex: string): number {
  const full = normalHex(hex);
  if (!full) return NaN;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (lum + 0.05);
}

/** AA for normal text: at least 4.5:1. */
export const passesAA = (ratio: number) => ratio >= 4.5;
