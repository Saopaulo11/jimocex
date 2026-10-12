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

-- The privileges under test (scripts/privilege-registry.ts): 017, what the
-- migrations in this repository build (the default), or 019, the draft of
-- migration 019 that scripts/test-db.sh applies from JIMOCEX_EXTRA_SQL. Where
-- the two refuse the same statement in different layers, an assertion names
-- the layer each profile must refuse it in.
\if :{?privilege_profile}
\else
\set privilege_profile 017
\endif
\echo privilege profile :privilege_profile
begin;
select set_config('jimocex.privilege_profile', :'privilege_profile', true) as privilege_profile \gset
do $$
begin
  if current_setting('jimocex.privilege_profile') not in ('017', '019') then
    raise exception 'unknown privilege profile %', current_setting('jimocex.privilege_profile');
  end if;
end;
$$;

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

-- An error that means the TEST is broken, not that the database refused: a
-- syntax error, an unknown table, column or function, a type mismatch, a
-- literal that does not convert to its type (a malformed uuid, number or
-- timestamp in the test's own SQL), a lost connection, an aborted transaction,
-- an internal error. Every helper that catches errors re-raises these instead
-- of recording them, so a typo in an assertion stops the run rather than
-- passing as a refusal. 42501 (insufficient_privilege) is the one refusal in
-- class 42. A test that means to provoke one of these codes says so with
-- rejects_with(), which accepts exactly the code it names.
create function pg_temp.is_test_defect(p_sqlstate text) returns boolean
language sql immutable as $fn$
  select (left(p_sqlstate, 2) = '42' and p_sqlstate <> '42501')
      or left(p_sqlstate, 2) in ('08', '25', '2F', '39', '3D', '3F', '40', '53', '54', '55', '57', '58', 'F0', 'XX')
      -- data exceptions raised while converting a literal or a cast
      or p_sqlstate in ('22P02', '22P03', '22007', '22008', '22018', '22021', '22025')
$fn$;

create function pg_temp.profile() returns text
language sql stable as $fn$ select current_setting('jimocex.privilege_profile') $fn$;

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
    if pg_temp.is_test_defect(sqlstate) then raise; end if;
    insert into test_results (name, passed, detail) values (p_name, true, sqlerrm);
  end;
end;
$fn$;

-- `rejects`, but only a refusal with the expected SQLSTATE counts. For a guard
-- that has a distinctive error, this proves THAT guard fired — not some other
-- constraint that happened to stop the same statement.
create function pg_temp.rejects_with(p_name text, p_sql text, p_sqlstate text) returns void
language plpgsql as $fn$
begin
  begin
    execute p_sql;
    insert into test_results (name, passed, detail)
    values (p_name, false, 'statement was ACCEPTED but must be rejected');
  exception when others then
    if sqlstate <> p_sqlstate and pg_temp.is_test_defect(sqlstate) then raise; end if;
    insert into test_results (name, passed, detail)
    values (p_name, sqlstate = p_sqlstate,
            case when sqlstate = p_sqlstate then sqlerrm
                 else format('rejected with %s (%s), expected %s', sqlstate, sqlerrm, p_sqlstate) end);
  end;
end;
$fn$;

-- Same, and the message must start with p_prefix. For a guard whose SQLSTATE a
-- table constraint shares (ledger_post's NOT NULL and amount checks), the code
-- alone cannot tell which layer refused; the message can.
create function pg_temp.rejects_with_message(p_name text, p_sql text, p_sqlstate text, p_prefix text) returns void
language plpgsql as $fn$
begin
  begin
    execute p_sql;
    insert into test_results (name, passed, detail)
    values (p_name, false, 'statement was ACCEPTED but must be rejected');
  exception when others then
    if sqlstate <> p_sqlstate and pg_temp.is_test_defect(sqlstate) then raise; end if;
    insert into test_results (name, passed, detail)
    values (p_name, sqlstate = p_sqlstate and starts_with(sqlerrm, p_prefix),
            case when sqlstate = p_sqlstate and starts_with(sqlerrm, p_prefix) then sqlerrm
                 else format('rejected with %s (%s), expected %s starting %L', sqlstate, sqlerrm, p_sqlstate, p_prefix) end);
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
    if pg_temp.is_test_defect(sqlstate) then raise; end if;
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
    if pg_temp.is_test_defect(sqlstate) then raise; end if;
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

-- A read the current role is entitled to: p_sql (a boolean query) must run and
-- be true. Only a privilege refusal is recorded as a failure; any other error
-- stops the run.
create function pg_temp.reads(p_name text, p_sql text) returns void
language plpgsql as $fn$
declare
  v_ok boolean;
begin
  begin
    execute p_sql into v_ok;
  exception when insufficient_privilege then
    insert into test_results (name, passed, detail) values (p_name, false, 'refused: ' || sqlerrm);
    return;
  end;
  insert into test_results (name, passed, detail)
  values (p_name, coalesce(v_ok, false), case when coalesce(v_ok, false) then null else 'condition was false' end);
end;
$fn$;

-- Reading rows the current role must not see is refused in one of two ways,
-- and each is checked strictly instead of either being accepted blindly. Which
-- one applies is read from the catalog first:
--   SELECT granted     -> the query must succeed and RLS must leave none of the
--                         rows p_forbidden selects;
--   SELECT not granted -> the query must fail with exactly
--                         "permission denied for table <t>" (42501).
-- Only insufficient_privilege is caught; any other error stops the run.
-- p_expect ('ACL' or 'RLS') also requires that layer; NULL accepts either.
-- The assertion is named after the layer that refused.
create function pg_temp.sees_no_forbidden_rows(p_name text, p_table text, p_forbidden text, p_expect text default null)
returns text
language plpgsql as $fn$
declare
  v_granted boolean := has_table_privilege(format('public.%I', p_table), 'SELECT');
  v_count   bigint;
  v_msg     text;
  v_layer   text;
  v_ok      boolean;
  v_detail  text;
begin
  begin
    execute format('select count(*) from public.%I where %s', p_table, p_forbidden) into v_count;
    v_layer  := 'RLS';
    v_ok     := v_granted and v_count = 0;
    v_detail := case when not v_granted then 'SELECT is not granted, yet the query succeeded'
                     when v_count > 0 then format('%s forbidden row(s) visible', v_count) end;
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    v_layer  := 'ACL';
    v_ok     := not v_granted and v_msg = format('permission denied for table %s', p_table);
    v_detail := case when not v_ok then format('refused with 42501 "%s" although SELECT is %s',
                       v_msg, case when v_granted then 'granted' else 'not granted' end) end;
  end;
  if p_expect is not null and v_layer <> p_expect then
    v_ok     := false;
    v_detail := concat_ws('; ', v_detail, format('refused by %s; profile %s expects %s', v_layer, pg_temp.profile(), p_expect));
  end if;
  insert into test_results (name, passed, detail) values (format('[%s] %s', v_layer, p_name), v_ok, v_detail);
  return v_layer;
end;
$fn$;

-- A write RLS filters out: it runs without error and matches no row. Any
-- refusal is a failure: it would mean a different layer decided. That the row
-- is unchanged is checked afterwards as the owner, who can see it.
create function pg_temp.filtered_by_rls(p_name text, p_sql text) returns void
language plpgsql as $fn$
declare
  v_rows bigint;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
  exception when others then
    if pg_temp.is_test_defect(sqlstate) then raise; end if;
    insert into test_results (name, passed, detail)
    values ('[RLS] ' || p_name, false, format('refused with %s (%s); RLS filters silently', sqlstate, sqlerrm));
    return;
  end;
  insert into test_results (name, passed, detail)
  values ('[RLS] ' || p_name, v_rows = 0, case when v_rows <> 0 then format('%s row(s) matched', v_rows) end);
end;
$fn$;

-- An UPDATE with no WHERE clause reads no column of the table, so the table's
-- UPDATE policy alone decides which rows it reaches. (With a WHERE on user_id
-- the SELECT policy applies too and hides other users' rows by itself — which
-- would mask a widened UPDATE policy.) It must succeed and reach exactly the
-- caller's own rows; the other users' rows are checked afterwards by the table
-- owner, the one role that sees them all.
create function pg_temp.update_reaches_only_own_rows(p_name text, p_table text, p_set text) returns void
language plpgsql as $fn$
declare
  v_own  bigint;
  v_rows bigint;
begin
  execute format('select count(*) from public.%I where user_id = auth.uid()', p_table) into v_own;
  begin
    execute format('update public.%I set %s', p_table, p_set);
    get diagnostics v_rows = row_count;
  exception when others then
    if pg_temp.is_test_defect(sqlstate) then raise; end if;
    insert into test_results (name, passed, detail)
    values ('[RLS] ' || p_name, false, format('refused with %s (%s)', sqlstate, sqlerrm));
    return;
  end;
  insert into test_results (name, passed, detail)
  values ('[RLS] ' || p_name, v_own > 0 and v_rows = v_own,
          case when v_own = 0 then 'the user owns no row to update: the test proves nothing'
               when v_rows <> v_own then format('reached %s row(s); the user owns %s', v_rows, v_own) end);
end;
$fn$;

-- Refused by a column-level grant: the role holds UPDATE on some columns of
-- the table but not on p_column, and the statement fails with "permission
-- denied for table <t>" before any trigger runs.
create function pg_temp.refused_by_column_grant(p_name text, p_table text, p_column text, p_sql text) returns void
language plpgsql as $fn$
begin
  if not has_any_column_privilege(format('public.%I', p_table), 'UPDATE')
     or has_column_privilege(format('public.%I', p_table), p_column, 'UPDATE') then
    insert into test_results (name, passed, detail)
    values ('[column grant] ' || p_name, false,
            format('%s holds UPDATE on %s.%s, or on no column of it: not a column-level restriction',
                   current_user, p_table, p_column));
    return;
  end if;
  perform pg_temp.rejects_with_message('[column grant] ' || p_name, p_sql, '42501',
                                       format('permission denied for table %s', p_table));
end;
$fn$;

-- Calls every function in function_calls as the current role and requires
-- exactly what the profile says: an executor's call completes (and is then
-- undone, so it changes nothing), anyone else gets "permission denied for
-- function <f>". A function that runs but fails inside is a failure too.
create function pg_temp.execute_matrix() returns void
language plpgsql as $fn$
declare
  f         record;
  v_may     boolean;
  v_outcome text;
  v_msg     text;
begin
  for f in select * from function_calls order by name loop
    v_may := current_user = any (f.executors);
    begin
      execute f.call;
      raise exception 'call completed' using errcode = 'JX001';
    exception
      when sqlstate 'JX001' then
        v_outcome := 'executed';
      when insufficient_privilege then
        get stacked diagnostics v_msg = message_text;
        v_outcome := case when v_msg = format('permission denied for function %s', f.name) then 'denied'
                          else '42501 inside the function: ' || v_msg end;
      when others then
        if pg_temp.is_test_defect(sqlstate) then raise; end if;
        v_outcome := format('the function raised %s: %s', sqlstate, sqlerrm);
    end;
    insert into test_results (name, passed, detail)
    values (format('[ACL] %s %s execute %s()', current_user, case when v_may then 'may' else 'may not' end, f.name),
            v_outcome = case when v_may then 'executed' else 'denied' end,
            case when v_outcome <> case when v_may then 'executed' else 'denied' end then v_outcome end);
  end loop;
end;
$fn$;

-- The same sections call these helpers. A function postgres creates is
-- executable by its owner only (017 revokes even PUBLIC's default), so the
-- helpers are granted explicitly, like any function a role must call.
grant execute on function
  pg_temp.rejects(text, text),
  pg_temp.rejects_with(text, text, text),
  pg_temp.rejects_with_message(text, text, text, text),
  pg_temp.no_effect(text, text, text),
  pg_temp.takes_effect(text, text, text),
  pg_temp.holds(text, boolean),
  pg_temp.is_test_defect(text),
  pg_temp.profile(),
  pg_temp.reads(text, text),
  pg_temp.sees_no_forbidden_rows(text, text, text, text),
  pg_temp.filtered_by_rls(text, text),
  pg_temp.update_reaches_only_own_rows(text, text, text),
  pg_temp.refused_by_column_grant(text, text, text, text),
  pg_temp.execute_matrix()
  to public;

-- The helpers' own negative tests. A malformed statement — a typo, an unknown
-- object, a literal that does not convert — must stop the run with its real
-- error, never be recorded as the refusal an assertion was waiting for.
do $$
declare
  t       record;
  v_state text;
begin
  for t in select * from (values
    ('rejects', 'a syntax error', 'selec 1', '42601'),
    ('rejects', 'an unknown table', 'select 1 from public.jimocex_no_such_table', '42P01'),
    ('rejects', 'an unknown column', 'select jimocex_no_such_column from public.assets', '42703'),
    ('rejects', 'an unknown function', 'select public.jimocex_no_such_function()', '42883'),
    ('rejects', 'a malformed uuid literal', 'select ''not-a-uuid''::uuid', '22P02'),
    ('rejects', 'a malformed number literal', 'select ''12,5''::numeric', '22P02'),
    ('rejects', 'a malformed timestamp literal', 'select ''not a date''::timestamptz', '22007'),
    ('rejects_with', 'an unknown table where 42501 was expected', 'select 1 from public.jimocex_no_such_table', '42P01'),
    ('no_effect', 'a malformed uuid literal', 'update public.assets set name = name where id = ''not-a-uuid''', '22P02')
  ) v(helper, what, sql, expected) loop
    begin
      if t.helper = 'rejects' then
        perform pg_temp.rejects('helper self-test', t.sql);
      elsif t.helper = 'rejects_with' then
        perform pg_temp.rejects_with('helper self-test', t.sql, '42501');
      else
        perform pg_temp.no_effect('helper self-test', t.sql, 'select true');
      end if;
      v_state := 'recorded as a result';
    exception when others then
      v_state := sqlstate;
    end;
    perform pg_temp.holds(format('helper self-test: %s() stops on %s (%s) instead of counting it', t.helper, t.what, t.expected),
                          v_state = t.expected);
  end loop;
  -- What the helpers do accept: a real refusal, and a code a test names on purpose.
  perform pg_temp.rejects('helper self-test',
    $q$ do $x$ begin raise exception 'refused' using errcode = 'insufficient_privilege'; end $x$ $q$);
  perform pg_temp.holds('helper self-test: rejects() records a genuine 42501 as the refusal',
    (select passed from test_results where name = 'helper self-test' order by seq desc limit 1));
  perform pg_temp.rejects_with('helper self-test', 'select ''not-a-uuid''::uuid', '22P02');
  perform pg_temp.holds('helper self-test: rejects_with() accepts a conversion error it names explicitly',
    (select passed from test_results where name = 'helper self-test' order by seq desc limit 1));
  delete from test_results where name = 'helper self-test';
end;
$$;

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
-- §22 — the seeded TIER_0 ceilings match the approved product spec
--
-- This block exists because the seed and the spec drifted apart once already:
-- 011 shipped the Exchange and Trade SINGLE window at 2,000 while the product
-- called for 5,000, and nothing caught it. Asserting the configured figures
-- here turns that class of mistake into a failing test instead of a discovery.
--
-- Deliberately asserting the DATABASE's values, not the engine's arithmetic —
-- the engine is tested separately against synthetic ceilings, which is what
-- keeps these two kinds of regression distinguishable.
-- =============================================================================

do $$
declare
  v_op   text;
  v_win  text;
begin
  -- Exchange and Trade: USD 5,000 across all three windows.
  foreach v_op in array array['SWAP', 'TRADE'] loop
    foreach v_win in array array['SINGLE', 'DAILY', 'MONTHLY'] loop
      perform pg_temp.holds(
        format('§22 TIER_0 %s %s ceiling is USD 5,000', v_op, v_win),
        (select max_amount = 5000 and quote_currency = 'USD'
           from public.tier_limits
          where tier_code = 'TIER_0'
            and operation::text = v_op
            and window_kind::text = v_win
            and is_active));
    end loop;
  end loop;

  -- Withdrawals are intentionally tighter than the Exchange ceiling: funds
  -- leaving the platform carry a different risk profile from funds moving
  -- within it. If someone raises these to match, this fails and asks why.
  perform pg_temp.holds('§22 TIER_0 crypto withdrawal stays tighter than exchange',
    (select max_amount = 1000 from public.tier_limits
      where tier_code = 'TIER_0' and operation = 'CRYPTO_WITHDRAWAL'
        and window_kind = 'SINGLE' and is_active));

  perform pg_temp.holds('§22 TIER_0 fiat withdrawal stays tighter than exchange',
    (select max_amount = 1000 from public.tier_limits
      where tier_code = 'TIER_0' and operation = 'FIAT_WITHDRAWAL'
        and window_kind = 'SINGLE' and is_active));

  -- The ladder must stay monotonic: a higher tier that permitted LESS than a
  -- lower one would make the REQUIRE_KYC upgrade suggestion nonsense.
  perform pg_temp.holds('§21 the tier ladder never decreases a ceiling',
    not exists (
      select 1
      from public.tier_limits lo
      join public.account_tiers tlo on tlo.code = lo.tier_code
      join public.tier_limits hi
        on hi.operation = lo.operation
       and hi.window_kind = lo.window_kind
      join public.account_tiers thi on thi.code = hi.tier_code
      where thi.rank > tlo.rank
        and lo.is_active and hi.is_active
        and lo.max_amount is not null
        and hi.max_amount is not null
        and hi.max_amount < lo.max_amount
    ));
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

  perform pg_temp.rejects_with_message('§18 ledger entry cannot be updated',
    $q$ update public.ledger_entries set amount = 999999 where dedup_key = 'tst:deposit' $q$,
    '23001', 'public.ledger_entries is append-only; UPDATE');

  perform pg_temp.rejects_with_message('§18 ledger entry cannot be deleted',
    $q$ delete from public.ledger_entries where dedup_key = 'tst:deposit' $q$,
    '23001', 'public.ledger_entries is append-only; DELETE');

  perform pg_temp.rejects('§19.5 duplicate posting of one operation rejected', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 1000, 1000, 0, 'test', null, 'tst:deposit') $q$, a, usdt));
  perform pg_temp.holds('§19.5 a refused duplicate leaves ledger and wallet consistent',
    not exists (select 1 from public.reconcile_wallets() x where x.user_id = a));

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
insert into public.provider_events (provider, event_id, event_type, payload_hash, payload)
values ('test', 'tst-evt-1', 'test.event', 'tst-hash', '{}');
insert into public.idempotency_keys (scope, key, request_hash)
values ('test', 'tst-key-1', 'tst-hash');

-- "No row visible" proves nothing on an empty table.
select pg_temp.holds('fixture: every table a client must not read holds a row',
  exists (select 1 from public.audit_logs) and exists (select 1 from public.risk_events)
  and exists (select 1 from public.provider_events) and exists (select 1 from public.idempotency_keys)
  and exists (select 1 from public.wallets) and exists (select 1 from public.profiles)
  and exists (select 1 from public.trading_orders));

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
  -- reads(): a privilege refusal is recorded as a failure of this assertion
  -- instead of stopping the run.
  perform pg_temp.reads('§47 user sees only their own wallet',
    'select count(*) = 1 from public.wallets');
  perform pg_temp.reads('§47 user cannot read another user''s wallet',
    format('select count(*) = 0 from public.wallets where user_id = %L', b));
  perform pg_temp.reads('§47 user cannot read another user''s ledger',
    format('select count(*) = 0 from public.ledger_entries where user_id = %L', b));

  perform pg_temp.no_effect('§80.12 user cannot update their own balance',
    format($q$ update public.wallets set available_balance = 999999 where user_id = %L $q$, a),
    format($q$ select not exists (select 1 from public.wallets
                                  where user_id = %L and available_balance = 999999) $q$, a));

  perform pg_temp.rejects_with('§80.12 user cannot create a funded wallet', format(
    $q$ insert into public.wallets (user_id, asset_id, available_balance) values (%L, %L, 500) $q$, a, usdt), '42501');

  perform pg_temp.rejects_with('§18 user cannot write a ledger entry', format(
    $q$ insert into public.ledger_entries (user_id, asset_id, entry_type, amount, available_delta)
        values (%L, %L, 'DEPOSIT', 10000, 10000) $q$, a, usdt), '42501');

  perform pg_temp.rejects_with_message('§80.9 user cannot call ledger_post', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 10000, 10000, 0) $q$, a, usdt),
    '42501', 'permission denied for function ledger_post');

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

  perform pg_temp.rejects_with('§43 user cannot make themselves an admin', format(
    $q$ insert into public.admin_users (user_id, email, role) values (%L, 'x@test.invalid', 'SUPER_ADMIN') $q$, a), '42501');

  perform pg_temp.no_effect('§80.18 user cannot change a fee rule',
    $q$ update public.fee_rules set percentage = 0 where operation = 'SWAP' $q$,
    $q$ select not exists (select 1 from public.fee_rules where operation = 'SWAP' and percentage = 0) $q$);

  perform pg_temp.no_effect('§80.17 user cannot raise their own limit',
    $q$ update public.tier_limits set max_amount = 99999999 where tier_code = 'TIER_0' $q$,
    $q$ select not exists (select 1 from public.tier_limits
                           where tier_code = 'TIER_0' and max_amount = 99999999) $q$);

  -- Either the grant refuses the read or RLS returns no row; which one is read
  -- from the catalog and then checked strictly (sees_no_forbidden_rows).
  perform pg_temp.sees_no_forbidden_rows('audit_logs unreadable by a user', 'audit_logs', 'true');
  perform pg_temp.sees_no_forbidden_rows('risk_events unreadable by a user', 'risk_events', 'true');
  perform pg_temp.sees_no_forbidden_rows('provider_events unreadable by a user', 'provider_events', 'true');
  perform pg_temp.sees_no_forbidden_rows('idempotency_keys unreadable by a user', 'idempotency_keys', 'true');

  perform pg_temp.reads('reference data stays readable to a user',
    $q$ select (select count(*) > 0 from public.assets where is_active)
           and (select count(*) > 0 from public.trading_pairs where is_active)
           and (select count(*) > 0 from public.tier_limits where is_active) $q$);
end;
$$;

reset role;
do $$ begin perform set_config('request.jwt.claims', null, true); end; $$;
set local role anon;

do $$
begin
  perform pg_temp.reads('anonymous visitor can read the asset list',
    'select count(*) > 0 from public.assets where is_active');
  perform pg_temp.reads('anonymous visitor can still read trading pairs and tier limits',
    $q$ select (select count(*) > 0 from public.trading_pairs where is_active)
           and (select count(*) > 0 from public.tier_limits where is_active) $q$);
  perform pg_temp.sees_no_forbidden_rows('anonymous visitor sees no wallets', 'wallets', 'true');
  perform pg_temp.sees_no_forbidden_rows('anonymous visitor sees no profiles', 'profiles', 'true');
  perform pg_temp.sees_no_forbidden_rows('anonymous visitor sees no orders', 'trading_orders', 'true');
end;
$$;

reset role;

-- =============================================================================
-- The money boundary (016, 017)
--
-- PostgreSQL numeric(38,18) -> PostgREST -> string -> Money -> ... -> decimal
-- string -> numeric(38,18). These assert the database end of that chain: values
-- survive exactly at the edges of the type, a decimal string sent the way
-- PostgREST sends it lands exactly, NaN cannot enter, ledger_post refuses what
-- it used to coerce, and every money-returning function hands back text.
-- =============================================================================

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c3', 'carol@test.invalid');

do $$
declare
  c    uuid := '00000000-0000-4000-8000-0000000000c3';
  usdt uuid; btc uuid; q uuid;
  r    record;
begin
  select id into usdt from public.assets where symbol = 'USDT';
  select id into btc  from public.assets where symbol = 'BTC';

  -- The edges of the type.
  perform pg_temp.holds('money: the smallest unit is stored exactly',
    '0.000000000000000001'::numeric(38, 18)::text = '0.000000000000000001');
  perform pg_temp.holds('money: the largest numeric(38,18) is stored exactly',
    '99999999999999999999.999999999999999999'::numeric(38, 18)::text
      = '99999999999999999999.999999999999999999');
  perform pg_temp.rejects('money: a value beyond numeric(38,18) is refused, never truncated',
    $q$ select '100000000000000000000'::numeric(38, 18) $q$);
  perform pg_temp.holds('money: numeric::text never uses exponent notation',
    '1e-18'::numeric(38, 18)::text = '0.000000000000000001'
    and '1e19'::numeric(38, 18)::text = '10000000000000000000.000000000000000000');

  -- The write path PostgREST uses: a JSON body bound to a record. A decimal
  -- string lands exactly, which is why the application sends strings.
  perform pg_temp.holds('money: a decimal string in a JSON body becomes the exact numeric',
    (select d.amount::text = '1234567890123456.123456789012345678'
       from json_populate_record(null::public.deposits,
              '{"amount": "1234567890123456.123456789012345678"}') d));
  perform pg_temp.holds('money: a decimal string bound to an RPC argument is exact',
    (select t.p_amount::text = '0.000000000000000001'
       from json_to_record('{"p_amount": "0.000000000000000001"}') as t(p_amount numeric)));

  -- NaN orders above every number, so `amount > 0` alone lets it in.
  perform pg_temp.holds('money: NaN would pass a positivity CHECK on its own',
    'NaN'::numeric > 0);
  perform pg_temp.rejects('money: a money column refuses NaN', format(
    $q$ insert into public.deposits (user_id, asset_id, amount) values (%L, %L, 'NaN') $q$, c, usdt));
  perform pg_temp.takes_effect('money: the same row with a real amount is accepted',
    format($q$ insert into public.deposits (user_id, asset_id, amount, provider_reference)
               values (%L, %L, '0.000000000000000001', 'tst:nan-control') $q$, c, usdt),
    $q$ select exists (select 1 from public.deposits where provider_reference = 'tst:nan-control') $q$);
  perform pg_temp.rejects('money: a limit cannot be configured as NaN',
    $q$ update public.tier_limits set max_amount = 'NaN' where tier_code = 'TIER_0' $q$);

  -- ledger_post refuses instead of coercing. Each refusal is asserted by its
  -- SQLSTATE, so the test proves ledger_post's own guard fired rather than a
  -- table constraint further down: 22023 for a figure that is not a finite
  -- 18-place decimal, 23502 for a missing one.
  perform pg_temp.rejects_with('ledger_post refuses NaN', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 'NaN', 'NaN', 0, 'test', null, 'tst:nan') $q$, c, usdt),
    '22023');
  perform pg_temp.rejects_with('ledger_post refuses Infinity', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 'Infinity', 'Infinity', 0, 'test', null, 'tst:inf') $q$, c, usdt),
    '22023');
  -- A RELEASE with a missing locked delta: the old function read it as zero,
  -- credited 5 available out of nothing, and reconciliation saw no drift.
  perform pg_temp.rejects_with_message('ledger_post refuses a missing delta instead of reading it as zero', format(
    $q$ select public.ledger_post(%L, %L, 'RELEASE', 5, 5, null, 'test', null, 'tst:null') $q$, c, usdt),
    '23502', 'ledger_post: amount and both deltas are required');
  perform pg_temp.rejects_with('ledger_post refuses a 19th decimal instead of rounding it', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', '1.0000000000000000001', '1.0000000000000000001', 0,
                                  'test', null, 'tst:19dp') $q$, c, usdt),
    '22023');

  perform pg_temp.rejects_with_message('ledger_post refuses a zero amount that would still move funds', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', 0, 5, 0, 'test', null, 'tst:zero') $q$, c, usdt),
    '23514', 'ledger_post: amount must be positive');
  perform pg_temp.rejects_with('ledger_post refuses a value beyond numeric(38,18) instead of truncating it', format(
    $q$ select public.ledger_post(%L, %L, 'DEPOSIT', '100000000000000000000', '100000000000000000000', 0,
                                  'test', null, 'tst:overflow') $q$, c, usdt),
    '22003');

  -- What a 19th decimal does when written straight into a column: PostgreSQL
  -- rounds it while coercing to numeric(38,18), before any CHECK or trigger can
  -- see the original. The database cannot refuse it there, which is why every
  -- direct write goes through toDatabase() (it refuses), and why ledger_post —
  -- whose parameters are unconstrained — checks the scale itself (above).
  perform pg_temp.rejects_with('an average fill price cannot be negative',
    $q$ update public.trading_orders set average_price = -1
        where id = (select id from public.trading_orders order by created_at limit 1) $q$,
    '23514');
  perform pg_temp.rejects_with('an average fill price cannot be zero',
    $q$ update public.trading_orders set average_price = 0
        where id = (select id from public.trading_orders order by created_at limit 1) $q$,
    '23514');
  update public.trading_orders set average_price = '0.000000000000000001'
  where id = (select id from public.trading_orders order by created_at limit 1);
  perform pg_temp.holds('a positive average fill price is accepted, and NULL stays the unfilled state',
    exists (select 1 from public.trading_orders where average_price = '0.000000000000000001')
    and exists (select 1 from public.trading_orders where average_price is null));
  perform pg_temp.rejects_with('the ledger table itself refuses a zero amount, for a writer other than ledger_post',
    format($q$ insert into public.ledger_entries (user_id, asset_id, entry_type, amount, available_delta, locked_delta)
               values (%L, %L, 'ADJUSTMENT', 0, 5, 0) $q$, c, usdt),
    '23514');
  perform pg_temp.holds('a 19th decimal written straight into a numeric(38,18) column is rounded by PostgreSQL',
    '1.0000000000000000005'::numeric(38, 18)::text = '1.000000000000000001');

  -- The smallest unit, through the sanctioned path, end to end.
  perform public.ledger_post(c, btc, 'DEPOSIT', '0.000000000000000001', '0.000000000000000001', '0',
                             'test', null, 'tst:dust');
  perform pg_temp.holds('ledger_post credits the smallest unit exactly',
    (select available_balance::text = '0.000000000000000001'
       from public.wallets where user_id = c and asset_id = btc));
  perform pg_temp.holds('reconcile_wallets reports nothing while ledger and wallet agree',
    not exists (select 1 from public.reconcile_wallets() x where x.user_id = c));

  -- A ledger whose wallet row is gone must not vanish from the report. Only
  -- the table owner can still delete a wallet after 017; the check is that
  -- reconciliation would notice if it happened.
  delete from public.wallets where user_id = c and asset_id = btc;
  perform pg_temp.holds('reconcile_wallets reports a ledger whose wallet row is missing',
    exists (select 1 from public.reconcile_wallets() x
             where x.user_id = c and x.asset_id = btc
               and x.wallet_available is null
               and x.ledger_available = '0.000000000000000001'));

  -- consume_quote hands back the stored money as exact text.
  insert into public.swap_quotes (user_id, from_asset_id, to_asset_id, from_amount,
                                  rate, fee, output_amount, rate_source, expires_at)
  values (c, usdt, btc, '1234567890123456.123456789012345678', '0.000000016180339887',
          '0.000000000000000001', '19975668.796219138600000000', 'test', now() + interval '5 min')
  returning id into q;
  select * into r from public.consume_quote(q, c, null);
  perform pg_temp.holds('consume_quote returns the quote''s money as exact text',
    r.from_amount = '1234567890123456.123456789012345678'
    and r.rate = '0.000000016180339887'
    and r.fee = '0.000000000000000001'
    and r.output_amount = '19975668.796219138600000000'
    and pg_typeof(r.output_amount) = 'text'::regtype);

  -- Window usage: more rows than one PostgREST page, summed exactly, per currency.
  insert into public.limit_usage (user_id, operation, usd_equivalent, quote_currency,
                                  reference_type, reference_id)
  select c, 'SWAP', '0.000000000000000001', 'USD', 'test', gen_random_uuid()
  from generate_series(1, 1500);
  insert into public.limit_usage (user_id, operation, usd_equivalent, quote_currency,
                                  reference_type, reference_id)
  values (c, 'SWAP', '4999.999999999999998500', 'USD', 'test', gen_random_uuid()),
         (c, 'SWAP', '7', 'EUR', 'test', gen_random_uuid());
  perform pg_temp.holds('limit_usage_total sums past one API page exactly',
    public.limit_usage_total(c, 'SWAP', 'USD', now() - interval '1 day') = '5000.000000000000000000');
  perform pg_temp.holds('limit_usage_total counts only the requested currency',
    public.limit_usage_total(c, 'SWAP', 'EUR', now() - interval '1 day') = '7.000000000000000000');
  perform pg_temp.holds('limit_usage_total returns text',
    pg_typeof(public.limit_usage_total(c, 'SWAP', 'USD', now())) = 'text'::regtype);
  perform pg_temp.rejects_with_message('the ledger cannot be truncated even by its owner',
    $q$ truncate public.ledger_entries $q$, '23001', 'public.ledger_entries is append-only; TRUNCATE');
  perform pg_temp.holds('limit_usage_total returns NULL, not zero, for a missing argument',
    public.limit_usage_total(c, 'SWAP', null, now() - interval '1 day') is null);
end;
$$;

-- service_role bypasses RLS, so only the GRANT layer stands between the admin
-- client and a balance. After 017 it does not stand alone: the only way in is
-- ledger_post.
set local role service_role;
select pg_temp.rejects_with_message('service_role cannot write a wallet balance directly',
  $q$ update public.wallets set available_balance = available_balance + 1 $q$,
  '42501', 'permission denied for table wallets');
select pg_temp.rejects_with_message('service_role cannot insert a ledger entry that moves no wallet',
  $q$ insert into public.ledger_entries (user_id, asset_id, entry_type, amount, available_delta, locked_delta)
      select user_id, asset_id, 'ADJUSTMENT', 1, 1, 0 from public.wallets limit 1 $q$,
  '42501', 'permission denied for table ledger_entries');
select pg_temp.rejects_with_message('service_role cannot delete a wallet',
  $q$ delete from public.wallets $q$, '42501', 'permission denied for table wallets');
select pg_temp.rejects_with_message('service_role cannot truncate the ledger',
  $q$ truncate public.ledger_entries $q$, '42501', 'permission denied for table ledger_entries');
select pg_temp.rejects_with_message('service_role cannot truncate window usage',
  $q$ truncate public.limit_usage $q$, '42501', 'permission denied for table limit_usage');
select pg_temp.holds('service_role still moves money through ledger_post',
  (select public.ledger_post('00000000-0000-4000-8000-0000000000c3',
                             (select id from public.assets where symbol = 'USDT'),
                             'DEPOSIT', '1.5', '1.5', '0', 'test', null, 'tst:service-role') is not null));
reset role;

-- tier_limits and trading_pairs: the grant layer refuses a client write, not
-- only RLS (42501 is insufficient_privilege; RLS would match no row silently).
set local role authenticated;
select pg_temp.rejects_with('a client role cannot change a tier limit (refused by the grant, not only by RLS)',
  $q$ update public.tier_limits set max_amount = 1 $q$, '42501');
select pg_temp.rejects_with('a client role cannot change a trading pair (refused by the grant, not only by RLS)',
  $q$ update public.trading_pairs set min_order_size = 0 $q$, '42501');
reset role;

-- A function created now, as a migration that forgot its REVOKE would create
-- it, is callable by no client role — PUBLIC's built-in grant included.
create function public.jimocex_default_privilege_probe() returns integer language sql as 'select 1';
select pg_temp.holds('a new function is executable by no client role by default, PUBLIC included',
  not has_function_privilege('anon', 'public.jimocex_default_privilege_probe()', 'execute')
  and not has_function_privilege('authenticated', 'public.jimocex_default_privilege_probe()', 'execute')
  and not has_function_privilege('service_role', 'public.jimocex_default_privilege_probe()', 'execute'));
drop function public.jimocex_default_privilege_probe();

-- =============================================================================
-- Which layer refuses what (docs/review-019-privileges.md)
--
-- Every assertion below names the layer that must decide:
--   [ACL]          a table or function privilege ("permission denied for ...")
--   [column grant] a column-level UPDATE privilege
--   [RLS]          a policy that matches no row, or refuses a new one
--   [trigger]      a guard or append-only trigger
--   [ACL+RLS]      a read both layers allow
-- Where profiles 017 and 019 decide the same statement in different layers,
-- the expectation is written per profile; nothing here accepts "refused
-- somehow".
-- =============================================================================

insert into public.admin_users (user_id, email, role)
values ('00000000-0000-4000-8000-0000000000b2', 'bob@test.invalid', 'VIEWER');
insert into public.kyc_verifications (user_id) values ('00000000-0000-4000-8000-0000000000b2');
insert into public.notifications (user_id, title, body)
values ('00000000-0000-4000-8000-0000000000b2', 'For Bob', 'Body');

-- touch_updated_at stamps now(), which is constant inside this transaction, so
-- it can be seen firing only against an older stamp. Writing one needs the
-- trigger off for a moment, which only the table owner can do.
alter table public.profiles disable trigger profiles_touch;
alter table public.notifications disable trigger notifications_touch;
update public.profiles set updated_at = '2000-01-01' where user_id = '00000000-0000-4000-8000-0000000000a1';
update public.notifications set updated_at = '2000-01-01' where user_id = '00000000-0000-4000-8000-0000000000a1';
alter table public.profiles enable trigger profiles_touch;
alter table public.notifications enable trigger notifications_touch;

-- "No row visible" proves nothing on an empty table.
do $$
declare
  t       text;
  v_has   boolean;
  v_empty text[] := '{}';
begin
  for t in select c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1 loop
    execute format('select exists (select 1 from public.%I)', t) into v_has;
    if not v_has then v_empty := v_empty || t; end if;
  end loop;
  insert into test_results (name, passed, detail)
  values ('fixture: every table in public holds a row', cardinality(v_empty) = 0,
          case when cardinality(v_empty) > 0 then 'empty: ' || array_to_string(v_empty, ', ') end);
end;
$$;

-- -----------------------------------------------------------------------------
-- authenticated (Alice)
-- -----------------------------------------------------------------------------

do $$ begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-8000-0000000000a1',
                      'role', 'authenticated')::text, true);
end; $$;
set local role authenticated;

do $$
declare
  a    uuid := '00000000-0000-4000-8000-0000000000a1';
  b    uuid := '00000000-0000-4000-8000-0000000000b2';
  p019 boolean := pg_temp.profile() = '019';
  t    text;
  col  record;
begin
  -- Reference data: SELECT granted, a read policy for anon and authenticated.
  foreach t in array array['account_tiers', 'asset_networks', 'assets', 'fee_rules', 'tier_limits', 'trading_pairs'] loop
    perform pg_temp.reads(format('[ACL+RLS] a user reads reference table %s', t),
                          format('select count(*) > 0 from public.%I', t));
  end loop;

  -- Own rows: SELECT granted in every profile, RLS hides everyone else's.
  perform pg_temp.reads('[ACL+RLS] a user reads their own profile and no other',
    format('select count(*) = 1 and bool_and(user_id = %L) from public.profiles', a));
  perform pg_temp.reads('[ACL+RLS] a user reads their own notification',
    format('select exists (select 1 from public.notifications where user_id = %L)', a));
  foreach t in array array['admin_users', 'kyc_verifications', 'notifications', 'profiles'] loop
    perform pg_temp.sees_no_forbidden_rows(format('a user sees no other user''s %s row', t), t,
                                           format('user_id <> %L', a), 'RLS');
  end loop;

  -- Server-only tables have no policy; 019 also withdraws SELECT.
  foreach t in array array['audit_logs', 'idempotency_keys', 'provider_events', 'risk_events'] loop
    perform pg_temp.sees_no_forbidden_rows(format('a user cannot read %s', t), t, 'true',
                                           case when p019 then 'ACL' else 'RLS' end);
  end loop;

  -- The columns a user may change on their own rows.
  perform pg_temp.takes_effect('[ACL+RLS] a user can set their own profiles.country_code',
    format($q$ update public.profiles set country_code = 'PT' where user_id = %L $q$, a),
    format($q$ select exists (select 1 from public.profiles where user_id = %L and country_code = 'PT') $q$, a));
  perform pg_temp.takes_effect('[ACL+RLS] a user can mark their own notification read (read_at, status)',
    format($q$ update public.notifications set read_at = now(), status = 'READ' where user_id = %L $q$, a),
    format($q$ select exists (select 1 from public.notifications
                              where user_id = %L and status = 'READ' and read_at is not null) $q$, a));

  -- Triggers fire for the writer whatever its TRIGGER privilege, which 019
  -- withdraws from every client role.
  perform pg_temp.holds(format('[trigger] touch_updated_at fires on a user''s profile update (user holds TRIGGER on profiles: %s)',
                               has_table_privilege('public.profiles', 'TRIGGER')),
    (select updated_at > '2000-01-02' from public.profiles where user_id = a)
    and has_table_privilege('public.profiles', 'TRIGGER') = not p019);
  perform pg_temp.holds(format('[trigger] touch_updated_at fires on a user''s notification update (user holds TRIGGER on notifications: %s)',
                               has_table_privilege('public.notifications', 'TRIGGER')),
    (select bool_and(updated_at > '2000-01-02') from public.notifications where user_id = a)
    and has_table_privilege('public.notifications', 'TRIGGER') = not p019);

  -- Columns guard_profile_privileged_columns protects. 017 grants UPDATE on the
  -- whole table, so the guard refuses; 019 grants display_name and country_code
  -- only, so the grant refuses before any trigger runs.
  for col in select * from (values ('user_id', quote_literal(b)), ('email', quote_literal('x@test.invalid')),
                                   ('tier_code', quote_literal('TIER_2')), ('status', quote_literal('ACTIVE')),
                                   ('kyc_status', quote_literal('VERIFIED'))) v(name, val) loop
    if p019 then
      perform pg_temp.refused_by_column_grant(format('a user cannot change their own profiles.%s', col.name),
        'profiles', col.name, format('update public.profiles set %I = %s where user_id = %L', col.name, col.val, a));
    else
      perform pg_temp.rejects_with_message(format('[trigger] a user cannot change their own profiles.%s', col.name),
        format('update public.profiles set %I = %s where user_id = %L', col.name, col.val, a),
        '42501', 'profiles: user_id, email, tier_code, status and kyc_status are not user-writable');
    end if;
  end loop;

  -- Columns guard_notification_columns protects, the same way.
  for col in select * from (values ('user_id', quote_literal(b)), ('channel', quote_literal('EMAIL')),
                                   ('title', quote_literal('Changed')), ('body', quote_literal('Changed')),
                                   ('entity_type', quote_literal('changed')), ('entity_id', quote_literal(gen_random_uuid())),
                                   ('sent_at', quote_literal(now()))) v(name, val) loop
    if p019 then
      perform pg_temp.refused_by_column_grant(format('a user cannot change their own notifications.%s', col.name),
        'notifications', col.name, format('update public.notifications set %I = %s where user_id = %L', col.name, col.val, a));
    else
      perform pg_temp.rejects_with_message(format('[trigger] a user cannot change their own notifications.%s', col.name),
        format('update public.notifications set %I = %s where user_id = %L', col.name, col.val, a),
        '42501', 'notifications: only read_at and status may be changed by the recipient');
    end if;
  end loop;

  -- Columns no guard covers. Only 019 refuses them; under 017 a user can still
  -- change their own profiles.id and created_at (docs/review-019-privileges.md).
  if p019 then
    for col in select * from (values ('id', quote_literal(gen_random_uuid())), ('created_at', quote_literal('2001-01-01')),
                                     ('updated_at', quote_literal('2001-01-01'))) v(name, val) loop
      perform pg_temp.refused_by_column_grant(format('a user cannot change their own profiles.%s', col.name),
        'profiles', col.name, format('update public.profiles set %I = %s where user_id = %L', col.name, col.val, a));
      perform pg_temp.refused_by_column_grant(format('a user cannot change their own notifications.%s', col.name),
        'notifications', col.name, format('update public.notifications set %I = %s where user_id = %L', col.name, col.val, a));
    end loop;
  end if;

  -- Another user's rows, addressed by their user_id as a PostgREST filter would:
  -- the grant allows the column, and the SELECT and UPDATE policies together
  -- match no row.
  perform pg_temp.filtered_by_rls('a user''s UPDATE of another user''s profile by user_id matches no row',
    format($q$ update public.profiles set display_name = 'Not yours' where user_id = %L $q$, b));
  perform pg_temp.filtered_by_rls('a user''s UPDATE of another user''s notification by user_id matches no row',
    format($q$ update public.notifications set read_at = now(), status = 'READ' where user_id = %L $q$, b));
  -- The UPDATE policy alone: no WHERE clause, so the SELECT policy takes no part.
  -- It may reach the user's own rows only; the owner checks everyone else's below.
  perform pg_temp.update_reaches_only_own_rows('an unfiltered UPDATE of profiles reaches only the user''s own row',
    'profiles', $q$ display_name = 'Unfiltered update' $q$);
  perform pg_temp.update_reaches_only_own_rows('an unfiltered UPDATE of notifications reaches only the user''s own rows',
    'notifications', $q$ read_at = now() $q$);

  -- Rows no policy lets a user create or remove: RLS under 017, the grant under 019.
  if p019 then
    perform pg_temp.rejects_with_message('[ACL] a user cannot delete their own profile',
      format('delete from public.profiles where user_id = %L', a), '42501', 'permission denied for table profiles');
    perform pg_temp.rejects_with_message('[ACL] a user cannot create a profile',
      format($q$ insert into public.profiles (user_id, email) values (%L, 'x@test.invalid') $q$, a),
      '42501', 'permission denied for table profiles');
  else
    perform pg_temp.filtered_by_rls('a user''s DELETE of their own profile matches no row (no delete policy)',
      format('delete from public.profiles where user_id = %L', a));
    perform pg_temp.rejects_with_message('[RLS] a user cannot create a profile (no insert policy)',
      format($q$ insert into public.profiles (user_id, email) values (%L, 'x@test.invalid') $q$, a),
      '42501', 'new row violates row-level security policy for table "profiles"');
  end if;
  perform pg_temp.rejects_with_message('[ACL] a user cannot delete a notification',
    format('delete from public.notifications where user_id = %L', a), '42501', 'permission denied for table notifications');
end;
$$;

-- The guard triggers are the second lock: with a column grant widened, as a
-- later migration might widen it, they still refuse. These grants exist only
-- inside this transaction and are revoked straight after.
reset role;
grant update (tier_code) on public.profiles to authenticated;
grant update (title) on public.notifications to authenticated;
set local role authenticated;
select pg_temp.rejects_with_message('[trigger] guard_profile_privileged_columns refuses tier_code where a grant allows the column',
  $q$ update public.profiles set tier_code = 'TIER_2' where user_id = '00000000-0000-4000-8000-0000000000a1' $q$,
  '42501', 'profiles: user_id, email, tier_code, status and kyc_status are not user-writable');
select pg_temp.rejects_with_message('[trigger] guard_notification_columns refuses title where a grant allows the column',
  $q$ update public.notifications set title = 'Changed' where user_id = '00000000-0000-4000-8000-0000000000a1' $q$,
  '42501', 'notifications: only read_at and status may be changed by the recipient');
reset role;
revoke update (tier_code) on public.profiles from authenticated;
revoke update (title) on public.notifications from authenticated;

-- What RLS kept out of reach, checked by the one role that sees every row:
-- no other user's profile or notification carries anything Alice wrote.
select pg_temp.holds('[RLS] no other user''s profile or notification was changed by the user, checked as the owner',
  exists (select 1 from public.profiles where user_id <> '00000000-0000-4000-8000-0000000000a1')
  and not exists (select 1 from public.profiles
                  where user_id <> '00000000-0000-4000-8000-0000000000a1'
                    and display_name in ('Hijacked', 'Not yours', 'Unfiltered update'))
  and exists (select 1 from public.notifications where user_id <> '00000000-0000-4000-8000-0000000000a1')
  and not exists (select 1 from public.notifications
                  where user_id <> '00000000-0000-4000-8000-0000000000a1' and read_at is not null));

-- -----------------------------------------------------------------------------
-- anon
-- -----------------------------------------------------------------------------

do $$ begin perform set_config('request.jwt.claims', null, true); end; $$;
set local role anon;

do $$
declare
  p019 boolean := pg_temp.profile() = '019';
  ref  text[]  := array['account_tiers', 'asset_networks', 'assets', 'fee_rules', 'tier_limits', 'trading_pairs'];
  t    text;
begin
  foreach t in array ref loop
    perform pg_temp.reads(format('[ACL+RLS] an anonymous visitor reads reference table %s', t),
                          format('select count(*) > 0 from public.%I', t));
  end loop;
  -- Every other table: no anon policy; 019 also withdraws SELECT.
  for t in select c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> all (ref)
           order by 1 loop
    perform pg_temp.sees_no_forbidden_rows(format('an anonymous visitor cannot read %s', t), t, 'true',
                                           case when p019 then 'ACL' else 'RLS' end);
  end loop;
  if p019 then
    perform pg_temp.rejects_with_message('[ACL] an anonymous visitor cannot update a notification',
      $q$ update public.notifications set read_at = now() $q$, '42501', 'permission denied for table notifications');
  else
    perform pg_temp.filtered_by_rls('an anonymous visitor''s UPDATE of notifications matches no row',
      $q$ update public.notifications set read_at = now() $q$);
  end if;
end;
$$;

reset role;

-- -----------------------------------------------------------------------------
-- service_role (the admin client)
-- -----------------------------------------------------------------------------

set local role service_role;

do $$
declare
  a    uuid := '00000000-0000-4000-8000-0000000000a1';
  p019 boolean := pg_temp.profile() = '019';
begin
  -- What the server writes.
  perform pg_temp.takes_effect('[ACL] service_role records an audit event',
    $q$ insert into public.audit_logs (action, actor_type) values ('tst.server', 'SYSTEM') $q$,
    $q$ select exists (select 1 from public.audit_logs where action = 'tst.server') $q$);
  perform pg_temp.takes_effect('[ACL] service_role records a risk decision',
    format($q$ insert into public.risk_events (user_id, subject_type, decision, rule_code)
               values (%L, 'withdrawal', 'REVIEW', 'TST_SERVER') $q$, a),
    $q$ select exists (select 1 from public.risk_events where rule_code = 'TST_SERVER') $q$);
  perform pg_temp.takes_effect('[ACL] service_role records the review of a risk decision',
    $q$ update public.risk_events set override_reason = 'reviewed' where rule_code = 'TST_SERVER' $q$,
    $q$ select exists (select 1 from public.risk_events where rule_code = 'TST_SERVER' and override_reason = 'reviewed') $q$);
  perform pg_temp.takes_effect('[ACL] service_role records a provider event',
    $q$ insert into public.provider_events (provider, event_id, event_type, payload_hash, payload)
        values ('test', 'tst-evt-2', 'test.event', 'tst-hash', '{}') $q$,
    $q$ select exists (select 1 from public.provider_events where event_id = 'tst-evt-2') $q$);
  perform pg_temp.takes_effect('[ACL] service_role marks a provider event processed',
    $q$ update public.provider_events set status = 'PROCESSED', processed_at = now() where event_id = 'tst-evt-2' $q$,
    $q$ select exists (select 1 from public.provider_events where event_id = 'tst-evt-2' and status = 'PROCESSED') $q$);
  perform pg_temp.takes_effect('[ACL] service_role stores an idempotency key',
    $q$ insert into public.idempotency_keys (scope, key, request_hash) values ('test', 'tst-key-2', 'tst-hash') $q$,
    $q$ select exists (select 1 from public.idempotency_keys where key = 'tst-key-2') $q$);
  perform pg_temp.takes_effect('[ACL] service_role deletes an expired idempotency key',
    $q$ delete from public.idempotency_keys where key = 'tst-key-2' $q$,
    $q$ select not exists (select 1 from public.idempotency_keys where key = 'tst-key-2') $q$);
  perform pg_temp.takes_effect('[ACL] service_role creates a notification',
    format($q$ insert into public.notifications (user_id, title, body) values (%L, 'From the server', 'Body') $q$, a),
    $q$ select exists (select 1 from public.notifications where title = 'From the server') $q$);
  perform pg_temp.takes_effect('[ACL] service_role marks a notification sent',
    $q$ update public.notifications set status = 'SENT', sent_at = now() where title = 'From the server' $q$,
    $q$ select exists (select 1 from public.notifications where title = 'From the server' and status = 'SENT') $q$);
  perform pg_temp.takes_effect('[ACL] service_role records a deposit',
    format($q$ insert into public.deposits (user_id, asset_id, amount, provider_reference)
               values (%L, (select id from public.assets where symbol = 'USDT'), '1', 'tst:server-deposit') $q$, a),
    $q$ select exists (select 1 from public.deposits where provider_reference = 'tst:server-deposit') $q$);
  perform pg_temp.takes_effect('[trigger] guard_profile_privileged_columns lets service_role change a tier',
    format($q$ update public.profiles set tier_code = 'TIER_1' where user_id = %L $q$, a),
    format($q$ select exists (select 1 from public.profiles where user_id = %L and tier_code = 'TIER_1') $q$, a));

  -- Status guards fire for service_role too, which 019 leaves without TRIGGER.
  perform pg_temp.rejects_with_message('[trigger] guard_withdrawal_status_transition refuses service_role reopening a failed withdrawal',
    $q$ update public.withdrawals set status = 'REQUESTED' where idempotency_key = 'tst-idem-1' $q$,
    '23001', 'withdrawal ');

  -- Append-only tables. 017 leaves UPDATE and DELETE granted and the trigger
  -- refuses; 019 withdraws them, so the grant refuses first.
  if p019 then
    perform pg_temp.rejects_with_message('[ACL] service_role cannot update audit_logs',
      $q$ update public.audit_logs set action = 'x' $q$, '42501', 'permission denied for table audit_logs');
    perform pg_temp.rejects_with_message('[ACL] service_role cannot delete audit_logs',
      $q$ delete from public.audit_logs $q$, '42501', 'permission denied for table audit_logs');
    perform pg_temp.rejects_with_message('[ACL] service_role cannot update limit_usage',
      $q$ update public.limit_usage set reference_type = 'x' $q$, '42501', 'permission denied for table limit_usage');
    perform pg_temp.rejects_with_message('[ACL] service_role cannot delete limit_usage',
      $q$ delete from public.limit_usage $q$, '42501', 'permission denied for table limit_usage');
    perform pg_temp.rejects_with_message('[ACL] service_role cannot delete risk_events',
      $q$ delete from public.risk_events $q$, '42501', 'permission denied for table risk_events');
    perform pg_temp.rejects_with_message('[ACL] service_role cannot truncate audit_logs',
      $q$ truncate public.audit_logs $q$, '42501', 'permission denied for table audit_logs');
    perform pg_temp.rejects_with_message('[ACL] service_role cannot truncate risk_events',
      $q$ truncate public.risk_events $q$, '42501', 'permission denied for table risk_events');
  else
    perform pg_temp.rejects_with_message('[trigger] service_role cannot update audit_logs',
      $q$ update public.audit_logs set action = 'x' $q$, '23001', 'public.audit_logs is append-only; UPDATE');
    perform pg_temp.rejects_with_message('[trigger] service_role cannot delete audit_logs',
      $q$ delete from public.audit_logs $q$, '23001', 'public.audit_logs is append-only; DELETE');
    perform pg_temp.rejects_with_message('[trigger] service_role cannot update limit_usage',
      $q$ update public.limit_usage set reference_type = 'x' $q$, '23001', 'public.limit_usage is append-only; UPDATE');
    perform pg_temp.rejects_with_message('[trigger] service_role cannot delete limit_usage',
      $q$ delete from public.limit_usage $q$, '23001', 'public.limit_usage is append-only; DELETE');
    perform pg_temp.rejects_with_message('[trigger] service_role cannot delete risk_events',
      $q$ delete from public.risk_events $q$, '23001', 'public.risk_events is append-only; DELETE');
  end if;
  -- In every profile: 017 already withdrew these.
  perform pg_temp.rejects_with_message('[ACL] service_role cannot update ledger_entries',
    $q$ update public.ledger_entries set reference_type = 'x' $q$, '42501', 'permission denied for table ledger_entries');
  perform pg_temp.rejects_with_message('[ACL] service_role cannot delete ledger_entries',
    $q$ delete from public.ledger_entries $q$, '42501', 'permission denied for table ledger_entries');
  perform pg_temp.rejects_with_message('[ACL] service_role cannot truncate ledger_entries',
    $q$ truncate public.ledger_entries $q$, '42501', 'permission denied for table ledger_entries');
  perform pg_temp.rejects_with_message('[ACL] service_role cannot truncate limit_usage',
    $q$ truncate public.limit_usage $q$, '42501', 'permission denied for table limit_usage');
end;
$$;

reset role;

-- -----------------------------------------------------------------------------
-- The table owner
--
-- The owner holds every privilege implicitly; no REVOKE takes them away, so
-- nothing here expects one to. On the append-only tables only the triggers
-- stand in its way — and the owner can disable a trigger. That is a separate
-- trust boundary (docs/review-019-privileges.md), not something a test of the
-- grants can close.
-- -----------------------------------------------------------------------------

do $$
declare
  p019 boolean := pg_temp.profile() = '019';
  t    text;
begin
  foreach t in array array['audit_logs', 'ledger_entries', 'limit_usage'] loop
    perform pg_temp.rejects_with_message(format('[trigger] the owner cannot update %s', t),
      format('update public.%I set id = id', t), '23001', format('public.%s is append-only; UPDATE', t));
    perform pg_temp.rejects_with_message(format('[trigger] the owner cannot delete from %s', t),
      format('delete from public.%I', t), '23001', format('public.%s is append-only; DELETE', t));
  end loop;
  perform pg_temp.rejects_with_message('[trigger] the owner cannot delete from risk_events',
    'delete from public.risk_events', '23001', 'public.risk_events is append-only; DELETE');
  foreach t in array case when p019 then array['audit_logs', 'ledger_entries', 'limit_usage', 'risk_events']
                          else array['ledger_entries', 'limit_usage'] end loop
    perform pg_temp.rejects_with_message(format('[trigger] the owner cannot truncate %s', t),
      format('truncate public.%I', t), '23001', format('public.%s is append-only; TRUNCATE', t));
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- EXECUTE: every function in public, called as every client role
-- -----------------------------------------------------------------------------

create temporary table function_calls (
  name      text primary key,
  call      text not null,
  executors text[] not null
) on commit drop;
grant select on function_calls to public;

do $$
declare
  c    uuid := '00000000-0000-4000-8000-0000000000c3';
  usdt uuid := (select id from public.assets where symbol = 'USDT');
  btc  uuid := (select id from public.assets where symbol = 'BTC');
  q    uuid;
  t    text;
begin
  insert into public.swap_quotes (user_id, from_asset_id, to_asset_id, from_amount,
                                  rate, fee, output_amount, rate_source, expires_at)
  values (c, usdt, btc, 1000, 0.00002, 5, 0.0199, 'test', now() + interval '5 min')
  returning id into q;

  -- Called by the server only (scripts/privilege-registry.ts names the caller).
  insert into function_calls (name, call, executors) values
    ('ledger_post', format($q$ select public.ledger_post(%L, %L, 'DEPOSIT', '1', '1', '0', 'test', null, 'tst:execute') $q$, c, usdt), '{service_role}'),
    ('consume_quote', format('select * from public.consume_quote(%L, %L, null)', q, c), '{service_role}'),
    ('reconcile_wallets', 'select * from public.reconcile_wallets()', '{service_role}'),
    ('limit_usage_total', format($q$ select public.limit_usage_total(%L, 'SWAP', 'USD', now()) $q$, c), '{service_role}'),
    ('claim_deposit_for_credit', format('select public.claim_deposit_for_credit(%L)', gen_random_uuid()), '{service_role}'),
    ('claim_provider_event', format('select public.claim_provider_event(%L)', gen_random_uuid()), '{service_role}'),
    ('expire_stale_quotes', 'select public.expire_stale_quotes()', '{service_role}'),
    ('mark_trade_settled', format('select public.mark_trade_settled(%L)', gen_random_uuid()), '{service_role}'),
    ('release_withdrawal_hold', format('select public.release_withdrawal_hold(%L)', gen_random_uuid()), '{service_role}'),
    -- They answer for auth.uid(). 017 keeps Supabase's default grant to
    -- service_role; 019 withdraws it, and no role is granted it instead.
    ('is_admin', 'select public.is_admin()',
     case when pg_temp.profile() = '017' then '{service_role}' else '{}' end::text[]),
    ('has_admin_role', $q$ select public.has_admin_role(array['SUPER_ADMIN']::public.admin_role[]) $q$,
     case when pg_temp.profile() = '017' then '{service_role}' else '{}' end::text[]);
  -- Trigger functions: PostgreSQL calls them; no role does.
  foreach t in array array['forbid_mutation', 'guard_notification_columns', 'guard_order_status_transition',
                           'guard_profile_privileged_columns', 'guard_swap_status_transition',
                           'guard_withdrawal_status_transition', 'handle_new_user', 'touch_updated_at'] loop
    insert into function_calls (name, call, executors) values (t, format('select public.%I()', t), '{}');
  end loop;
end;
$$;

select pg_temp.holds('every function in public has an EXECUTE expectation, and every expectation a function',
  (select array_agg(p.proname::text order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace)
  = (select array_agg(f.name order by f.name) from function_calls f));

set local role anon;
select pg_temp.execute_matrix();
reset role;
do $$ begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-8000-0000000000a1',
                      'role', 'authenticated')::text, true);
end; $$;
set local role authenticated;
select pg_temp.execute_matrix();
reset role;
do $$ begin perform set_config('request.jwt.claims', null, true); end; $$;
set local role service_role;
select pg_temp.execute_matrix();
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
