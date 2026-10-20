/**
 * Google's Drive picker, for Google Docs sources (S5, 2026-10-19).
 *
 * People pick the files Oracle may read; Oracle holds Google's drive.file access, so it
 * can open only those. The browser loads Google's two scripts from their own hosts only
 * (GAPI_SRC, GIS_SRC; the Sources page's CSP allows exactly these), asks Google Identity
 * Services for a drive.file token with Oracle's client id, and opens google.picker with
 * that token. Picking a file grants it to Oracle's Cloud project (app_id), so the API's
 * Google connection, the same person's grant, can then read it.
 *
 * Folders: drive.file grants a picked folder, not the files in it, so folders are shown
 * to browse into but cannot be picked (see the connector, google_docs.py).
 */
import type { Schemas } from "@/lib/api/client";

export const GAPI_SRC = "https://apis.google.com/js/api.js";
export const GIS_SRC = "https://accounts.google.com/gsi/client";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DOC_MIME = "application/vnd.google-apps.document";

export type PickerConfig = Schemas["PickerConfigOut"];
export interface PickedFile {
  id: string;
  name: string;
  mimeType: string;
}

// The parts of Google's globals this module uses.
interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}
interface DocsView {
  setMimeTypes(types: string): DocsView;
  setIncludeFolders(include: boolean): DocsView;
  setSelectFolderEnabled(enabled: boolean): DocsView;
  setMode(mode: unknown): DocsView;
}
interface PickerBuilder {
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(cb: (data: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}
interface PickerResponse {
  action: string;
  docs?: { id: string; name?: string; mimeType?: string }[];
}
interface GoogleGlobal {
  accounts?: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        login_hint?: string;
        prompt?: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string; message?: string }) => void;
      }): TokenClient;
    };
  };
  picker?: {
    DocsView: new (viewId?: unknown) => DocsView;
    DocsViewMode: { LIST: unknown };
    PickerBuilder: new () => PickerBuilder;
    ViewId: { DOCS: unknown };
    Feature: { MULTISELECT_ENABLED: unknown };
    Action: { PICKED: string; CANCEL: string };
  };
}
declare global {
  interface Window {
    gapi?: { load(name: string, options: { callback: () => void; onerror?: () => void }): void };
    google?: GoogleGlobal;
  }
}

const loading = new Map<string, Promise<void>>();

/** Loads one of Google's two scripts, once. Any other URL is refused. */
function loadScript(src: typeof GAPI_SRC | typeof GIS_SRC): Promise<void> {
  if (src !== GAPI_SRC && src !== GIS_SRC) return Promise.reject(new Error("Unexpected script host"));
  const known = loading.get(src);
  if (known) return known;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading.delete(src);
      reject(new Error("Google Drive could not be loaded; check your connection and try again"));
    };
    document.head.appendChild(script);
  });
  loading.set(src, promise);
  return promise;
}

async function loadPickerApi(): Promise<NonNullable<GoogleGlobal["picker"]>> {
  await loadScript(GAPI_SRC);
  if (!window.google?.picker) {
    await new Promise<void>((resolve, reject) =>
      window.gapi!.load("picker", {
        callback: () => resolve(),
        onerror: () => reject(new Error("The Google Drive picker could not be loaded")),
      }),
    );
  }
  return window.google!.picker!;
}

/** Loads Google's scripts ahead of a click, so the sign-in popup opens on the click itself. */
export function preloadDrivePicker(): Promise<void> {
  return Promise.all([loadPickerApi(), loadScript(GIS_SRC)]).then(
    () => undefined,
    () => undefined,
  );
}

let cached: { token: string; until: number; hint: string } | null = null;

/** A drive.file access token for `hint`'s Google account (a Google popup on first use). */
async function driveFileToken(config: PickerConfig, hint: string): Promise<string> {
  if (cached && cached.hint === hint && cached.until > Date.now()) return cached.token;
  await loadScript(GIS_SRC);
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error("Google sign-in could not be loaded");
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: config.client_id,
      scope: DRIVE_FILE_SCOPE,
      login_hint: hint || undefined,
      callback: (r) => {
        if (!r.access_token) {
          reject(new Error(r.error_description || r.error || "Google did not grant access to Drive"));
          return;
        }
        const seconds = Number(r.expires_in ?? 3600);
        cached = { token: r.access_token, until: Date.now() + Math.max(0, seconds - 60) * 1000, hint };
        resolve(r.access_token);
      },
      error_callback: (e) =>
        reject(new Error(e.type === "popup_closed" ? "Google sign-in was closed" : e.message || "Google sign-in failed")),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

/**
 * Opens Google's Drive picker: Google Docs, folders to browse into, several at once.
 * Resolves with the picked files, or null when the person cancels.
 */
export async function chooseFromDrive(config: PickerConfig, hint: string): Promise<PickedFile[] | null> {
  const [picker, token] = await Promise.all([loadPickerApi(), driveFileToken(config, hint)]);
  const view = new picker.DocsView(picker.ViewId.DOCS)
    .setMimeTypes(DOC_MIME)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false)
    .setMode(picker.DocsViewMode.LIST);
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setAppId(config.app_id)
      .setDeveloperKey(config.developer_key)
      .setOAuthToken(token)
      .setOrigin(window.location.origin)
      .setTitle("Choose Google Docs")
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve(
            (data.docs ?? [])
              .filter((d) => d.mimeType === DOC_MIME)
              .map((d) => ({ id: d.id, name: d.name || d.id, mimeType: d.mimeType || DOC_MIME })),
          );
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}
