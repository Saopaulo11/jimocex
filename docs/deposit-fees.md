# Deposit fees: do `deposits.fee` and `deposits.net_amount` belong in the schema?

Status: analysis, no schema change. Decision needed before deposit crediting is built.

## What the schema says today

| | deposits | withdrawals |
|---|---|---|
| amount | `numeric(38,18) not null`, `> 0` | `numeric(38,18) not null`, `> 0` |
| fee | — | `numeric(38,18) not null default 0`, `>= 0`, `< amount` |
| net_amount | — | `generated always as (amount - fee) stored` |

- `fee_rules.operation` (`fee_operation`) includes `DEPOSIT` and `FIAT_DEPOSIT`, so a deposit fee is a
  configurable concept. Both are seeded at `0%` and `0` fixed (011).
- `ledger_entry_type` has `TRADE_FEE` and `SWAP_FEE` but no `DEPOSIT_FEE` (or `WITHDRAWAL_FEE`).
- Nothing reads or writes `deposits` yet: no route, action or engine touches it. Crediting is
  `claim_deposit_for_credit()` followed by `ledger_post('DEPOSIT', amount, …)`, both unused so far.

## Is the owner's list wrong?

For the schema as it stands, yes: `deposits.fee` and `deposits.net_amount` do not exist, and with every
deposit fee configured at zero there is nothing for them to hold. The list most likely mirrors
`withdrawals`, where the fee is taken from the amount at request time and the provider sends the net.

But the gap behind it is real. The fee configuration allows a non-zero deposit fee, and the schema has
nowhere to record one that was charged:

- no column on the deposit row, so the fee applied at crediting time — computed from `fee_rules` that
  can later change — would not be fixed anywhere on the deposit itself;
- no ledger entry type for it, so the platform's revenue leg would have to be an `ADJUSTMENT`.

## Recommendation

Leave the schema as it is for PHASE 4 (no deposit fee is charged, nothing writes deposits).

Before deposit crediting is implemented — and before any deposit row exists — choose one:

1. **Mirror withdrawals (recommended).** `deposits.fee numeric(38,18) not null default 0` with
   `check (fee >= 0 and fee < amount and fee <> 'NaN')`, `net_amount generated always as (amount - fee) stored`,
   fee fixed when the deposit is confirmed; credit `net_amount` and post the fee as its own ledger leg
   with a new `DEPOSIT_FEE` entry type. The deposit row then states, immutably, what was charged.
2. **Ledger only.** Credit the gross `amount`, post a `DEPOSIT_FEE` debit referencing the deposit. No
   new columns, but "what did this deposit cost" becomes a ledger query.

Until one is chosen, a non-zero `DEPOSIT`/`FIAT_DEPOSIT` fee rule must not be activated: the FeeEngine
that would apply it does not exist yet, and when it is written it should refuse a deposit fee the
schema cannot record.
