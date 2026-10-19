import type { NextRequest } from "next/server";

import { getTerminalMarketData } from "@/lib/markets/ticker";

/**
 * GET /api/market-data/terminal?pair=BTC-USDT — the trading terminal's periodic
 * market-data refresh.
 *
 * Read-only and public: it returns the same display data the page rendered
 * (ticker list, selected price, chart closes, order book), all as exact decimal
 * strings, and nothing else. It takes no session, reads no account data and
 * writes nothing. The only input is a pair symbol in the platform's own format;
 * which upstream host is called, and for which symbols, is fixed in the
 * provider — a request can never choose a URL. Upstream calls are cached and
 * merged in the provider, so polling clients do not multiply them.
 */

const PAIR = /^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$/;

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<Response> {
  const pair = request.nextUrl.searchParams.get("pair");
  if (pair === null || !PAIR.test(pair)) {
    return Response.json({ error: "pair must look like BTC-USDT" }, { status: 400, headers: NO_STORE });
  }
  const data = await getTerminalMarketData(pair);
  return Response.json(data, { headers: NO_STORE });
}
