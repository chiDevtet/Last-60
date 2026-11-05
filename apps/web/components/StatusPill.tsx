import type { PayoutState, RoundPhase } from "@last60/shared";

/** Status = colour + icon + label, never colour alone (validated status palette). */
const MAP: Record<string, { label: string; icon: string; cls: string }> = {
  confirmed: { label: "Confirmed", icon: "✓", cls: "text-good border-good/40 bg-good/10" },
  settled: { label: "Settled", icon: "✓", cls: "text-good border-good/40 bg-good/10" },
  simulated: { label: "Dry-run", icon: "◌", cls: "text-mist border-line-strong bg-white/5" },
  pending: { label: "Pending", icon: "◷", cls: "text-warn border-warn/40 bg-warn/10" },
  submitted: { label: "Submitted", icon: "◷", cls: "text-warn border-warn/40 bg-warn/10" },
  processing: { label: "Processing", icon: "◷", cls: "text-warn border-warn/40 bg-warn/10" },
  awaiting_funds: { label: "Queued", icon: "◷", cls: "text-warn border-warn/40 bg-warn/10" },
  failed: { label: "Failed", icon: "✕", cls: "text-bad border-bad/40 bg-bad/10" },
  attention: { label: "Review", icon: "!", cls: "text-bad border-bad/40 bg-bad/10" },
  rolled_over: { label: "Rolled over", icon: "↻", cls: "text-mist border-line-strong bg-white/5" },
  missed: { label: "Missed", icon: "–", cls: "text-dim border-line bg-white/5" },
  open: { label: "Open", icon: "•", cls: "text-mist border-line bg-white/5" },
  final_minute: { label: "Final minute", icon: "•", cls: "text-signal border-signal/30 bg-signal/10" },
};

export function StatusPill({ status }: { status: PayoutState | RoundPhase | string }) {
  const s = MAP[status] ?? { label: status, icon: "•", cls: "text-mist border-line bg-white/5" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}
