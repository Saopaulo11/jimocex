import type { Metadata } from "next";

import { Card, CardContent, LinkButton } from "@/components/ui";
import { getOpenOrders } from "@/lib/trade/account";
import { getOrderHistory, getTradeHistory } from "@/lib/trade/history";

import { OrdersTabs } from "./OrdersTabs";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage() {
  const [open, history, trades] = await Promise.all([getOpenOrders(), getOrderHistory(), getTradeHistory()]);

  return (
    <div className="jc-container jc-stack-lg">
      <header className="jc-row-between jc-row-wrap">
        <div>
          <p className="jc-eyebrow">Orders</p>
          <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
            Your orders
          </h1>
        </div>
        <LinkButton href="/trade" variant="primary" size="sm">
          New order
        </LinkButton>
      </header>

      <Card>
        <CardContent>
          <OrdersTabs open={open} history={history} trades={trades} />
        </CardContent>
      </Card>
    </div>
  );
}
