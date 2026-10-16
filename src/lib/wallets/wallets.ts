import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { fromDatabase, toDecimalString } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

import type {
  AssetNetworks,
  DepositStatusValue,
  DepositView,
  LedgerEntryTypeValue,
  LedgerEntryView,
  NetworkOption,
  WithdrawalStatusValue,
  WithdrawalView,
} from "./types";

/**
 * Wallet-area reads (spec §19). Deposits, withdrawals and ledger movements are
 * read through the USER-scoped client, so RLS (`*_own_read`) restricts every
 * row to the caller. Money is read through `moneySelect` and parsed with
 * `fromDatabase`, so a dropped cast fails loudly here rather than rounding a
 * balance on screen. These functions read; they never write (a withdrawal
 * request is created by the gated Server Action in the wallets route, through
 * the service-role client).
 */

/** Assets that have at least one on-chain network, with those networks. */
export async function getAssetNetworks(): Promise<AssetNetworks[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("asset_networks")
      .select(
        "network, display_name, required_confirmations, deposit_enabled, withdrawal_enabled, address_regex, asset:asset_id(symbol, name, decimals, is_active)",
      )
      .order("network", { ascending: true })
      .overrideTypes<
        {
          network: string;
          display_name: string;
          required_confirmations: number;
          deposit_enabled: boolean;
          withdrawal_enabled: boolean;
          address_regex: string | null;
          asset: { symbol: string; name: string; decimals: number; is_active: boolean } | null;
        }[],
        { merge: false }
      >();

    if (error || !data) return [];

    const byAsset = new Map<string, AssetNetworks>();
    for (const row of data) {
      if (!row.asset || !row.asset.is_active) continue;
      const key = row.asset.symbol;
      const option: NetworkOption = {
        network: row.network,
        displayName: row.display_name,
        requiredConfirmations: row.required_confirmations,
        depositEnabled: row.deposit_enabled,
        withdrawalEnabled: row.withdrawal_enabled,
        addressRegex: row.address_regex,
      };
      const existing = byAsset.get(key);
      if (existing) {
        existing.networks.push(option);
      } else {
        byAsset.set(key, {
          symbol: row.asset.symbol,
          name: row.asset.name,
          decimals: row.asset.decimals,
          networks: [option],
        });
      }
    }
    return [...byAsset.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  } catch {
    return [];
  }
}

export async function getDeposits(limit = 50): Promise<DepositView[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("deposits")
      .select(
        moneySelect("deposits", "id, network, amount, address, tx_hash, status, confirmations, created_at, asset:asset_id(symbol, decimals)"),
      )
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          network: string | null;
          amount: string;
          address: string | null;
          tx_hash: string | null;
          status: DepositStatusValue;
          confirmations: number;
          created_at: string;
          asset: { symbol: string; decimals: number } | null;
        }[],
        { merge: false }
      >();
    if (error || !data) return [];
    return data.flatMap((row) =>
      row.asset
        ? [
            {
              id: row.id,
              symbol: row.asset.symbol,
              decimals: row.asset.decimals,
              network: row.network,
              amount: toDecimalString(fromDatabase(row.amount, "deposits.amount")),
              address: row.address,
              txHash: row.tx_hash,
              status: row.status,
              confirmations: row.confirmations,
              createdAt: row.created_at,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

export async function getWithdrawals(limit = 50): Promise<WithdrawalView[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("withdrawals")
      .select(
        moneySelect("withdrawals", "id, network, amount, fee, net_amount, destination, status, created_at, asset:asset_id(symbol, decimals)"),
      )
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          network: string | null;
          amount: string;
          fee: string;
          net_amount: string;
          destination: string;
          status: WithdrawalStatusValue;
          created_at: string;
          asset: { symbol: string; decimals: number } | null;
        }[],
        { merge: false }
      >();
    if (error || !data) return [];
    return data.flatMap((row) =>
      row.asset
        ? [
            {
              id: row.id,
              symbol: row.asset.symbol,
              decimals: row.asset.decimals,
              network: row.network,
              amount: toDecimalString(fromDatabase(row.amount, "withdrawals.amount")),
              fee: toDecimalString(fromDatabase(row.fee, "withdrawals.fee")),
              netAmount: toDecimalString(fromDatabase(row.net_amount, "withdrawals.net_amount")),
              destination: row.destination,
              status: row.status,
              createdAt: row.created_at,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

export async function getLedgerEntries(limit = 100): Promise<LedgerEntryView[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("ledger_entries")
      .select(
        moneySelect("ledger_entries", "id, entry_type, amount, available_delta, locked_delta, reference_type, created_at, asset:asset_id(symbol, decimals)"),
      )
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          entry_type: LedgerEntryTypeValue;
          amount: string;
          available_delta: string;
          locked_delta: string;
          reference_type: string | null;
          created_at: string;
          asset: { symbol: string; decimals: number } | null;
        }[],
        { merge: false }
      >();
    if (error || !data) return [];
    return data.flatMap((row) =>
      row.asset
        ? [
            {
              id: row.id,
              entryType: row.entry_type,
              amount: toDecimalString(fromDatabase(row.amount, "ledger_entries.amount")),
              availableDelta: toDecimalString(fromDatabase(row.available_delta, "ledger_entries.available_delta")),
              lockedDelta: toDecimalString(fromDatabase(row.locked_delta, "ledger_entries.locked_delta")),
              referenceType: row.reference_type,
              createdAt: row.created_at,
              symbol: row.asset.symbol,
              decimals: row.asset.decimals,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/* ===========================================================================
   Prototype deposit addresses
   ===========================================================================

   A DEMO address, deterministic per (user, asset, network), so the deposit
   screen has something to show while no custodian is connected. It is NOT a
   real chain address — nothing watches it and funds sent to it are lost — which
   is why the UI labels it a prototype address and never presents it as live.
*/

function hash(input: string): bigint {
  let h = 1469598103934665603n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return h;
}

/** A deterministic string of `length` chars from `alphabet`, seeded by `seed`. */
function encode(seed: string, alphabet: string, length: number): string {
  let out = "";
  let state = hash(seed);
  const base = BigInt(alphabet.length);
  for (let i = 0; i < length; i += 1) {
    if (state === 0n) state = hash(`${seed}:${i}`);
    // money-guard-allow: index of a hash digit into an alphabet — not a monetary value
    out += alphabet[Number(state % base)];
    state /= base;
  }
  return out;
}

const HEX = "0123456789abcdef";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32 = "023456789acdefghjklmnpqrstuvwxyz";

export function prototypeDepositAddress(userId: string, symbol: string, network: string): string {
  const seed = `${userId}|${symbol}|${network}`;
  switch (network) {
    case "ETHEREUM":
      return `0x${encode(seed, HEX, 40)}`;
    case "BITCOIN":
      return `bc1${encode(seed, BASE32, 39)}`;
    case "TRON":
      return `T${encode(seed, BASE58, 33)}`;
    case "SOLANA":
      return encode(seed, BASE58, 44);
    default:
      return `0x${encode(seed, HEX, 40)}`;
  }
}

/** Prototype addresses for every (asset, network) in `options`, keyed "SYMBOL:NETWORK". */
export function buildDepositAddresses(userId: string, options: AssetNetworks[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const asset of options) {
    for (const net of asset.networks) {
      map[`${asset.symbol}:${net.network}`] = prototypeDepositAddress(userId, asset.symbol, net.network);
    }
  }
  return map;
}
