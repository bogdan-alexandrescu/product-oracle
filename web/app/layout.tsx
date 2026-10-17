import type { Metadata } from "next";
import { Suspense } from "react";

import { AppHeader, HeaderShell } from "@/components/AppHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Product Oracle",
  description: "PRD review loop",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <Suspense fallback={<HeaderShell />}>
          <AppHeader />
        </Suspense>
        <main className="w-full flex-1">{children}</main>
      </body>
    </html>
  );
}
