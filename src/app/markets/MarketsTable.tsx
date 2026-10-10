"use client";

import { useMemo, useState } from "react";

import { AssetIcon } from "@/components/financial";
import {
  LinkButton,
  SearchInput,
  Segmented,
  Table,
  TableStateRow,
  Td,
  Th,
} from "@/components/ui";
import { EmptyState } from "@/components/ui/EmptyState";
import { MARKET_CATEGORIES, type Market, type PairType } from "@/lib/markets/types";

/**
 * Markets table (spec §32).
 *
 * Search and category filtering happen on the client because the pair list is
 * small, fully loaded, and filtering it is instant — a round trip per keystroke
 * would be slower and no more correct.
 *
 * The price, change and volume columns are present and empty. That is
 * deliberate: the columns describe what the platform will show, the dash says
 * it has nothing to show yet, and nothing is invented to fill the gap.
 */
export function MarketsTable({
  markets,
  pricesAvailable,
}: {
  markets: Market[];
  pricesAvailable: boolean;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"ALL" | PairType>("ALL");

  const visible = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return markets.filter((market) => {
      if (category !== "ALL" && market.type !== category) return false;
      if (!needle) return true;
      return (
        market.symbol.includes(needle) ||
        market.base.includes(needle) ||
        market.quote.includes(needle)
      );
    });
  }, [markets, query, category]);

  return (
    <div className="jc-stack-lg">
      <div className="jc-row-between jc-row-wrap">
        <Segmented
          label="Market category"
          options={MARKET_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
          value={category}
          onChange={setCategory}
        />
        <div style={{ minWidth: 220, flex: "0 1 280px" }}>
          <SearchInput
            id="market-search"
            label="Search markets"
            placeholder="Search pair, e.g. BTC"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="jc-card">
        <Table caption="Listed markets with price, 24 hour change and volume">
          <thead>
            <tr>
              <Th>Pair</Th>
              <Th numeric>Price</Th>
              <Th numeric>24h</Th>
              <Th numeric>Volume 24h</Th>
              <Th>
                <span className="jc-sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <TableStateRow colSpan={5}>
                <EmptyState
                  title={markets.length === 0 ? "Market listing unavailable" : "No markets match"}
                  description={
                    markets.length === 0
                      ? "The pair list could not be loaded. Please try again shortly."
                      : "Try a different search term or category."
                  }
                />
              </TableStateRow>
            ) : (
              visible.map((market) => (
                <tr key={market.symbol}>
                  <Td>
                    <span className="jc-row" style={{ gap: "var(--jc-space-3)" }}>
                      <AssetIcon symbol={market.base} />
                      <span>
                        <span style={{ fontWeight: 500 }}>{market.base}</span>
                        <span className="jc-muted">/{market.quote}</span>
                      </span>
                    </span>
                  </Td>
                  <Td numeric>{pricesAvailable ? null : <span className="jc-muted">—</span>}</Td>
                  <Td numeric>{pricesAvailable ? null : <span className="jc-muted">—</span>}</Td>
                  <Td numeric>{pricesAvailable ? null : <span className="jc-muted">—</span>}</Td>
                  <Td>
                    <span style={{ display: "flex", justifyContent: "flex-end" }}>
                      <LinkButton
                        href={`/trade/${market.symbol}`}
                        variant="tertiary"
                        size="sm"
                        disabled={!market.tradingEnabled}
                      >
                        {market.tradingEnabled ? "Trade" : "Unavailable"}
                      </LinkButton>
                    </span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
