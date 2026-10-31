/**
 * O5 lane 4 company branding in the mock: GET/PUT /v1/branding, POST/DELETE
 * /v1/branding/logo, GET /uploads/brand/<sha256>.png, and the brand header every HTML export
 * starts with. Matches the API's contract (api/oracle/branding.py); the API re-encodes a logo
 * to PNG, the mock keeps the uploaded bytes and reports them as image/png.
 */
import {
  BRANDING_LIMITS,
  contrastOnWhite,
  darkBackground,
  DEFAULT_DISCLAIMER,
  normalHex,
  passesAA,
  TOO_LIGHT,
  type BrandingIn,
  type BrandingOut,
  type BrandLogo,
} from "@/lib/api/branding-types";

import { builtinThemeBackgrounds } from "./lane-f";

type Role = "viewer" | "commenter" | "approver" | "owner";
type StoredLogo = Omit<BrandLogo, "url">;

export type BrandingDb = {
  display_name: string;
  logo: StoredLogo | null;
  logo_dark: StoredLogo | null;
  accent: string | null;
  public_disclaimer: string;
  oracle_mark: boolean;
  revision: number;
  /** The logos' bytes, base64, by sha256. */
  assets: Record<string, string>;
  /** An owner saved the display name (the API's stored display_name); unset, it reads as the company's name. */
  named?: boolean;
};

/** The mock company's name (fixtures: "Example Co"). */
export const MOCK_COMPANY_NAME = "Example Co";

export function emptyBranding(): BrandingDb {
  return {
    display_name: MOCK_COMPANY_NAME,
    logo: null,
    logo_dark: null,
    accent: null,
    public_disclaimer: DEFAULT_DISCLAIMER,
    oracle_mark: true,
    revision: 0,
    assets: {},
  };
}

const logoOut = (l: StoredLogo | null): BrandLogo | null => (l ? { ...l, url: `/uploads/brand/${l.sha256}.png` } : null);

export function brandingOut(b: BrandingDb, role: Role): BrandingOut {
  return {
    display_name: b.display_name,
    logo: logoOut(b.logo),
    logo_dark: logoOut(b.logo_dark),
    accent: b.accent,
    public_disclaimer: b.public_disclaimer,
    oracle_mark: b.oracle_mark,
    revision: b.revision,
    can_edit: role === "owner",
    // As the API: the dark logo on a dark background, the logo otherwise and without one.
    theme_logos: builtinThemeBackgrounds().map((t) => ({ ...t, variant: b.logo_dark && darkBackground(t.background) ? "dark" : "light" })),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const forbidden = () => json(403, { detail: "Requires the owner role" });

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** The image's kind and size from its magic bytes, not its declared type; null when not PNG, JPEG or WebP. */
function sniff(b: Uint8Array): { width: number; height: number } | null {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 24 && PNG.every((x, i) => b[i] === x) && ascii(b, 12, 4) === "IHDR") return { width: u32(b, 16), height: u32(b, 20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // JPEG: the first start-of-frame marker holds the size.
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: u16(b, at + 7), height: u16(b, at + 5) };
      at += 2 + u16(b, at + 2);
    }
    return null;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** PUT /v1/branding's checks, with the API's messages. */
function validate(input: Partial<BrandingIn> | null): { ok: BrandingIn } | { detail: string } {
  if (!input || typeof input !== "object") return { detail: "Send the branding" };
  const name = typeof input.display_name === "string" ? input.display_name.trim() : "";
  if (!name || name.length > BRANDING_LIMITS.name) return { detail: `The display name must be 1 to ${BRANDING_LIMITS.name} characters` };
  const disclaimer = typeof input.public_disclaimer === "string" ? input.public_disclaimer.trim() : "";
  if (!disclaimer || disclaimer.length > BRANDING_LIMITS.disclaimer) return { detail: `The public disclaimer must be 1 to ${BRANDING_LIMITS.disclaimer} characters` };
  const mark = input.oracle_mark ?? true;
  if (typeof mark !== "boolean") return { detail: "oracle_mark is true or false" };
  let accent: string | null = null;
  if (input.accent != null && input.accent !== "") {
    accent = typeof input.accent === "string" ? normalHex(input.accent) : null;
    if (!accent) return { detail: "The accent must be a hex colour like #0369a1" };
    if (!passesAA(contrastOnWhite(accent))) return { detail: TOO_LIGHT };
  }
  return { ok: { display_name: name, accent, public_disclaimer: disclaimer, oracle_mark: mark } };
}

/**
 * /v1/branding… and /uploads/brand/…; null for other routes. `p` is the path's segments
 * (["v1", "branding", …] or ["uploads", "brand", "<sha>.png"]).
 */
export async function routeBranding(b: BrandingDb, role: Role, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  if (p[0] === "uploads") {
    const file = p[1] === "brand" && p.length === 3 ? /^([0-9a-f]{64})\.png$/.exec(p[2]) : null;
    const bytes = file && m === "GET" ? b.assets[file[1]] : undefined;
    if (!bytes) return json(404, { detail: "Logo not found" });
    return new Response(fromBase64(bytes), { headers: { "content-type": "image/png" } });
  }
  if (p[0] !== "v1" || p[1] !== "branding") return null;
  if (p.length === 2 && m === "GET") return json(200, brandingOut(b, role));
  if (p.length === 2 && m === "PUT") {
    if (role !== "owner") return forbidden();
    const checked = validate(JSON.parse((await req.text()) || "null") as Partial<BrandingIn> | null);
    if ("detail" in checked) return json(422, { detail: checked.detail });
    Object.assign(b, checked.ok, { named: true });
    b.revision += 1;
    return json(200, brandingOut(b, role));
  }
  if (p[2] === "logo" && p.length === 3 && (m === "POST" || m === "DELETE")) {
    if (role !== "owner") return forbidden();
    const variant = q.get("variant") ?? "light";
    if (variant !== "light" && variant !== "dark") return json(422, { detail: "variant is light or dark" });
    const key = variant === "dark" ? "logo_dark" : "logo";
    if (m === "DELETE") {
      b[key] = null;
    } else {
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!file || typeof file === "string") return json(422, { detail: "Upload a PNG, JPEG or WebP" });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = sniff(bytes);
      if (!size) return json(422, { detail: "Upload a PNG, JPEG or WebP" });
      if (bytes.length > BRANDING_LIMITS.logoBytes) return json(422, { detail: "The logo must be at most 512 KB" });
      if (size.width > BRANDING_LIMITS.logoPx || size.height > BRANDING_LIMITS.logoPx || !size.width || !size.height) {
        return json(422, { detail: "The logo must be at most 2,000 × 2,000 px" });
      }
      const sha = await sha256(bytes);
      b.assets[sha] = toBase64(bytes);
      b[key] = { sha256: sha, type: "image/png", width: size.width, height: size.height };
    }
    // Keep only the bytes a logo still uses.
    const used = new Set([b.logo?.sha256, b.logo_dark?.sha256]);
    for (const sha of Object.keys(b.assets)) if (!used.has(sha)) delete b.assets[sha];
    b.revision += 1;
    return json(200, brandingOut(b, role));
  }
  return json(404, { detail: "Route not found" });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/**
 * The brand header every HTML export's body starts with (at most 40 px high): the dark logo
 * on a dark `background`, the logo otherwise and while no dark logo is uploaded.
 */
export function brandHeaderHtml(b: BrandingDb, background = "#ffffff"): string {
  const logo = b.logo_dark && darkBackground(background) ? b.logo_dark : b.logo;
  const bytes = logo ? b.assets[logo.sha256] : undefined;
  const name = exportName(b);
  const img = bytes ? `<img class="brand-logo" src="data:image/png;base64,${bytes}" alt="${esc(name)}" height="40">` : "";
  if (!img && !name) return "";
  return `<header class="brand-header">${img}${name ? `<span class="brand-name">${esc(name)}</span>` : ""}</header>`;
}

/**
 * The name an export prints (as the API's oracle.branding.export_name): the saved display name,
 * else the company's, never the seed's placeholder (e2e-pdf-export: none is printed then).
 */
export function exportName(b: BrandingDb): string {
  return b.named || b.display_name !== SEED_PLACEHOLDER_NAME ? b.display_name : "";
}

/** The API seed's stand-in company name (oracle.models.PLACEHOLDER_NAME). */
export const SEED_PLACEHOLDER_NAME = "Example Co";

/** The accent mapped onto the export's tokens, when one is set. */
export function brandStyleHtml(b: BrandingDb): string {
  return b.accent ? `<style>:root { --color-accent: ${b.accent}; --accent: ${b.accent}; }</style>` : "";
}
