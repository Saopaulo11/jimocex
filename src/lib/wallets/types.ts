import type { Database } from "@/lib/db/database";

/**
 * Wallet view types shared between the server reads (`wallets.ts`) and the
 * client panels (deposit / withdraw / list). Separate from the server module so
 * a client component can import the shapes without dragging the data layer
 * across the boundary. Every money value is an exact decimal string.
 */

export type DepositStatusValue = Database["public"]["Enums"]["deposit_status"];
export type WithdrawalStatusValue = Database["public"]["Enums"]["withdrawal_status"];
export type LedgerEntryTypeValue = Database["public"]["Enums"]["ledger_entry_type"];

export type WalletHoldingView = {
  symbol: string;
  name: string;
  type: string;
  decimals: number;
  available: string;
  locked: string;
  total: string;
  valueUsd: string | null;
  allocationPercent: string | null;
};

export type NetworkOption = {
  network: string;
  displayName: string;
  requiredConfirmations: number;
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
  addressRegex: string | null;
};

export type AssetNetworks = {
  symbol: string;
  name: string;
  decimals: number;
  networks: NetworkOption[];
};

export type LedgerEntryView = {
  id: string;
  entryType: LedgerEntryTypeValue;
  amount: string;
  availableDelta: string;
  lockedDelta: string;
  referenceType: string | null;
  createdAt: string;
  symbol: string;
  decimals: number;
};

export type DepositView = {
  id: string;
  symbol: string;
  decimals: number;
  network: string | null;
  amount: string;
  address: string | null;
  txHash: string | null;
  status: DepositStatusValue;
  confirmations: number;
  createdAt: string;
};

export type WithdrawalView = {
  id: string;
  symbol: string;
  decimals: number;
  network: string | null;
  amount: string;
  fee: string;
  netAmount: string;
  destination: string;
  status: WithdrawalStatusValue;
  createdAt: string;
};
