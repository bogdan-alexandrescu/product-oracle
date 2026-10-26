/**
 * O5 lane 4 company branding: the transport. Calls go through the same cookie session as
 * the typed client (a Request is same-origin by default); in mock mode they go to the
 * in-browser mock, as the typed client does. The API's 422 details are shown as they are
 * (the typed client's unwrap adds the status), so the page reads exactly what the API says.
 */
import type { BrandingIn, BrandingOut, BrandLogo, LogoVariant } from "./branding-types";
import { ApiError, MOCK_MODE } from "./client";
import { mockFetch } from "./mock/server";

export * from "./branding-types";

const send = (req: Request) => (MOCK_MODE ? mockFetch(req) : fetch(req));

async function call<T>(method: string, path: string, body?: BodyInit, json = false): Promise<T> {
  const res = await send(
    new Request(new URL(path, window.location.origin), {
      method,
      headers: json ? { "Content-Type": "application/json" } : undefined,
      body,
    }),
  );
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return data as T;
  const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
  const message =
    res.status === 401
      ? "Your session has expired. Sign in again."
      : typeof detail === "string"
        ? detail
        : Array.isArray(detail) && typeof detail[0]?.msg === "string"
          ? String(detail[0].msg)
          : `Request failed (${res.status}).`;
  throw new ApiError(res.status, message);
}

export const getBranding = () => call<BrandingOut>("GET", "/v1/branding");

export const putBranding = (body: BrandingIn) => call<BrandingOut>("PUT", "/v1/branding", JSON.stringify(body), true);

export function uploadBrandLogo(file: File, variant: LogoVariant = "light") {
  const form = new FormData();
  form.append("file", file);
  return call<BrandingOut>("POST", `/v1/branding/logo?variant=${variant}`, form);
}

export const deleteBrandLogo = (variant: LogoVariant = "light") => call<BrandingOut>("DELETE", `/v1/branding/logo?variant=${variant}`);

/**
 * A stored logo as a data: URL (the app's CSP allows img-src 'self' data: only), read through
 * the same transport as every call.
 */
export async function logoDataUrl(logo: BrandLogo): Promise<string> {
  const res = await send(new Request(new URL(logo.url, window.location.origin)));
  if (!res.ok) throw new ApiError(res.status, "Oracle could not read the logo.");
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Oracle could not read the logo."));
    reader.readAsDataURL(blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" }));
  });
}
