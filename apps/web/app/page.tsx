import type { DashboardSnapshotDTO, TerminalEventDTO } from "@last60/shared";
import { Dashboard } from "@/components/Dashboard";
import { INTERNAL_API_URL } from "@/lib/config";

export const dynamic = "force-dynamic";

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}${path}`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // the page still renders and connects live once the API is reachable
  }
}

export default async function Page() {
  const [snapshot, terminal] = await Promise.all([get<DashboardSnapshotDTO>("/api/v1/dashboard"), get<{ items: TerminalEventDTO[] }>("/api/v1/terminal?limit=80")]);
  const tradeUrl = process.env.NEXT_PUBLIC_TRADE_URL || (snapshot?.meta.tokenMint ? `https://jup.ag/swap/SOL-${snapshot.meta.tokenMint}` : null);
  return <Dashboard initial={snapshot} initialTerminal={terminal?.items ?? []} tradeUrl={tradeUrl} />;
}
