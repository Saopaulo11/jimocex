-- =============================================================================
-- JimoCex - 021_enable_demo_trading
--
-- Enables LIMIT order placement on the demo trading set, and only on it:
--
--     BTC-USDT, ETH-USDT, SOL-USDT     trading_enabled   false -> true
--
-- What that turns on: an order can be placed - place_limit_order (018) opens
-- it OPEN and posts one HOLD of its reserve - and cancelled - cancel_order
-- posts one RELEASE of what is still held.
--
-- What it does NOT turn on: execution. No execution provider is connected,
-- nothing calls apply_fill (020), and no trade row is written. An order rests
-- OPEN until it is cancelled.
--
-- Nothing else changes. swap_enabled stays false on every pair, the other 13
-- pairs stay disabled (and place_limit_order keeps refusing them), and no
-- precision, size limit, fee, asset, balance, ledger entry or order column is
-- touched.
--
-- 011 is left untouched on purpose: an applied migration is history.
--
-- Fail-closed: if any of the three pairs is missing (011 not applied, or a
-- symbol renamed), the migration raises before the update and changes nothing,
-- rather than enabling a subset.
--
-- Re-running it is a no-op for the flags; the trading_pairs_touch trigger (003)
-- still moves updated_at on the three rows.
--
-- Rollback. This repository has no down migrations; the reverse is a separate,
-- reviewed statement:
--
--     update public.trading_pairs
--     set trading_enabled = false
--     where symbol in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT');
--
-- An order already OPEN on these pairs stays cancellable after a rollback:
-- cancel_order does not read the pair's flag, and releases the hold either way.
-- =============================================================================

do $$
declare
  v_found integer;
begin
  select count(*) into v_found
  from public.trading_pairs
  where symbol in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT');

  if v_found <> 3 then
    raise exception '021: expected the pairs BTC-USDT, ETH-USDT and SOL-USDT, found % of them', v_found
      using errcode = 'no_data_found';
  end if;
end;
$$;

update public.trading_pairs
set trading_enabled = true
where symbol in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT');
