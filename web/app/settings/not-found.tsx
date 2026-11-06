import type { Metadata } from "next";

import NotFound from "../not-found";

export const metadata: Metadata = {
  title: "Page not found · Product Oracle",
};

/** F-32: the app's one not-found, drawn under the Settings tabs (settings/layout.tsx). */
export default function SettingsNotFound() {
  return <NotFound />;
}
