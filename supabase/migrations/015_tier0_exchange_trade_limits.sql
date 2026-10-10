-- =============================================================================
-- JimoCex — 015_tier0_exchange_trade_limits
--
-- Aligns TIER_0 Exchange and Trade ceilings with the approved product spec:
-- USD 5,000 equivalent across all three windows (spec §22).
--
-- The seed in 011 set the SINGLE window to 2,000 while DAILY and MONTHLY were
-- already 5,000. That made the per-transaction ceiling stricter than the
-- product calls for, so in practice only those two rows move:
--
--     SWAP  SINGLE   2,000 -> 5,000
--     TRADE SINGLE   2,000 -> 5,000
--
-- All six rows are written explicitly anyway. A migration that states the whole
-- intended end state is one that can be read on its own later, and re-running it
-- is a no-op either way.
--
-- 011 is left untouched on purpose: an applied migration is history, and editing
-- it would make this database and a freshly migrated one disagree about what
-- happened.
--
-- WITHDRAWALS ARE DELIBERATELY NOT CHANGED. Money leaving the platform is a
-- different risk profile from money moving within it, and the tighter ceilings
-- there (1,000 single / 2,000 daily / 5,000 monthly) stay as they are.
--
-- What this is NOT: an unconditional entitlement to USD 5,000. It is the upper
-- bound the LimitEngine enforces for this tier. RiskEngine, ComplianceGate,
-- jurisdiction rules and per-operation provider requirements all run alongside
-- it and can require verification well before this figure is reached; where
-- they disagree with this table, they win (spec §22, §24).
--
-- Note the shape this produces: with SINGLE, DAILY and MONTHLY all at 5,000, a
-- TIER_0 account can make one maximum-size exchange and has then consumed its
-- month. That follows directly from the specified figures and is left as
-- specified rather than quietly softened here.
-- =============================================================================

update public.tier_limits
set max_amount = 5000
where tier_code = 'TIER_0'
  and operation in ('SWAP', 'TRADE')
  and window_kind in ('SINGLE', 'DAILY', 'MONTHLY');

-- Guard against a silent partial apply: if the seed is ever reordered or a row
-- is missing, this fails the migration rather than leaving the tier half-raised.
do $$
declare
  v_rows integer;
begin
  select count(*) into v_rows
  from public.tier_limits
  where tier_code = 'TIER_0'
    and operation in ('SWAP', 'TRADE')
    and window_kind in ('SINGLE', 'DAILY', 'MONTHLY')
    and max_amount = 5000;

  if v_rows <> 6 then
    raise exception
      'expected 6 TIER_0 Exchange/Trade limit rows at 5000, found %', v_rows
      using errcode = 'check_violation';
  end if;
end;
$$;
