-- =============================================================================
-- JimoCex — financial invariant suite (spec §71)
--
-- Every assertion here is a rule from spec §19 or §47, checked against a real
-- PostgreSQL cluster with the real migrations and the real RLS policies
-- applied. These are not unit tests of application code: they prove that the
-- DATABASE refuses the forbidden operation, which is the only guarantee that
-- survives a bug in a route handler.
--
-- The whole run happens inside one transaction that is rolled back, so the suite
-- leaves no balances, no orders and no users behind.
--
-- Exits non-zero on any failure when run with `psql -v ON_ERROR_STOP=1`.
-- =============================================================================

\set QUIET on
\timing off
begin;

create temporary table test_results (
  seq     serial,
  name    text not null,
  passed  boolean not null,
  detail  text
) on commit drop;

-- The RLS section runs under `authenticated` and `anon`. Without this grant the
-- suite cannot record its own results once the role switches, and the run dies
-- halfway through with a privilege error instead of a report.
grant select, insert, update on test_results to public;
grant usage, select on sequence test_results_seq_seq to public;

-- Records a PASS when `p_sql` is rejected, and a FAIL when it is allowed.
-- Used for every "must be impossible" rule, so the test asserts the refusal
-- rather than asserting our belief about the refusal.
create function pg_temp.rejects(p_name text, p_sql text) returns void
language plpgsql as $fn$
begin
  begin
    execute p_sql;
    insert into test_results (name, passed, detail)
    values (p_name, false, 'statement was ACCEPTED but must be rejected');
  exception when others then
    insert into test_results (name, passed, detail) values (p_name, true, sqlerrm);
  end;
end;
$fn$;

-- A forbidden write can be refused two different ways, and both are correct:
-- the GRANT layer raises "permission denied", or RLS silently matches no row.
-- Asserting one specific mechanism would make the suite fragile against a
-- hardening change that is strictly an improvement, so this asserts the only
-- thing that matters: afterwards, nothing changed.
create function pg_temp.no_effect(p_name text, p_sql text, p_check text) returns void
language plpgsql as $fn$
declare
  v_unchanged boolean;
begin
  begin
    execute p_sql;
  exception when others then
    null;  -- refused outright; the check below confirms nothing moved
  end;
  execute p_check into v_unchanged;
  insert into test_results (name, passed, detail)
  values (p_name, coalesce(v_unchanged, false),
          case when coalesce(v_unchanged, false) then null
               else 'the forbidden write TOOK EFFECT' end);
end;
$fn$;

-- The mirror of no_effect, for the handful of writes a user is supposed to be
-- able to make. A suite that only proves refusals would pass just as well on a
-- database that refuses everything.
create function pg_temp.takes_effect(p_name text, p_sql text, p_check text) returns void
language plpgsql as $fn$
declare
  v_applied boolean;
  v_err     text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  execute p_check into v_applied;
  insert into test_results (name, passed, detail)
  values (p_name, coalesce(v_applied, false),
          case when coalesce(v_applied, false) then null
               else coalesce('permitted write was REFUSED: ' || v_err, 'permitted write did not apply') end);
end;
$fn$;

create function pg_temp.holds(p_name text, p_condition boolean) returns void
language plpgsql as $fn$
begin
  insert into test_results (name, passed, detail)
  values (p_name, coalesce(p_condition, false),
          case when coalesce(p_condition, false) then null else 'condition was false' end);
end;
$fn$;

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'alice@test.invalid'),
  ('00000000-0000-4000-8000-0000000000b2', 'bob@test.invalid');

-- =============================================================================
-- §8, §25.1 — a new account lands on TIER_0, ACTIVE, unverified
--
-- Not set by the application: the on_auth_user_created trigger writes the
-- profile, so there is no code path on which a client could choose its own
-- starting tier.
-- =============================================================================

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
begin
  perform pg_temp.holds('§25.1 a new user is created at TIER_0',
    (select tier_code = 'TIER_0' from public.profiles where user_id = a));
  perform pg_temp.holds('§8 a new user is ACTIVE',
    (select status = 'ACTIVE' from public.profiles where user_id = a));
  perform pg_temp.holds('§23 a new user starts with KYC NOT_STARTED',
    (select kyc_status = 'NOT_STARTED' from public.profiles where user_id = a));
  perform pg_temp.holds('§8 the signup trigger created exactly one profile',
    (select count(*) = 1 from public.profiles where user_id = a));
end;
$$;

-- =============================================================================
-- §19.1, §19.2, §19.3, §18 — ledger and wallet core
-- =============================================================================

do $$
declare
  a    uuid := '00000000-0000-4000-8000-0000000000a1';
  usdt uuid;
begin
  select id into usdt from public.assets where symbol = 'USDT';

  perform public.ledger_post(a, usdt, 'DEPOSIT', 1000, 1000, 0, 'test', null, 'tst:deposit');
  perform pg_temp.holds('deposit credits available balance',
    (select available_balance = 1000 from public.wallets where user_id = a and asset_id = usdt));

  perform pg_temp.rejects('§19.1 available balance cannot go negative', format(
    $q$ select public.ledger_post(%L, %L, 'WITHDRAWAL', 1500, -1500, 0, 'test', null, 'tst:overdraw') $q$, a, usdt));

  perform pg_temp.rejects('§19.2 locked balance cannot go negative', format(
    $q$ select public.ledger_post(%L, %L, 'RELEASE', 50, 50, -50, 'test', null, 'tst:rel0') $q$, a, usdt));

  perform public.ledger_post(a, usdt, 'HOLD', 400, -400, 400, 'test', null, 'tst:hold');
  perform pg_temp.holds('hold moves available to locked, total unchanged',
    (select available_balance = 600 and locked_balance = 400
       from public.wallets where user_id = a and asset_id = usdt));

  perform pg_temp.rejects('§19.3 locked funds cannot be spent', format(
    $q$ select public.ledger_post(%L, %L, 'WITHDRAWAL', 700, -700, 0, 'test', null, 'tst:spendlocked') $q$, a, usdt));

  perform pg_temp.rejects('§18 ledger entry cannot be updated',
    $q$ update public.ledger_entries set amount = 999999 where dedup_key = 'tst:deposit' $q$);

  perform pg_temp.rejects('§18 ledger entry cannot be deleted',
    $q$ delete from public.ledger_entries where dedup_key = 'tst:deposit' $q$);

  perform pg_temp.rejects('§19.5 duplicate posting of one operation rejected', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 1000, 1000, 0, 'test', null, 'tst:deposit') $q$, a, usdt));

  perform pg_temp.rejects('entry that moves nothing rejected', format(
    $q$ select public.ledger_post(%L, %L, 'ADJUSTMENT', 10, 0, 0, 'test', null, 'tst:noop') $q$, a, usdt));

  perform pg_temp.rejects('negative amount rejected', format(
    $q$ select public.ledger_post(%L, %L, 'ADJUSTMENT', -10, -10, 0, 'test', null, 'tst:neg') $q$, a, usdt));

  perform pg_temp.holds('§19.10 ledger reconciles with wallet balances',
    (select count(*) = 0 from public.reconcile_wallets()));
end;
$$;

-- =============================================================================
-- §19.8, §19.9 — order status is one-way into a terminal state
-- =============================================================================

do $$
declare
  a    uuid := '00000000-0000-4000-8000-0000000000a1';
  pair uuid;
  o    uuid;
begin
  select id into pair from public.trading_pairs where symbol = 'BTC-USDT';

  insert into public.trading_orders (user_id, pair_id, side, type, price, amount, status)
  values (a, pair, 'BUY', 'LIMIT', 50000, 1, 'OPEN') returning id into o;
  update public.trading_orders set filled_amount = 1, status = 'FILLED' where id = o;
  perform pg_temp.rejects('§19.9 filled order cannot be cancelled', format(
    $q$ update public.trading_orders set status = 'CANCELLED' where id = %L $q$, o));

  insert into public.trading_orders (user_id, pair_id, side, type, price, amount, status)
  values (a, pair, 'SELL', 'LIMIT', 60000, 1, 'OPEN') returning id into o;
  update public.trading_orders set status = 'CANCELLED' where id = o;
  perform pg_temp.rejects('§19.8 cancelled order cannot be filled', format(
    $q$ update public.trading_orders set filled_amount = 1, status = 'FILLED' where id = %L $q$, o));

  insert into public.trading_orders (user_id, pair_id, side, type, price, amount, status)
  values (a, pair, 'BUY', 'LIMIT', 50000, 10, 'OPEN') returning id into o;
  perform pg_temp.rejects('FILLED requires filled_amount = amount', format(
    $q$ update public.trading_orders set filled_amount = 3, status = 'FILLED' where id = %L $q$, o));
  perform pg_temp.rejects('order cannot fill beyond its own size', format(
    $q$ update public.trading_orders set filled_amount = 99 where id = %L $q$, o));

  perform pg_temp.rejects('MARKET order rejects a price', format(
    $q$ insert into public.trading_orders (user_id, pair_id, side, type, price, amount)
        values (%L, %L, 'BUY', 'MARKET', 50000, 1) $q$, a, pair));

  perform pg_temp.rejects('LIMIT order requires a price', format(
    $q$ insert into public.trading_orders (user_id, pair_id, side, type, amount)
        values (%L, %L, 'BUY', 'LIMIT', 1) $q$, a, pair));
end;
$$;

-- =============================================================================
-- §9 — quotes are single-use, expiry-checked and owner-bound
-- =============================================================================

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b2';
  usdt uuid; btc uuid; q uuid;
begin
  select id into usdt from public.assets where symbol = 'USDT';
  select id into btc  from public.assets where symbol = 'BTC';

  insert into public.swap_quotes (user_id, from_asset_id, to_asset_id, from_amount,
                                  rate, fee, output_amount, rate_source, expires_at)
  values (a, usdt, btc, 1000, 0.00002, 5, 0.0199, 'test', now() + interval '5 min')
  returning id into q;

  begin
    perform public.consume_quote(q, a, null);
    perform pg_temp.holds('a valid quote can be consumed', true);
  exception when others then
    perform pg_temp.holds('a valid quote can be consumed', false);
  end;

  perform pg_temp.rejects('§9 quote cannot be consumed twice', format(
    $q$ select public.consume_quote(%L, %L, null) $q$, q, a));

  insert into public.swap_quotes (user_id, from_asset_id, to_asset_id, from_amount,
                                  rate, fee, output_amount, rate_source, created_at, expires_at)
  values (a, usdt, btc, 1000, 0.00002, 5, 0.0199, 'test',
          now() - interval '10 min', now() - interval '5 min')
  returning id into q;
  perform pg_temp.rejects('§9 expired quote rejected', format(
    $q$ select public.consume_quote(%L, %L, null) $q$, q, a));

  insert into public.swap_quotes (user_id, from_asset_id, to_asset_id, from_amount,
                                  rate, fee, output_amount, rate_source, expires_at)
  values (a, usdt, btc, 1000, 0.00002, 5, 0.0199, 'test', now() + interval '5 min')
  returning id into q;
  perform pg_temp.rejects('§9 another user cannot consume this quote', format(
    $q$ select public.consume_quote(%L, %L, null) $q$, q, b));

  insert into public.swap_orders (user_id, quote_id, from_asset_id, to_asset_id,
                                  from_amount, to_amount, rate)
  values (a, q, usdt, btc, 1000, 0.0199, 0.00002);
  perform pg_temp.rejects('one quote backs at most one swap order', format(
    $q$ insert into public.swap_orders (user_id, quote_id, from_asset_id, to_asset_id,
                                        from_amount, to_amount, rate)
        values (%L, %L, %L, %L, 1000, 0.0199, 0.00002) $q$, a, q, usdt, btc));
end;
$$;

-- =============================================================================
-- §19.5, §19.4, §19.7 — deposits and withdrawals
-- =============================================================================

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  usdt uuid; d uuid; w uuid;
  v_avail_before  numeric(38, 18);
  v_locked_before numeric(38, 18);
begin
  select id into usdt from public.assets where symbol = 'USDT';

  insert into public.deposits (user_id, asset_id, network, amount, address, tx_hash, status)
  values (a, usdt, 'TRON', 100, 'Taddr', 'tst-tx-1', 'CONFIRMED') returning id into d;

  perform pg_temp.rejects('§19.5 duplicate deposit tx_hash rejected', format(
    $q$ insert into public.deposits (user_id, asset_id, network, amount, address, tx_hash, status)
        values (%L, %L, 'TRON', 100, 'Taddr', 'tst-tx-1', 'CONFIRMED') $q$, a, usdt));

  perform pg_temp.holds('deposit credit claimed once', public.claim_deposit_for_credit(d));
  perform pg_temp.holds('§19.5 deposit credit refuses a replay',
    not public.claim_deposit_for_credit(d));

  insert into public.deposits (user_id, asset_id, network, amount, address, tx_hash, status)
  values (a, usdt, 'TRON', 100, 'Taddr', 'tst-tx-2', 'CONFIRMING') returning id into d;
  perform pg_temp.holds('unconfirmed deposit cannot be credited',
    not public.claim_deposit_for_credit(d));

  -- Fund and hold, so a release has something real to return.
  perform public.ledger_post(a, usdt, 'DEPOSIT', 500, 500, 0, 'test', null, 'tst:wd-fund');
  perform public.ledger_post(a, usdt, 'HOLD', 100, -100, 100, 'test', null, 'tst:wd-hold');

  insert into public.withdrawals (user_id, asset_id, network, amount, fee,
                                  destination, idempotency_key, status)
  values (a, usdt, 'TRON', 100, 1, 'Tdest', 'tst-idem-1', 'FAILED') returning id into w;

  perform pg_temp.rejects('§19.4 duplicate withdrawal idempotency_key rejected', format(
    $q$ insert into public.withdrawals (user_id, asset_id, network, amount, fee,
                                        destination, idempotency_key)
        values (%L, %L, 'TRON', 100, 1, 'Tdest', 'tst-idem-1') $q$, a, usdt));

  perform pg_temp.rejects('fee cannot consume the whole withdrawal', format(
    $q$ insert into public.withdrawals (user_id, asset_id, network, amount, fee,
                                        destination, idempotency_key)
        values (%L, %L, 'TRON', 10, 10, 'Tdest', 'tst-idem-fee') $q$, a, usdt));

  -- Asserted as a delta, not as absolute figures: this block runs after the
  -- ledger block has already moved money, and a test that hardcodes a total
  -- breaks whenever an earlier assertion is added rather than when the product
  -- breaks.
  select available_balance, locked_balance into v_avail_before, v_locked_before
  from public.wallets where user_id = a and asset_id = usdt;

  perform pg_temp.holds('§19.7 failed withdrawal releases its hold',
    public.release_withdrawal_hold(w));

  perform pg_temp.holds('§19.7 release moves exactly the held amount back',
    (select available_balance = v_avail_before + 100
        and locked_balance    = v_locked_before - 100
       from public.wallets where user_id = a and asset_id = usdt));

  perform pg_temp.holds('§19.7 hold cannot be released twice',
    not public.release_withdrawal_hold(w));

  insert into public.withdrawals (user_id, asset_id, network, amount, fee,
                                  destination, idempotency_key, status)
  values (a, usdt, 'TRON', 50, 1, 'Tdest', 'tst-idem-2', 'PROCESSING') returning id into w;
  perform pg_temp.holds('in-flight withdrawal cannot be released',
    not public.release_withdrawal_hold(w));

  perform pg_temp.holds('ledger still reconciles after withdrawal flow',
    (select count(*) = 0 from public.reconcile_wallets()));
end;
$$;

-- =============================================================================
-- §19.6 — a trade settles exactly once
-- =============================================================================

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  pair uuid; o uuid; t uuid;
begin
  select id into pair from public.trading_pairs where symbol = 'BTC-USDT';
  insert into public.trading_orders (user_id, pair_id, side, type, price, amount, status)
  values (a, pair, 'BUY', 'LIMIT', 50000, 1, 'OPEN') returning id into o;

  insert into public.trades (pair_id, buy_order_id, price, amount, quote_amount, provider_trade_id)
  values (pair, o, 50000, 1, 50000, 'tst-trade-1') returning id into t;

  perform pg_temp.rejects('duplicate provider_trade_id rejected', format(
    $q$ insert into public.trades (pair_id, buy_order_id, price, amount, quote_amount, provider_trade_id)
        values (%L, %L, 50000, 1, 50000, 'tst-trade-1') $q$, pair, o));

  perform pg_temp.holds('trade settles once', public.mark_trade_settled(t));
  perform pg_temp.holds('§19.6 trade cannot settle twice', not public.mark_trade_settled(t));
end;
$$;

-- =============================================================================
-- §47, §80.9, §80.12, §80.21 — RLS, exercised as a real signed-in request
-- =============================================================================

insert into public.audit_logs (action, actor_type) values ('test.event', 'SYSTEM');
insert into public.risk_events (user_id, subject_type, decision, rule_code)
values ('00000000-0000-4000-8000-0000000000a1', 'withdrawal', 'REVIEW', 'TEST_RULE');
insert into public.notifications (user_id, title, body)
values ('00000000-0000-4000-8000-0000000000a1', 'Test', 'Body');

-- Suspend Alice as the platform would, so her attempt to set herself back to
-- ACTIVE below is a genuine escalation attempt rather than a write that happens
-- to match the existing value.
update public.profiles set status = 'SUSPENDED'
where user_id = '00000000-0000-4000-8000-0000000000a1';

-- Become Alice. From here on, every statement runs under the same role and
-- claims a browser session would carry.
do $$ begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-8000-0000000000a1',
                      'role', 'authenticated')::text, true);
end; $$;
set local role authenticated;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b2';
  usdt uuid;
begin
  select id into usdt from public.assets where symbol = 'USDT';

  perform pg_temp.holds('auth.uid() resolves to the signed-in user', auth.uid() = a);
  perform pg_temp.holds('§47 user sees only their own wallet',
    (select count(*) = 1 from public.wallets));
  perform pg_temp.holds('§47 user cannot read another user''s wallet',
    (select count(*) = 0 from public.wallets where user_id = b));
  perform pg_temp.holds('§47 user cannot read another user''s ledger',
    (select count(*) = 0 from public.ledger_entries where user_id = b));

  perform pg_temp.no_effect('§80.12 user cannot update their own balance',
    format($q$ update public.wallets set available_balance = 999999 where user_id = %L $q$, a),
    format($q$ select not exists (select 1 from public.wallets
                                  where user_id = %L and available_balance = 999999) $q$, a));

  perform pg_temp.rejects('§80.12 user cannot create a funded wallet', format(
    $q$ insert into public.wallets (user_id, asset_id, available_balance) values (%L, %L, 500) $q$, a, usdt));

  perform pg_temp.rejects('§18 user cannot write a ledger entry', format(
    $q$ insert into public.ledger_entries (user_id, asset_id, entry_type, amount, available_delta)
        values (%L, %L, 'DEPOSIT', 10000, 10000) $q$, a, usdt));

  perform pg_temp.rejects('§80.9 user cannot call ledger_post', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 10000, 10000, 0) $q$, a, usdt));

  perform pg_temp.no_effect('§80.21 user cannot change their own tier',
    format($q$ update public.profiles set tier_code = 'TIER_3' where user_id = %L $q$, a),
    format($q$ select not exists (select 1 from public.profiles
                                  where user_id = %L and tier_code = 'TIER_3') $q$, a));

  perform pg_temp.no_effect('§80.22 user cannot self-verify KYC',
    format($q$ update public.profiles set kyc_status = 'VERIFIED' where user_id = %L $q$, a),
    format($q$ select not exists (select 1 from public.profiles
                                  where user_id = %L and kyc_status = 'VERIFIED') $q$, a));

  perform pg_temp.no_effect('§47 user cannot change another user''s account status',
    format($q$ update public.profiles set display_name = 'Hijacked' where user_id = %L $q$, b),
    format($q$ select not exists (select 1 from public.profiles
                                  where user_id = %L and display_name = 'Hijacked') $q$, b));

  perform pg_temp.takes_effect('user CAN change their own display name',
    format($q$ update public.profiles set display_name = 'Alice' where user_id = %L $q$, a),
    format($q$ select exists (select 1 from public.profiles
                              where user_id = %L and display_name = 'Alice') $q$, a));

  perform pg_temp.no_effect('§9 user cannot change their own account status',
    format($q$ update public.profiles set status = 'ACTIVE' where user_id = %L $q$, a),
    format($q$ select not exists (select 1 from public.profiles
                                  where user_id = %L and status <> 'SUSPENDED') $q$, a));

  perform pg_temp.rejects('§43 user cannot make themselves an admin', format(
    $q$ insert into public.admin_users (user_id, email, role) values (%L, 'x@test.invalid', 'SUPER_ADMIN') $q$, a));

  perform pg_temp.no_effect('§80.18 user cannot change a fee rule',
    $q$ update public.fee_rules set percentage = 0 where operation = 'SWAP' $q$,
    $q$ select not exists (select 1 from public.fee_rules where operation = 'SWAP' and percentage = 0) $q$);

  perform pg_temp.no_effect('§80.17 user cannot raise their own limit',
    $q$ update public.tier_limits set max_amount = 99999999 where tier_code = 'TIER_0' $q$,
    $q$ select not exists (select 1 from public.tier_limits
                           where tier_code = 'TIER_0' and max_amount = 99999999) $q$);

  perform pg_temp.holds('audit_logs unreadable by a user',
    (select count(*) = 0 from public.audit_logs));
  perform pg_temp.holds('risk_events unreadable by a user',
    (select count(*) = 0 from public.risk_events));
  perform pg_temp.holds('provider_events unreadable by a user',
    (select count(*) = 0 from public.provider_events));
  perform pg_temp.holds('idempotency_keys unreadable by a user',
    (select count(*) = 0 from public.idempotency_keys));

  perform pg_temp.holds('reference data stays readable to a user',
    (select count(*) > 0 from public.assets where is_active)
    and (select count(*) > 0 from public.trading_pairs where is_active));
end;
$$;

reset role;
do $$ begin perform set_config('request.jwt.claims', null, true); end; $$;
set local role anon;

do $$
begin
  perform pg_temp.holds('anonymous visitor can read the asset list',
    (select count(*) > 0 from public.assets where is_active));
  perform pg_temp.holds('anonymous visitor sees no wallets',
    (select count(*) = 0 from public.wallets));
  perform pg_temp.holds('anonymous visitor sees no profiles',
    (select count(*) = 0 from public.profiles));
  perform pg_temp.holds('anonymous visitor sees no orders',
    (select count(*) = 0 from public.trading_orders));
end;
$$;

reset role;

-- -----------------------------------------------------------------------------
-- Report
-- -----------------------------------------------------------------------------

\set QUIET off
\pset format aligned

select case when passed then 'PASS' else 'FAIL' end as result,
       name,
       case when passed then null else detail end as why
from test_results
order by seq;

select count(*) filter (where passed)       as passed,
       count(*) filter (where not passed)   as failed,
       count(*)                             as total
from test_results;

-- Fail the run if anything failed, so CI and `npm test` stop on a broken invariant.
do $$
declare
  v_failed integer;
begin
  select count(*) into v_failed from test_results where not passed;
  if v_failed > 0 then
    raise exception 'INVARIANT SUITE FAILED: % assertion(s) did not hold', v_failed;
  end if;
end;
$$;

rollback;
