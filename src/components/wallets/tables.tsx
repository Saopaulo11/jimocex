import Link from "next/link";

import {
  AssetIcon,
  CurrencyAmount,
  DepositStatus,
  WithdrawalStatus,
} from "@/components/financial";
import { Table, TableStateRow, Td, Th, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { parseMoney } from "@/lib/money";
import type {
  DepositView,
  LedgerEntryView,
  WalletHoldingView,
  WithdrawalView,
} from "@/lib/wallets/types";

/** Shorten a long opaque string (an address) so a table row stays readable. */
function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const LEDGER_LABEL: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRADE: "Trade",
  TRADE_FEE: "Trade fee",
  SWAP: "Exchange",
  SWAP_FEE: "Exchange fee",
  HOLD: "Hold",
  RELEASE: "Release",
  ADJUSTMENT: "Adjustment",
};

/* ---------------------------------------------------------------- holdings */

export function HoldingsTable({
  rows,
  showActions = false,
}: {
  rows: WalletHoldingView[];
  showActions?: boolean;
}) {
  return (
    <Table caption="Your balances by asset">
      <thead>
        <tr>
          <Th>Asset</Th>
          <Th numeric>Available</Th>
          <Th numeric>Locked</Th>
          <Th numeric>Total</Th>
          <Th numeric>Value (USD)</Th>
          {showActions ? <Th>{""}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <TableStateRow colSpan={showActions ? 6 : 5}>
            <EmptyState title="No balances" description="Assets you hold will appear here after your first deposit or exchange." />
          </TableStateRow>
        ) : (
          rows.map((h) => (
            <tr key={h.symbol}>
              <Td>
                <span className="jc-row" style={{ gap: "var(--jc-space-3)", alignItems: "center" }}>
                  <AssetIcon symbol={h.symbol} />
                  <span>
                    <Link href={`/assets/${h.symbol.toLowerCase()}`} className="jc-link">
                      {h.symbol}
                    </Link>
                    <span className="jc-caption" style={{ display: "block" }}>
                      {h.name}
                    </span>
                  </span>
                </span>
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(h.available)} symbol={h.symbol} decimals={h.decimals} size="sm" />
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(h.locked)} symbol={h.symbol} decimals={h.decimals} size="sm" />
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(h.total)} symbol={h.symbol} decimals={h.decimals} size="sm" />
              </Td>
              <Td numeric>
                {h.valueUsd === null ? (
                  <span className="jc-muted">—</span>
                ) : (
                  <CurrencyAmount value={parseMoney(h.valueUsd)} symbol="USD" decimals={2} size="sm" />
                )}
              </Td>
              {showActions ? (
                <Td>
                  <span className="jc-row" style={{ gap: "var(--jc-space-3)", justifyContent: "flex-end" }}>
                    <Link href="/wallets/deposit" className="jc-link">Deposit</Link>
                    <Link href="/wallets/withdraw" className="jc-link">Withdraw</Link>
                  </span>
                </Td>
              ) : null}
            </tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

/* ---------------------------------------------------------------- deposits */

export function DepositsTable({ rows }: { rows: DepositView[] }) {
  return (
    <Table caption="Deposit history">
      <thead>
        <tr>
          <Th>Asset</Th>
          <Th>Network</Th>
          <Th numeric>Amount</Th>
          <Th>Status</Th>
          <Th>Address</Th>
          <Th>Date</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <TableStateRow colSpan={6}>
            <EmptyState title="No deposits yet" description="Incoming deposits will appear here once a custodian is connected." />
          </TableStateRow>
        ) : (
          rows.map((d) => (
            <tr key={d.id}>
              <Td>{d.symbol}</Td>
              <Td>
                <span className="jc-muted">{d.network ?? "—"}</span>
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(d.amount)} symbol={d.symbol} decimals={d.decimals} size="sm" />
              </Td>
              <Td>
                <DepositStatus status={d.status} />
              </Td>
              <Td>
                <span className="jc-numeric jc-caption">{d.address ? truncateMiddle(d.address) : "—"}</span>
              </Td>
              <Td>
                <span className="jc-caption">{formatDateTime(d.createdAt)}</span>
              </Td>
            </tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

/* ------------------------------------------------------------- withdrawals */

export function WithdrawalsTable({ rows }: { rows: WithdrawalView[] }) {
  return (
    <Table caption="Withdrawal history">
      <thead>
        <tr>
          <Th>Asset</Th>
          <Th>Network</Th>
          <Th numeric>Amount</Th>
          <Th>Destination</Th>
          <Th>Status</Th>
          <Th>Date</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <TableStateRow colSpan={6}>
            <EmptyState title="No withdrawals yet" description="Withdrawal requests you create will appear here." />
          </TableStateRow>
        ) : (
          rows.map((w) => (
            <tr key={w.id}>
              <Td>{w.symbol}</Td>
              <Td>
                <span className="jc-muted">{w.network ?? "—"}</span>
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(w.amount)} symbol={w.symbol} decimals={w.decimals} size="sm" />
              </Td>
              <Td>
                <span className="jc-numeric jc-caption">{truncateMiddle(w.destination)}</span>
              </Td>
              <Td>
                <WithdrawalStatus status={w.status} />
              </Td>
              <Td>
                <span className="jc-caption">{formatDateTime(w.createdAt)}</span>
              </Td>
            </tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

/* ----------------------------------------------------------------- ledger */

export function LedgerTable({ rows }: { rows: LedgerEntryView[] }) {
  return (
    <Table caption="Ledger movements">
      <thead>
        <tr>
          <Th>Type</Th>
          <Th>Asset</Th>
          <Th numeric>Available Δ</Th>
          <Th numeric>Locked Δ</Th>
          <Th>Date</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <TableStateRow colSpan={5}>
            <EmptyState title="No movements yet" description="Every balance change is recorded here once your first operation settles." />
          </TableStateRow>
        ) : (
          rows.map((e) => (
            <tr key={e.id}>
              <Td>{LEDGER_LABEL[e.entryType] ?? e.entryType}</Td>
              <Td>{e.symbol}</Td>
              <Td numeric>
                <span className="jc-numeric">{e.availableDelta} {e.symbol}</span>
              </Td>
              <Td numeric>
                <span className="jc-numeric">{e.lockedDelta} {e.symbol}</span>
              </Td>
              <Td>
                <span className="jc-caption">{formatDateTime(e.createdAt)}</span>
              </Td>
            </tr>
          ))
        )}
      </tbody>
    </Table>
  );
}
