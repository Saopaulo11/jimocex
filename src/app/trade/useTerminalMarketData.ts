"use client";

import { useEffect, useState } from "react";

import { MARKET_DATA_REFRESH_MS, type TerminalMarketData } from "@/lib/markets/types";

/**
 * Keeps the terminal's market data fresh while the page is open.
 *
 * Only for the public market-data source (`kind === "live"`): demo data moves
 * once a day and "unavailable" has nothing to refresh. One request every
 * MARKET_DATA_REFRESH_MS, skipped while the tab is hidden, each with its own
 * timeout, aborted on unmount or pair change — never a retry loop. The server
 * caches and merges upstream calls, so polling clients do not multiply them.
 *
 * A failed refresh clears the figures (the sections show "temporarily
 * unavailable") rather than leaving stale prices on screen as if current. A new
 * server render (navigation, or the refresh after placing an order) replaces
 * whatever was polled.
 *
 * Display data only: nothing here reaches the order form's arithmetic, which is
 * computed on the server by the order engine.
 */

const REQUEST_TIMEOUT_MS = 8_000;

/** The honest state after a refresh failed: no market figures, everything else kept. */
function withoutFigures(data: TerminalMarketData): TerminalMarketData {
  return { ...data, tickers: {}, selectedTicker: null, chartCloses: [], book: null, asOf: null };
}

type Polled = {
  /** The server render this refresh followed; a newer render replaces it. */
  base: TerminalMarketData;
  /** Null when the latest refresh failed. */
  data: TerminalMarketData | null;
};

export function useTerminalMarketData(initial: TerminalMarketData): TerminalMarketData {
  const [polled, setPolled] = useState<Polled | null>(null);

  useEffect(() => {
    const pair = initial.pair;
    if (initial.kind !== "live" || pair === null) return;

    let disposed = false;
    let inFlight: AbortController | null = null;

    const refresh = async (): Promise<void> => {
      if (document.visibilityState !== "visible") return;
      inFlight?.abort();
      const request = new AbortController();
      inFlight = request;
      const timer = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/market-data/terminal?pair=${encodeURIComponent(pair)}`, {
          cache: "no-store",
          signal: request.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as TerminalMarketData;
        if (disposed || inFlight !== request) return;
        setPolled({ base: initial, data: data.pair === pair ? data : null });
      } catch {
        // An abort from unmounting or a newer request is not a failure to show.
        if (disposed || inFlight !== request) return;
        setPolled({ base: initial, data: null });
      } finally {
        clearTimeout(timer);
      }
    };

    const interval = setInterval(() => void refresh(), MARKET_DATA_REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(interval);
      inFlight?.abort();
    };
  }, [initial]);

  if (polled === null || polled.base !== initial) return initial;
  return polled.data ?? withoutFigures(initial);
}
