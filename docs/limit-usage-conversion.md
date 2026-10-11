# Limit usage: how the USD equivalent is fixed, and whether it can be reproduced

Status: analysis and proposed migration. Not applied — needs approval.

## How it works today

1. `checkEligibility()` values the operation in the limit currency (`tier_limits.quote_currency`,
   seeded `USD` everywhere):
   - identity (asset = limit currency): the amount itself, exact;
   - otherwise `amount × rate`, where `rate` is `MarketDataProvider.getTicker("<ASSET>-<CCY>").price`.
     With no provider configured the answer is `UNAVAILABLE` — never a guessed rate.
   The product is rounded **up** to 18 places (`valueInLimitCurrency`), so an operation is never
   charged against a ceiling as smaller than it is.
2. Window usage is `limit_usage_total()`: an exact `numeric` sum of `limit_usage.usd_equivalent` for
   the user, operation, currency and window, returned as text.
3. When an operation is authorised, a `limit_usage` row is meant to record its value
   (`usd_equivalent`, `quote_currency`, `rate_source`, `reference_type/id`, `occurred_at`).
   Nothing writes these rows yet (0 rows on the hosted project).

## Is the calculation correct?

Yes. The value is fixed once, at authorisation, and never recomputed; every later window sums the
stored figures exactly. A rate that moves afterwards cannot change a past decision or a window's total.

## Is it reproducible?

No — and 014's header claims it is ("an audit a year later reconstructs the same answer"). From a
`limit_usage` row one can recover the operation (via `reference_type/id`) and therefore the original
amount and asset, but not:

- the **rate** that turned it into `usd_equivalent` — it is not stored anywhere (`swap_orders.rate` is
  the swap's own rate between its two assets, not the USD conversion);
- **when** that rate was quoted (`ticker.asOf`);
- for a withdrawal or deposit, the amount and asset at authorisation if the row they reference later
  changes status or is corrected.

So an auditor can see that a user consumed 4,990 USD of their daily limit, but cannot verify that
4,990 was the right value for the operation.

## Proposed minimal fix (migration, before the first writer)

Store the inputs of the conversion next to its result, and make the database check that they agree.
`limit_usage` is empty on the hosted project, so the columns can be `not null` without a backfill.

```sql
alter table public.limit_usage
  add column source_asset    text not null references public.assets (symbol) on update cascade on delete restrict,
  add column source_amount   numeric(38, 18) not null,
  add column conversion_rate numeric(38, 18) not null,
  add column rate_as_of      timestamptz not null,
  add constraint limit_usage_source_amount_positive check (source_amount > 0 and source_amount <> 'NaN'::numeric),
  add constraint limit_usage_rate_positive         check (conversion_rate > 0 and conversion_rate <> 'NaN'::numeric),
  -- Identity conversions are exactly 1, with no provider involved.
  add constraint limit_usage_identity_rate         check (source_asset <> quote_currency or conversion_rate = 1),
  -- usd_equivalent is source_amount × conversion_rate rounded UP to 18 places — the rule
  -- valueInLimitCurrency() applies — so the stored figure can always be re-derived and checked.
  add constraint limit_usage_equivalent_derived    check (
    usd_equivalent >= source_amount * conversion_rate
    and usd_equivalent < source_amount * conversion_rate + 0.000000000000000001
  );
```

Application side (with the migration): `checkEligibility()` returns the conversion it used
(`{ rate, source, asOf }`) alongside the decision, and the writer of `limit_usage` stores exactly that
— through `moneyInsert("limit_usage", …)`, which already range- and scale-checks the new money
columns once they are added to `MONEY_COLUMNS`.

Recommendation: apply it as migration 018 before the first code path writes `limit_usage`.
