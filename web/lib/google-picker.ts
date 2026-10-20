/**
 * Google's Drive picker, for Google Docs sources (S5, 2026-10-19; 'Drive folders').
 *
 * People pick the Google Docs and folders Oracle pulls in. Oracle holds read access to the
 * person's Drive (drive.readonly), so a picked folder brings in every doc in it, now and
 * later. The browser loads Google's two scripts from their own hosts only (GAPI_SRC,
 * GIS_SRC; the app's CSP allows exactly these), asks Google Identity Services for a
 * drive.readonly token with Oracle's client id (the same scope as the API's Google
 * connection), and opens google.picker with that token.
 *
 * Sign-in opens a Google popup, so it must start on the person's click: preloadDrivePicker
 * loads the scripts and the picker config ahead, and chooseFromDrive asks for the token
 * synchronously (no await before it), so popup blockers let it through.
 */
import type { Schemas } from "@/lib/api/client";

export const GAPI_SRC = "https://apis.google.com/js/api.js";
export const GIS_SRC = "https://accounts.google.com/gsi/client";
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DOC_MIME = "application/vnd.google-apps.document";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export type PickerConfig = Schemas["PickerConfigOut"];
export interface PickedFile {
  id: string;
  name: string;
  kind: "doc" | "folder";
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

/**
 * Loads Google's scripts ahead of a click, so the sign-in popup opens on the click itself.
 * Resolves once chooseFromDrive can run; rejects when Google cannot be loaded.
 */
export async function preloadDrivePicker(): Promise<void> {
  await Promise.all([loadPickerApi(), loadScript(GIS_SRC)]);
}

/** Whether Google's scripts are loaded, so chooseFromDrive opens without waiting. */
export function drivePickerReady(): boolean {
  return !!window.google?.picker && !!window.google?.accounts?.oauth2;
}

let cached: { token: string; until: number; hint: string } | null = null;

/**
 * A drive.readonly access token for `hint`'s Google account. The Google popup (when one
 * is needed) is requested before this returns, so call it straight from a click.
 */
function driveToken(config: PickerConfig, hint: string): Promise<string> {
  if (cached && cached.hint === hint && cached.until > Date.now()) return Promise.resolve(cached.token);
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) return Promise.reject(new Error("Google sign-in is still loading; try again"));
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: config.client_id,
      scope: DRIVE_READONLY_SCOPE,
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
 * Opens Google's Drive picker: Google Docs and folders, several at once. Call it from a
 * click after preloadDrivePicker resolved. Resolves with the picked docs and folders, or
 * null when the person cancels.
 */
export function chooseFromDrive(config: PickerConfig, hint: string): Promise<PickedFile[] | null> {
  const picker = window.google?.picker;
  if (!picker) return Promise.reject(new Error("Google Drive is still loading; try again"));
  // Synchronously, on the click: Google's sign-in popup is opened here when needed.
  const token = driveToken(config, hint);
  return token.then(
    (oauthToken) =>
      new Promise((resolve) => {
        const view = new picker.DocsView(picker.ViewId.DOCS)
          .setMimeTypes(`${DOC_MIME},${FOLDER_MIME}`)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMode(picker.DocsViewMode.LIST);
        new picker.PickerBuilder()
          .addView(view)
          .enableFeature(picker.Feature.MULTISELECT_ENABLED)
          .setAppId(config.app_id)
          .setDeveloperKey(config.developer_key)
          .setOAuthToken(oauthToken)
          .setOrigin(window.location.origin)
          .setTitle("Choose Google Docs and folders")
          .setCallback((data) => {
            if (data.action === picker.Action.PICKED) {
              resolve(
                (data.docs ?? [])
                  .filter((d) => d.mimeType === DOC_MIME || d.mimeType === FOLDER_MIME)
                  .map((d) => ({
                    id: d.id,
                    name: d.name || d.id,
                    kind: d.mimeType === FOLDER_MIME ? ("folder" as const) : ("doc" as const),
                  })),
              );
            } else if (data.action === picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build()
          .setVisible(true);
      }),
  );
}
