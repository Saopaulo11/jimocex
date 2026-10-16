"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelOrderAction } from "@/app/trade/actions";
import { Alert, Button } from "@/components/ui";

/**
 * Cancel one order from its detail page. Calls the same atomic `cancel_order`
 * path as the Open Orders panel; on success it refreshes so the released hold
 * and the CANCELLED status come from the database, not local state.
 */
export function CancelOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onCancel = () => {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof cancelOrderAction>>;
      try {
        result = await cancelOrderAction(orderId);
      } catch {
        // No answer: the cancel may or may not have happened. Re-read the order.
        setError("We could not confirm the cancellation. The page now shows the order's current status.");
        router.refresh();
        return;
      }
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="jc-stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button variant="secondary" size="sm" onClick={onCancel} loading={pending} loadingLabel="Cancelling" disabled={pending}>
        Cancel order
      </Button>
    </div>
  );
}
