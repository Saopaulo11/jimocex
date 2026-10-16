"use client";

import { useState } from "react";

import { HoldingsTable } from "@/components/wallets/tables";
import { SearchInput } from "@/components/ui";
import type { WalletHoldingView } from "@/lib/wallets/types";

/**
 * The balances list with a client-side search. The rows are already loaded and
 * scoped to the caller by RLS on the server; this only filters what is shown.
 */
export function WalletsList({ rows }: { rows: WalletHoldingView[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toUpperCase();
  const filtered = q === "" ? rows : rows.filter((r) => r.symbol.includes(q) || r.name.toUpperCase().includes(q));

  return (
    <div className="jc-stack">
      <div style={{ maxWidth: 320 }}>
        <SearchInput
          id="wallet-search"
          label="Search assets"
          placeholder="Search assets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <HoldingsTable rows={filtered} showActions />
    </div>
  );
}
