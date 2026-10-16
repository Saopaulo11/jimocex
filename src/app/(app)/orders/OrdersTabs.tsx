"use client";

import { useState } from "react";

import { OpenOrders } from "@/app/trade/OpenOrders";
import { OrdersTable, TradesTable } from "@/components/trade";
import { Segmented } from "@/components/ui";
import type { OrderRow, TradeRow } from "@/lib/trade/history";
import type { OpenOrderView } from "@/lib/trade/types";

type Tab = "open" | "history" | "trades";

/**
 * The Orders view, in three tabs. The data is loaded and RLS-scoped on the
 * server; this only chooses which panel is shown. Open orders reuse the same
 * cancel-capable panel as the trade terminal, so there is one cancel path.
 */
export function OrdersTabs({
  open,
  history,
  trades,
}: {
  open: OpenOrderView[];
  history: OrderRow[];
  trades: TradeRow[];
}) {
  const [tab, setTab] = useState<Tab>("open");

  return (
    <div className="jc-stack">
      <Segmented<Tab>
        label="Order view"
        options={[
          { value: "open", label: `Open orders (${open.length})` },
          { value: "history", label: "Order history" },
          { value: "trades", label: "Trade history" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "open" ? (
        <OpenOrders orders={open} />
      ) : tab === "history" ? (
        <OrdersTable
          rows={history}
          caption="Your order history"
          emptyTitle="No past orders"
          emptyDescription="Orders that have filled, been cancelled, or expired will appear here."
        />
      ) : (
        <TradesTable rows={trades} caption="Your trade history" />
      )}
    </div>
  );
}
