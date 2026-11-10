import type { Metadata } from "next";

export const metadata: Metadata = { title: "Brand" };

const colors = [
  ["Void", "#07080C", "Page background"],
  ["Carbon", "#0D1017", "Surfaces, chart surface"],
  ["Graphite", "#141924", "Raised surfaces"],
  ["Frost", "#E9EDF5", "Primary text, the mark's silver"],
  ["Mist", "#8B93A7", "Secondary text"],
  ["Flare", "#FFB547", "Brand accent, countdown, live states"],
  ["Ember", "#FF7A1A", "The final arc, final-minute intensity"],
  ["Series", "#1A9FCC", "Chart marks (validated for dark surface)"],
  ["Good", "#25A06C", "Status: confirmed (with ✓ icon)"],
  ["Warn", "#BF8A16", "Status: pending (with ◷ icon)"],
  ["Bad", "#E0565A", "Status: failed (with ✕ icon)"],
];

export default function BrandPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <div className="eyebrow">Identity</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Asteroid Protocol brand</h1>
      <p className="mt-3 max-w-2xl text-mist">
        <strong className="text-frost">The orbit.</strong> A blade-cut metal A, the apex with no crossbar, circled by a burning orbit that threads through the gap in its right leg and ends in a flare. On the site, the flare is the moment a round closes, and the countdown&apos;s final arc burns in the orbit&apos;s colours.
      </p>
      <section className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="card flex h-56 items-center justify-center bg-void px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-dark.svg" alt="Asteroid Protocol logo on dark" className="h-24 max-w-full" />
        </div>
        <div className="flex h-56 items-center justify-center rounded-[18px] bg-white px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-light.svg" alt="Asteroid Protocol logo on light" className="h-24 max-w-full" />
        </div>
        <div className="card flex h-56 items-center justify-center gap-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-dark.svg" alt="Mark" className="h-36" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-app.svg" alt="App icon" className="h-20" />
        </div>
        <div className="flex h-56 items-center justify-center gap-10 rounded-[18px] bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-light.svg" alt="Mark on light" className="h-36" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/wordmark-light.svg" alt="Wordmark on light" className="hidden h-12 sm:block" />
        </div>
      </section>
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Colour</h2>
        <p className="mt-1 max-w-2xl text-sm text-mist">Flare and Ember are the orbit. Warn sits near them in hue, so it always ships with its ◷ icon and a label, and Flare never marks a status.</p>
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
      <section className="mt-12 grid gap-4 md:grid-cols-3">
        <div className="card p-6">
          <div className="eyebrow">Wordmark — Michroma</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/wordmark-dark.svg" alt="ASTEROID PROTOCOL" className="mt-4 h-12 max-w-full" />
          <p className="mt-3 text-mist">Outlined from Michroma, emboldened, with the A drawn as the mark&apos;s apex. Logo only: never set as running text.</p>
        </div>
        <div className="card p-6">
          <div className="eyebrow">Sans — Geist</div>
          <p className="mt-3 text-3xl font-semibold tracking-tight">The final minute pays.</p>
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
