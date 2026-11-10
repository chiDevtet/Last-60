"use client";
import { useState } from "react";

/** "Token CA: <mint>" with a one-click copy, shown under the countdown. */
export function TokenCA({ mint }: { mint: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!mint) return null;
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(mint).then(done, () => undefined);
    else {
      // Fallback for browsers without the async clipboard API.
      const t = document.createElement("textarea");
      t.value = mint;
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
        done();
      } finally {
        t.remove();
      }
    }
  };
  return (
    <div className="mx-auto mt-6 flex max-w-2xl flex-wrap items-center justify-center gap-2 text-sm">
      <span className="text-mist">Token CA:</span>
      <button onClick={copy} title="Copy contract address" className="focus-ring break-all rounded-lg border border-line bg-white/[0.03] px-3 py-1.5 text-left font-mono text-xs text-frost hover:bg-white/[0.06] sm:text-sm">
        {mint}
      </button>
      <button onClick={copy} aria-label="Copy token contract address" className="focus-ring rounded-lg border border-line px-2.5 py-1.5 text-xs text-mist hover:text-frost">
        {copied ? "Copied ✓" : "Copy"}
      </button>
      <span className="sr-only" aria-live="polite">{copied ? "Contract address copied" : ""}</span>
    </div>
  );
}
