-- =============================================================================
-- JimoCex — test scaffolding: a 021 database with activity like the Preview's
--
-- Applied by scripts/test-db.sh to a throwaway database built from 001–021,
-- before the 021 → 022 upgrade package (supabase/drafts/upgrade_021_022) runs
-- against it. Never applied to a hosted project.
--
-- What it creates, through the same functions the application and the Preview
-- runbook use:
--   * two users (auth.users; 001's trigger creates their profiles);
--   * opening balances as scripts/fund-demo-account.ts posts them
--     (DEPOSIT, reference_type demo_funding);
--   * resting LIMIT orders, BUY and SELL, on two of 021's demo pairs (OPEN, funds held);
--   * an order placed and cancelled by its owner (CANCELLED, held and released);
--   * an order filled through 020's apply_fill, which 021 still allows on an
--     OPEN order (FILLED, one trade, price-improvement residual released).
-- =============================================================================

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000021a1', 'upgrade-demo-1@test.invalid'),
  ('00000000-0000-4000-8000-0000000021a2', 'upgrade-demo-2@test.invalid');

do $$
declare
  u1   uuid := '00000000-0000-4000-8000-0000000021a1';
  u2   uuid := '00000000-0000-4000-8000-0000000021a2';
  usdt uuid := (select id from public.assets where symbol = 'USDT');
  btc  uuid := (select id from public.assets where symbol = 'BTC');
  eth  uuid := (select id from public.assets where symbol = 'ETH');
  btcp uuid := (select id from public.trading_pairs where symbol = 'BTC-USDT');
  ethp uuid := (select id from public.trading_pairs where symbol = 'ETH-USDT');
  o    uuid;
begin
  perform public.ledger_post(u1, usdt, 'DEPOSIT', 10000, 10000, 0, 'demo_funding', null, 'fixture-021:' || u1 || ':USDT');
  perform public.ledger_post(u1, btc, 'DEPOSIT', 1, 1, 0, 'demo_funding', null, 'fixture-021:' || u1 || ':BTC');
  perform public.ledger_post(u1, eth, 'DEPOSIT', 10, 10, 0, 'demo_funding', null, 'fixture-021:' || u1 || ':ETH');
  perform public.ledger_post(u2, usdt, 'DEPOSIT', 5000, 5000, 0, 'demo_funding', null, 'fixture-021:' || u2 || ':USDT');

  perform public.place_limit_order(u1, btcp, 'BUY', 60000, 0.01, usdt, 601.2, 'fixture-open-buy', 1.2);
  perform public.place_limit_order(u1, btcp, 'SELL', 90000, 0.02, btc, 0.02, 'fixture-open-sell', 0);
  perform public.place_limit_order(u1, ethp, 'SELL', 4000, 0.5, eth, 0.5, 'fixture-open-eth', 0);

  o := public.place_limit_order(u1, btcp, 'BUY', 80000, 0.001, usdt, 80.16, 'fixture-cancelled', 0.16);
  if not public.cancel_order(u1, o) then raise exception 'fixture: cancel refused'; end if;

  o := public.place_limit_order(u2, btcp, 'BUY', 80000, 0.01, usdt, 801.6, 'fixture-filled', 1.6);
  perform public.apply_fill(o, 'fixture-021-trade-1', 0.01, 799, 79900, 1.598, usdt, now());
end;
$$;
