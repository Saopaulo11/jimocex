"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AssetIcon, Price, PriceChange } from "@/components/financial";
import { LinkButton, SearchInput, Segmented, Table, TableStateRow, Td, Th } from "@/components/ui";
import { EmptyState } from "@/components/ui/EmptyState";
import { parseMoney } from "@/lib/money";
import type { Market, MarketTicker } from "@/lib/markets/types";

/**
 * Markets table (spec §32).
 *
 * Search, category and favourites filter on the client because the pair list is
 * small and fully loaded. Prices come from the server as exact decimal strings
 * and are parsed to Money before rendering, so a demo price shows at the pair's
 * own precision — never a float. When no provider is connected the price columns
 * are dashes rather than invented numbers; a demo provider is labelled on the
 * page, not faked as live here.
 */

const FAVOURITES_KEY = "jimocex.favourites.markets";
const BASE_TABS = ["All", "Favorites"] as const;

export function MarketsTable({
  markets,
  tickers,
  pricesAvailable,
}: {
  markets: Market[];
  tickers: Record<string, MarketTicker>;
  pricesAvailable: boolean;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<string>("All");
  const [favourites, setFavourites] = useState<string[]>([]);

  // Per-viewer convenience only (never authoritative); tolerate private mode.
  // The read is deferred out of the synchronous effect body so the first render
  // matches the server's (empty) and only fills in after mount.
  useEffect(() => {
    let active = true;
    const id = setTimeout(() => {
      if (!active) return;
      try {
        const raw = window.localStorage.getItem(FAVOURITES_KEY);
        if (raw) setFavourites(JSON.parse(raw) as string[]);
      } catch {
        /* ignore */
      }
    }, 0);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, []);

  const toggleFavourite = (symbol: string) => {
    setFavourites((prev) => {
      const next = prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol];
      try {
        window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Quote-currency tabs, derived from what is actually listed.
  const quotes = useMemo(() => {
    const seen = new Set<string>();
    for (const m of markets) seen.add(m.quote);
    return [...seen].sort();
  }, [markets]);

  const tabs = [...BASE_TABS, ...quotes];

  const visible = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return markets.filter((market) => {
      if (tab === "Favorites" && !favourites.includes(market.symbol)) return false;
      if (tab !== "All" && tab !== "Favorites" && market.quote !== tab) return false;
      if (!needle) return true;
      return market.symbol.includes(needle) || market.base.includes(needle) || market.quote.includes(needle);
    });
  }, [markets, query, tab, favourites]);

  return (
    <div className="jc-stack-lg">
      <div className="jc-row-between jc-row-wrap">
        <Segmented
          label="Market category"
          options={tabs.map((t) => ({ value: t, label: t }))}
          value={tab}
          onChange={setTab}
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
        <Table caption="Listed markets with price, 24 hour change, range and volume">
          <thead>
            <tr>
              <Th>
                <span className="jc-sr-only">Favourite</span>
              </Th>
              <Th>Pair</Th>
              <Th numeric>Price</Th>
              <Th numeric>24h</Th>
              <Th numeric>24h High</Th>
              <Th numeric>24h Low</Th>
              <Th numeric>Volume 24h</Th>
              <Th>
                <span className="jc-sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <TableStateRow colSpan={8}>
                <EmptyState
                  title={markets.length === 0 ? "Market listing unavailable" : tab === "Favorites" ? "No favourites yet" : "No markets match"}
                  description={
                    markets.length === 0
                      ? "The pair list could not be loaded. Please try again shortly."
                      : tab === "Favorites"
                        ? "Star a market to pin it here."
                        : "Try a different search term or category."
                  }
                />
              </TableStateRow>
            ) : (
              visible.map((market) => {
                const ticker = tickers[market.symbol];
                const isFav = favourites.includes(market.symbol);
                return (
                  <tr key={market.symbol}>
                    <Td>
                      <button
                        type="button"
                        className={`jc-star ${isFav ? "jc-star--on" : ""}`}
                        aria-pressed={isFav}
                        aria-label={isFav ? `Remove ${market.symbol} from favourites` : `Add ${market.symbol} to favourites`}
                        onClick={() => toggleFavourite(market.symbol)}
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                          <path d="M8 1.8 9.9 5.7l4.3.6-3.1 3 .7 4.3L8 11.6 4.2 13.6l.7-4.3-3.1-3 4.3-.6Z" />
                        </svg>
                      </button>
                    </Td>
                    <Td>
                      <Link href={`/markets/${market.symbol.toLowerCase()}`} className="jc-row jc-link" style={{ gap: "var(--jc-space-3)", alignItems: "center" }}>
                        <AssetIcon symbol={market.base} />
                        <span>
                          <span style={{ fontWeight: 500 }}>{market.base}</span>
                          <span className="jc-muted">/{market.quote}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td numeric>
                      {pricesAvailable && ticker ? (
                        <Price value={parseMoney(ticker.price)} quoteSymbol={market.quote} decimals={market.pricePrecision} />
                      ) : (
                        <span className="jc-muted">—</span>
                      )}
                    </Td>
                    <Td numeric>
                      {pricesAvailable && ticker?.changePercent24h ? (
                        <PriceChange percent={parseMoney(ticker.changePercent24h)} />
                      ) : (
                        <span className="jc-muted">—</span>
                      )}
                    </Td>
                    <Td numeric>
                      {pricesAvailable && ticker?.high24h ? (
                        <Price value={parseMoney(ticker.high24h)} decimals={market.pricePrecision} />
                      ) : (
                        <span className="jc-muted">—</span>
                      )}
                    </Td>
                    <Td numeric>
                      {pricesAvailable && ticker?.low24h ? (
                        <Price value={parseMoney(ticker.low24h)} decimals={market.pricePrecision} />
                      ) : (
                        <span className="jc-muted">—</span>
                      )}
                    </Td>
                    <Td numeric>
                      {pricesAvailable && ticker?.volume24h ? (
                        <span className="jc-numeric jc-muted">{ticker.volume24h} {market.base}</span>
                      ) : (
                        <span className="jc-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      <span style={{ display: "flex", justifyContent: "flex-end", gap: "var(--jc-space-2)" }}>
                        <LinkButton href={`/markets/${market.symbol.toLowerCase()}`} variant="ghost" size="sm">
                          Details
                        </LinkButton>
                        <LinkButton href={`/trade/${market.symbol}`} variant="tertiary" size="sm" disabled={!market.tradingEnabled}>
                          {market.tradingEnabled ? "Trade" : "Unavailable"}
                        </LinkButton>
                      </span>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
