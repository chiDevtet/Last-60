import type { Metadata } from "next";

export const metadata: Metadata = { title: "Brand" };

const colors = [
  ["Void", "#07080C", "Page background"],
  ["Carbon", "#0D1017", "Surfaces, chart surface"],
  ["Graphite", "#141924", "Raised surfaces"],
  ["Frost", "#E9EDF5", "Primary text"],
  ["Mist", "#8B93A7", "Secondary text"],
  ["Signal", "#38E1FF", "Brand accent, countdown, live states"],
  ["Pulse", "#7B61FF", "Final arc, final-minute intensity"],
  ["Series", "#1A9FCC", "Chart marks (validated for dark surface)"],
  ["Good", "#25A06C", "Status: confirmed (with ✓ icon)"],
  ["Warn", "#BF8A16", "Status: pending (with ◷ icon)"],
  ["Bad", "#E0565A", "Status: failed (with ✕ icon)"],
];

export default function BrandPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <div className="eyebrow">Identity</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">LAST60 brand</h1>
      <p className="mt-3 max-w-2xl text-mist">
        <strong className="text-frost">The final arc.</strong> A round is a five-segment ring, one segment per minute. Only the last segment — the final sixty seconds — is lit, ending in a bright tick at twelve o&apos;clock. The same ring is the zero in the wordmark.
      </p>
      <section className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="card flex h-56 items-center justify-center bg-void">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-dark.svg" alt="LAST60 logo on dark" className="h-16" />
        </div>
        <div className="flex h-56 items-center justify-center rounded-[18px] bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-light.svg" alt="LAST60 logo on light" className="h-16" />
        </div>
        <div className="card flex h-56 items-center justify-center gap-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-dark.svg" alt="Icon" className="h-28" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-app.svg" alt="App icon" className="h-20" />
        </div>
        <div className="flex h-56 items-center justify-center rounded-[18px] bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-light.svg" alt="Icon on light" className="h-28" />
        </div>
      </section>
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Colour</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {colors.map(([n, hex, use]) => (
            <div key={n} className="card overflow-hidden">
              <div className="h-16" style={{ background: hex }} />
              <div className="p-3 text-sm">
                <div className="font-semibold">{n} <span className="font-mono text-xs text-mist">{hex}</span></div>
                <div className="text-xs text-mist">{use}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="mt-12 grid gap-4 md:grid-cols-2">
        <div className="card p-6">
          <div className="eyebrow">Sans — Geist</div>
          <p className="mt-3 text-4xl font-semibold tracking-tight">The final minute pays.</p>
          <p className="mt-2 text-mist">UI, headings and figures. Semibold for values, proportional figures for standalone numbers.</p>
        </div>
        <div className="card p-6">
          <div className="eyebrow">Mono — Geist Mono</div>
          <p className="mt-3 font-mono text-lg">[12:04:37] CONFIRMED: 0.063 SOL</p>
          <p className="mt-2 text-mist">Terminal, addresses, signatures, labels. Tabular figures for columns and the ticking clock.</p>
        </div>
      </section>
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Social</h2>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/x-banner.png" alt="X banner" className="mt-4 w-full rounded-[18px] border border-line" />
        <div className="mt-4 flex flex-wrap gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/social-profile.png" alt="Profile image" className="h-40 w-40 rounded-full border border-line" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/og-image.png" alt="Open Graph image" className="h-40 rounded-xl border border-line" />
        </div>
      </section>
    </main>
  );
}
