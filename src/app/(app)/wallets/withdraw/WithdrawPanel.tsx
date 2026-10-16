"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, AmountInput, Button, Input, Select } from "@/components/ui";
import type { AssetNetworks } from "@/lib/wallets/types";

import { requestWithdrawalAction, type WithdrawResult } from "../actions";

/**
 * Withdraw panel (prototype).
 *
 * The browser sends only the asset, network, destination and the amount as a
 * string — never a user id, a fee or a status. The server parses the amount to
 * exact Money, checks it against the ledger balance, and records a REQUESTED
 * row. No payout provider is connected, so nothing is sent and the request is
 * never auto-completed; the panel says so.
 */
export function WithdrawPanel({
  assets,
  balances,
}: {
  assets: AssetNetworks[];
  /** symbol → { available (decimal string), decimals }. */
  balances: Record<string, { available: string; decimals: number }>;
}) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(assets[0]?.symbol ?? "");
  const asset = useMemo(() => assets.find((a) => a.symbol === symbol) ?? assets[0], [assets, symbol]);
  const [network, setNetwork] = useState(asset?.networks[0]?.network ?? "");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WithdrawResult | null>(null);

  const available = balances[symbol]?.available ?? "0";

  const onAssetChange = (next: string) => {
    setSymbol(next);
    const nextAsset = assets.find((a) => a.symbol === next);
    setNetwork(nextAsset?.networks[0]?.network ?? "");
    setResult(null);
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await requestWithdrawalAction({ assetSymbol: symbol, network, destination, amountInput: amount });
      setResult(res);
      if (res.ok) {
        setAmount("");
        setDestination("");
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (assets.length === 0) {
    return (
      <Alert tone="info" title="No withdrawal networks configured">
        No asset networks are available on this deployment.
      </Alert>
    );
  }

  return (
    <form className="jc-stack-lg" style={{ maxWidth: 480 }} onSubmit={onSubmit}>
      <Select id="withdraw-asset" label="Asset" value={symbol} onChange={(e) => onAssetChange(e.target.value)}>
        {assets.map((a) => (
          <option key={a.symbol} value={a.symbol}>
            {a.symbol} — {a.name}
          </option>
        ))}
      </Select>

      <Select id="withdraw-network" label="Network" value={network} onChange={(e) => setNetwork(e.target.value)}>
        {(asset?.networks ?? []).map((n) => (
          <option key={n.network} value={n.network}>
            {n.displayName}
          </option>
        ))}
      </Select>

      <Input
        id="withdraw-destination"
        label="Destination address"
        placeholder="Recipient address"
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />

      <AmountInput
        id="withdraw-amount"
        label="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
        assetSlot={<span className="jc-amount-asset">{symbol}</span>}
        secondary={<span className="jc-muted">Available: {available} {symbol}</span>}
      />

      <div className="jc-summary">
        <div className="jc-summary-row">
          <span className="jc-summary-key">Network fee</span>
          <span className="jc-summary-val jc-muted">Set by provider at processing</span>
        </div>
        <div className="jc-summary-row jc-summary-row--total">
          <span className="jc-summary-key">You receive</span>
          <span className="jc-summary-val">{amount || "0"} {symbol}</span>
        </div>
      </div>

      {result && !result.ok ? (
        <Alert tone="danger" title="Could not create the request">
          {result.message}
        </Alert>
      ) : null}
      {result && result.ok ? (
        <Alert tone="success" title="Withdrawal request recorded">
          Your request is <strong>Requested</strong> and awaiting review. No payout provider is connected on this
          deployment, so nothing has been sent and no funds have moved.
        </Alert>
      ) : null}

      <Button type="submit" variant="primary" block size="lg" loading={submitting} disabled={submitting}>
        Request withdrawal
      </Button>

      <p className="jc-caption">
        A request is reviewed before any funds move. This deployment has no payout provider, so a request is recorded
        and never completed automatically.
      </p>
    </form>
  );
}
