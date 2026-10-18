import type { Metadata } from "next";
import { Suspense } from "react";

import { AppHeader, HeaderShell } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { MeProvider, MeSync } from "@/lib/me";
import "./globals.css";

export const metadata: Metadata = {
  title: "Product Oracle",
  description: "PRD review loop",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <MeProvider>
          <Suspense fallback={null}>
            <MeSync />
          </Suspense>
          <Suspense fallback={<HeaderShell />}>
            <AppHeader />
          </Suspense>
          <div className="flex w-full flex-1">
            <Suspense fallback={null}>
              <AppNav />
            </Suspense>
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </MeProvider>
      </body>
    </html>
  );
}
