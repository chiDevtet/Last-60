import type { Metadata } from "next";
import { AdminConsole } from "./AdminConsole";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default function AdminPage() {
  return (
    <main className="min-h-dvh">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-4 sm:px-6">
          <a href="/" className="focus-ring">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-dark.svg" alt="LAST60" className="h-5 w-auto" />
          </a>
          <span className="ml-3 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-mist">ADMIN</span>
        </div>
      </header>
      <AdminConsole />
    </main>
  );
}
