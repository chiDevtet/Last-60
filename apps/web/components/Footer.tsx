import { accountUrl } from "@/lib/explorer";
import { shortAddress } from "@/lib/format";

export function Footer({ mint, pool, explorer, cluster }: { mint: string; pool: string; explorer: string; cluster: string }) {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-mist sm:px-6 md:grid-cols-[1fr_auto]">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-dark.svg" alt="Asteroid Protocol" className="h-9 w-auto opacity-90" />
          <p className="mt-3 max-w-lg text-xs leading-relaxed">
            Rewards depend on trading activity and are not guaranteed. Nothing on this site is financial advice. All payouts are public Solana transactions; verify them on-chain.
          </p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-xs">
          {mint && (
            <>
              <dt>Token</dt>
              <dd><a className="focus-ring hover:text-frost" href={accountUrl(explorer, mint, cluster)} target="_blank" rel="noreferrer">{shortAddress(mint, 6, 6)} ↗</a></dd>
            </>
          )}
          {pool && (
            <>
              <dt>Pool</dt>
              <dd><a className="focus-ring hover:text-frost" href={accountUrl(explorer, pool, cluster)} target="_blank" rel="noreferrer">{shortAddress(pool, 6, 6)} ↗</a></dd>
            </>
          )}
          <dt>Brand</dt>
          <dd><a className="focus-ring hover:text-frost" href="/brand">Identity &amp; assets</a></dd>
        </dl>
      </div>
    </footer>
  );
}
