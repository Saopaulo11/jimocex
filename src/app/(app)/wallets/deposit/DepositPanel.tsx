"use client";

import { useMemo, useState } from "react";

import { Alert, Button, Select } from "@/components/ui";
import type { AssetNetworks } from "@/lib/wallets/types";

/**
 * Deposit panel (prototype).
 *
 * The address shown is a DETERMINISTIC PROTOTYPE address, not a live chain
 * address — nothing watches it and funds sent to it are lost. The panel says so
 * plainly: no custodian is connected on this deployment. It writes nothing; it
 * only shows what a deposit screen would look like.
 */
export function DepositPanel({
  assets,
  addresses,
}: {
  assets: AssetNetworks[];
  /** Keyed "SYMBOL:NETWORK". */
  addresses: Record<string, string>;
}) {
  const [symbol, setSymbol] = useState(assets[0]?.symbol ?? "");
  const asset = useMemo(() => assets.find((a) => a.symbol === symbol) ?? assets[0], [assets, symbol]);
  const [network, setNetwork] = useState(asset?.networks[0]?.network ?? "");
  const [copied, setCopied] = useState(false);

  const activeNetwork = asset?.networks.find((n) => n.network === network) ?? asset?.networks[0];
  const address = asset && activeNetwork ? addresses[`${asset.symbol}:${activeNetwork.network}`] ?? "" : "";

  const onAssetChange = (next: string) => {
    setSymbol(next);
    const nextAsset = assets.find((a) => a.symbol === next);
    setNetwork(nextAsset?.networks[0]?.network ?? "");
    setCopied(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (assets.length === 0) {
    return (
      <Alert tone="info" title="No deposit networks configured">
        No asset networks are available on this deployment.
      </Alert>
    );
  }

  return (
    <div className="jc-stack-lg" style={{ maxWidth: 480 }}>
      <Select id="deposit-asset" label="Asset" value={symbol} onChange={(e) => onAssetChange(e.target.value)}>
        {assets.map((a) => (
          <option key={a.symbol} value={a.symbol}>
            {a.symbol} — {a.name}
          </option>
        ))}
      </Select>

      <Select
        id="deposit-network"
        label="Network"
        value={activeNetwork?.network ?? ""}
        onChange={(e) => {
          setNetwork(e.target.value);
          setCopied(false);
        }}
      >
        {(asset?.networks ?? []).map((n) => (
          <option key={n.network} value={n.network}>
            {n.displayName}
          </option>
        ))}
      </Select>

      <div className="jc-stack">
        <span className="jc-label">Deposit address</span>
        <div className="jc-address">
          <code className="jc-address-value">{address}</code>
          <Button type="button" variant="tertiary" size="sm" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {activeNetwork ? (
          <p className="jc-caption">
            {activeNetwork.displayName} · {activeNetwork.requiredConfirmations} confirmations required before a real
            deposit would be credited.
          </p>
        ) : null}
      </div>

      <Alert tone="warning" title="Prototype address — do not send real funds">
        No custodian is connected on this deployment, so this is a demonstration address generated for the interface.
        It is not monitored on any blockchain, and anything sent to it cannot be recovered or credited.
      </Alert>
    </div>
  );
}
