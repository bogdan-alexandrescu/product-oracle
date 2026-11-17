/**
 * qa-leftovers: the mock app's stand-in for Google (NEXT_PUBLIC_API_MOCKS=1), so a person can
 * finish Choose from Drive there: the mock's picker config holds no real client id, and Google's
 * own sign-in refuses it. It fakes gapi, Google Identity Services and google.picker as
 * e2e/google-fake.ts does, with a small picker listing invented example docs and a folder to tick.
 * A spec that fakes Google itself (fakeGoogle sets window.__googleFaked) keeps its own fake.
 */
const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";

const EXAMPLE_FILES = [
  { id: "1FolderSpecsExample", name: "Product specs", mimeType: FOLDER },
  { id: "1DocRoadmapExample", name: "Roadmap notes", mimeType: DOC },
  { id: "1DocPricingExample", name: "Pricing strategy", mimeType: DOC },
  { id: "1DocInterviewsExample", name: "Customer interviews", mimeType: DOC },
];

declare global {
  interface Window {
    __googleFaked?: boolean;
  }
}

/** Whether the mock app's own Google stand-in is used (mock mode, and no spec fakes Google itself). */
export function mockGoogleOn(): boolean {
  return process.env.NEXT_PUBLIC_API_MOCKS === "1" && typeof window !== "undefined" && !window.__googleFaked;
}

type Cb = (data: { action: string; docs?: { id: string; name: string; mimeType: string }[] }) => void;

/** The small picker: a dialog with a box per example file, Select and Cancel. */
function showPicker(title: string, cb: Cb) {
  const back = document.createElement("div");
  back.className = "fixed inset-0 z-[70] flex items-center justify-center bg-hero/50 px-4";
  const box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", title);
  box.className = "w-full max-w-sm rounded-panel border border-line bg-surface p-4 text-text shadow-tip";
  const h = document.createElement("h2");
  h.className = "mb-3 font-semibold";
  h.textContent = title;
  box.append(h);
  const boxes = EXAMPLE_FILES.map((f) => {
    const label = document.createElement("label");
    label.className = "flex items-center gap-2 py-1";
    const input = document.createElement("input");
    input.type = "checkbox";
    label.append(input, document.createTextNode(f.mimeType === FOLDER ? `${f.name} (folder)` : f.name));
    box.append(label);
    return input;
  });
  const row = document.createElement("div");
  row.className = "mt-3 flex justify-end gap-2";
  const done = (data: Parameters<Cb>[0]) => {
    back.remove();
    cb(data);
  };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "simple-button";
  cancel.textContent = "Cancel";
  cancel.onclick = () => done({ action: "cancel" });
  const select = document.createElement("button");
  select.type = "button";
  select.className = "simple-button simple-button-primary";
  select.textContent = "Select";
  select.onclick = () => done({ action: "picked", docs: EXAMPLE_FILES.filter((_, n) => boxes[n]!.checked) });
  row.append(cancel, select);
  box.append(row);
  back.append(box);
  document.body.append(back);
  boxes[0]?.focus();
}

/** Puts the fakes on window: gapi.load("picker"), google.accounts.oauth2 and google.picker. */
export function installMockGoogle(): void {
  if (window.google?.picker && window.google.accounts) return;
  class DocsView {
    setMimeTypes() {
      return this;
    }
    setIncludeFolders() {
      return this;
    }
    setSelectFolderEnabled() {
      return this;
    }
    setEnableDrives() {
      return this;
    }
    setMode() {
      return this;
    }
  }
  class PickerBuilder {
    title = "Choose Google Docs and folders";
    cb: Cb = () => undefined;
    addView() {
      return this;
    }
    enableFeature() {
      return this;
    }
    setAppId() {
      return this;
    }
    setDeveloperKey() {
      return this;
    }
    setOAuthToken() {
      return this;
    }
    setOrigin() {
      return this;
    }
    setTitle(t: string) {
      this.title = t;
      return this;
    }
    setCallback(cb: Cb) {
      this.cb = cb;
      return this;
    }
    build() {
      return { setVisible: () => showPicker(this.title, this.cb) };
    }
  }
  const google = (window.google ??= {});
  google.picker = {
    DocsView,
    PickerBuilder,
    DocsViewMode: { LIST: "list" },
    ViewId: { DOCS: "all" },
    Feature: { MULTISELECT_ENABLED: "multiselectEnabled" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
  } as unknown as NonNullable<typeof google.picker>;
  google.accounts = {
    oauth2: {
      initTokenClient: (config) => ({
        requestAccessToken: () => setTimeout(() => config.callback({ access_token: "mock-drive-token", expires_in: 3599 }), 0),
      }),
    },
  };
  window.gapi = { load: (_name, options) => options.callback() };
}
