import type { Page } from "@playwright/test";

/**
 * Stands in for Google in the browser: answers https://apis.google.com/js/api.js and
 * https://accounts.google.com/gsi/client with fakes of gapi, Google Identity Services and
 * google.picker, and aborts any other request to a Google host, so no test reaches Google.
 * The fake picker "picks" `files` and records how it was built in window.__drive.
 */
export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType?: string;
}

const DOC = "application/vnd.google-apps.document";

const GIS = `
window.google = window.google || {};
window.__drive = window.__drive || {};
window.google.accounts = { oauth2: { initTokenClient(config) {
  window.__drive.tokenClient = { client_id: config.client_id, scope: config.scope, login_hint: config.login_hint };
  return { requestAccessToken() {
    setTimeout(() => config.callback({ access_token: "fake-drive-file-token", expires_in: 3599, scope: config.scope }), 0);
  } };
} } };
`;

function gapi(files: FakeDriveFile[], cancel: boolean): string {
  return `
window.__drive = window.__drive || {};
window.__drive.opened = 0;
window.gapi = { load(name, options) {
  window.google = window.google || {};
  class DocsView {
    constructor(viewId) { this.v = { viewId }; (window.__drive.views = window.__drive.views || []).push(this.v); }
    setMimeTypes(t) { this.v.mimeTypes = t; return this; }
    setIncludeFolders(b) { this.v.includeFolders = b; return this; }
    setSelectFolderEnabled(b) { this.v.selectFolderEnabled = b; return this; }
    setMode(m) { this.v.mode = m; return this; }
  }
  class PickerBuilder {
    constructor() { this.b = { features: [], views: [] }; }
    addView(v) { this.b.views.push(v.v); return this; }
    enableFeature(f) { this.b.features.push(f); return this; }
    setAppId(x) { this.b.appId = x; return this; }
    setDeveloperKey(x) { this.b.developerKey = x; return this; }
    setOAuthToken(x) { this.b.token = x; return this; }
    setOrigin(x) { this.b.origin = x; return this; }
    setTitle(x) { this.b.title = x; return this; }
    setCallback(cb) { this.cb = cb; return this; }
    build() {
      window.__drive.builder = this.b;
      const cb = this.cb;
      return { setVisible() {
        window.__drive.opened += 1;
        setTimeout(() => cb(${cancel} ? { action: "cancel" } : { action: "picked", docs: ${JSON.stringify(
          files.map((f) => ({ ...f, mimeType: f.mimeType ?? DOC })),
        )} }), 0);
      } };
    }
  }
  window.google.picker = {
    DocsView, PickerBuilder,
    DocsViewMode: { LIST: "list" }, ViewId: { DOCS: "all" },
    Feature: { MULTISELECT_ENABLED: "multiselectEnabled" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
  };
  options.callback();
} };
`;
}

/** Fakes Google for `page`; returns the list of Google URLs the page asked for. */
export async function fakeGoogle(page: Page, files: FakeDriveFile[], opts: { cancel?: boolean } = {}) {
  const asked: string[] = [];
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com)\//, (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url === "https://apis.google.com/js/api.js") {
      return route.fulfill({ contentType: "text/javascript", body: gapi(files, !!opts.cancel) });
    }
    if (url === "https://accounts.google.com/gsi/client") {
      return route.fulfill({ contentType: "text/javascript", body: GIS });
    }
    return route.abort();
  });
  return asked;
}
