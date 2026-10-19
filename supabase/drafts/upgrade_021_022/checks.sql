-- =============================================================================
-- JimoCex — upgrade 021 → 022: read-only checks (package upgrade_021_022)
--
-- ONE read-only SELECT. It changes nothing, and runs where a read-only
-- transaction is enforced:
--
--   psql -X -q -At -1 -v ON_ERROR_STOP=1 -d "<connection>" \
--        -c 'set transaction read only' -f checks.sql
--
-- Each row is  phase | id | check | ok | detail :
--   pre   the database is exactly the 021 state this package upgrades;
--   post  the database is what 022 defines, and its money is consistent;
--   data  one row per table in public: its row count and the md5 of all its
--         rows. Informational; apply.sql compares them before and after 022.
-- The verdicts are rows P99 and Q99. Before the upgrade the result must hold
--   pre|P99|VERDICT|t|READY        (and post|Q99 is f: 022 is not there yet);
-- after it
--   post|Q99|VERDICT|t|PASS        (and pre|P99 is f: 022 is there now).
--
-- apply.sql embeds this text (without the final ";") and runs the same checks
-- inside its own statement, so there is one definition of "021" and "022".
--
-- The fingerprint is the item query of package v4 (supabase/drafts/v4) without
-- the categories a hosted platform or the data decide: default privileges
-- (defacl), the schema's own ACL (nspacl) and tier_limits rows (tier). Its
-- expected values come from clean local builds of 001–021 and 001–022 on
-- PostgreSQL 16.15 and 17.10, which agree except for table privileges, where
-- PostgreSQL 17 adds MAINTAIN; those are pinned per major version.
--
-- No 'SUBMITTED' enum literal appears below: inside apply.sql's statement the
-- value is new and may not be used before it commits, so statuses are compared
-- as text.
-- =============================================================================
with
items as (
    select x from (
      select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || ' nn=' || a.attnotnull::text || ' gen=' || a.attgenerated::text
           || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as x
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
    union all
    select 'rel ' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
           || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
    union all
    select 'con ' || c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
    from pg_constraint con join pg_class c on c.oid = con.conrelid where c.relnamespace = 'public'::regnamespace
    union all
    select 'idx ' || ci.relname || ' ' || pg_get_indexdef(i.indexrelid)
    from pg_index i join pg_class c on c.oid = i.indrelid join pg_class ci on ci.oid = i.indexrelid
    where c.relnamespace = 'public'::regnamespace
    union all
    select 'trg ' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid) || ' en=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
    union all
    select 'pol ' || pol.tablename || '.' || pol.policyname || ' ' || pol.permissive || ' ' || pol.cmd || ' '
           || array_to_string(pol.roles, ',') || ' u=' || coalesce(pol.qual, '') || ' c=' || coalesce(pol.with_check, '')
    from pg_policies pol where pol.schemaname = 'public'
    union all
    select 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid)
           || ' kind=' || p.prokind::text || ' lang=' || l.lanname || ' secdef=' || p.prosecdef::text
           || ' strict=' || p.proisstrict::text || ' vol=' || p.provolatile::text || ' owner=' || pg_get_userbyid(p.proowner)
           || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '') || ' src=' || md5(p.prosrc)
           || ' comment=' || md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
    from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace = 'public'::regnamespace
    union all
    select 'fnacl ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
           || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace
      and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))
    union all
    select 'relacl ' || c.relname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
           || ' ' || a.privilege_type
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
      and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))
    union all
    select 'colacl ' || c.relname || '.' || at.attname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
           || ' ' || a.privilege_type
    from pg_class c join pg_attribute at on at.attrelid = c.oid and at.attnum > 0 and not at.attisdropped and at.attacl is not null,
         aclexplode(at.attacl) a
    where c.relnamespace = 'public'::regnamespace
    union all
    select 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typnamespace = 'public'::regnamespace group by t.typname
    union all
    select 'typ ' || t.typname || ' ' || t.typtype::text || ' owner=' || pg_get_userbyid(t.typowner)
           || case when t.typtype = 'd' then ' base=' || format_type(t.typbasetype, t.typtypmod) else '' end
    from pg_type t
    where t.typnamespace = 'public'::regnamespace and t.typtype in ('d','r','m','p')
       or (t.typnamespace = 'public'::regnamespace and t.typtype = 'c'
           and (select relkind from pg_class where oid = t.typrelid) = 'c')
    union all
    select 'cmt ' || c.relname || coalesce('.' || a.attname, '') || ' ' || md5(d.description)
    from pg_description d join pg_class c on d.classoid = 'pg_class'::regclass and d.objoid = c.oid
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
    where c.relnamespace = 'public'::regnamespace
    ) f
),
cats as (
  select split_part(x, ' ', 1) as cat, count(*)::int as n, md5(string_agg(x, E'\n' order by x collate "C")) as h
  from items group by 1
),
major as (
  select current_setting('server_version_num')::int / 10000 as v
),
expected(phase, major, cat, n, h) as (values
    ('pre', 0, 'cmt', 21, '8b3adbd1a160f961e42043d00e484147'),
    ('pre', 0, 'col', 277, '22f8b1407dba0cf8a6b99a55439c0448'),
    ('pre', 0, 'con', 175, '7b29e7ded5c1e91b4730e8ebc8533066'),
    ('pre', 0, 'enum', 23, '7e8df1e2362fbcb93654cd34fc7a2f5c'),
    ('pre', 0, 'fn', 22, 'c3221040d70f29d32be53c503ee0cfb7'),
    ('pre', 0, 'fnacl', 14, '8a4c1a2b1e874252b41cc199f4b5c808'),
    ('pre', 0, 'idx', 89, '17ba2c1343ecd4e4623257b5d4e88411'),
    ('pre', 0, 'pol', 21, 'c67636e4695253bbe6248788bca8272b'),
    ('pre', 0, 'rel', 23, 'e2a9bdb7a79a3e1607739e8f17478753'),
    ('pre', 0, 'trg', 26, '1f9c141438b9c84603617c67f0ee1b57'),
    ('pre', 16, 'relacl', 335, 'f503a5a53d66089fff6fa4b42d366f76'),
    ('pre', 17, 'relacl', 404, 'c17e9933ba74f96504f14ca4e3522ce1'),
    ('post', 0, 'cmt', 21, '8b3adbd1a160f961e42043d00e484147'),
    ('post', 0, 'col', 277, '22f8b1407dba0cf8a6b99a55439c0448'),
    ('post', 0, 'con', 175, '7b29e7ded5c1e91b4730e8ebc8533066'),
    ('post', 0, 'enum', 23, 'd8b4a0674a13b6bd8d941483cce60b13'),
    ('post', 0, 'fn', 25, '47a6400add27cd70d900025a708b7b77'),
    ('post', 0, 'fnacl', 17, 'd735dfc24950a89c7386efe483d0a6af'),
    ('post', 0, 'idx', 89, '17ba2c1343ecd4e4623257b5d4e88411'),
    ('post', 0, 'pol', 21, 'c67636e4695253bbe6248788bca8272b'),
    ('post', 0, 'rel', 23, 'e2a9bdb7a79a3e1607739e8f17478753'),
    ('post', 0, 'trg', 26, '1f699ac84420a1c1292153d24efe8b72'),
    ('post', 16, 'relacl', 335, 'f503a5a53d66089fff6fa4b42d366f76'),
    ('post', 17, 'relacl', 404, 'c17e9933ba74f96504f14ca4e3522ce1')
),
fingerprint as (
  select ph.phase,
         (select string_agg(k, ', ' order by k) from (
            select coalesce(e.cat, c.cat) as k
            from (select x.cat, x.n, x.h from expected x, major m
                   where x.phase = ph.phase and x.major in (0, m.v)) e
            full join cats c on c.cat = e.cat
            where e.cat is null or c.cat is null or e.n <> c.n or e.h <> c.h) d) as differing
  from (values ('pre'), ('post')) ph(phase)
),
-- The six functions 022 creates or replaces: body md5, privileges, security, settings, owner.
fn as (
  select p.proname || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') || ' secdef=' || p.prosecdef::text
         || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' owner=' || pg_get_userbyid(p.proowner) as x
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('apply_fill', 'cancel_order', 'claim_order_for_submission', 'finalize_venue_cancellation',
                      'guard_order_status_transition', 'record_provider_order_id')
),
fn_pre(x) as (values
  ('apply_fill 022b50cd255044276345cb7cfce22440 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('cancel_order 5c4b860927a9cf53ed0dc23d3d17a64b {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('guard_order_status_transition fb5b7bbd098e845a9ceb3c386ef23263 {postgres=X/postgres} secdef=false cfg=search_path="" owner=postgres')
),
fn_post(x) as (values
  ('apply_fill dd3db24b426fe00f686f5b42b1ddd092 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('cancel_order 01a61a2b4c7bec26a25a193ecd2a7b2f {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('claim_order_for_submission 9b1b718ada7b269c294fc57a9c01db74 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('finalize_venue_cancellation fe297e37936f3f62ec74006edd56fb85 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('guard_order_status_transition 80cd7c63168758d16a2c3468609e6f08 {postgres=X/postgres} secdef=false cfg=search_path="" owner=postgres'),
  ('record_provider_order_id ef9eaa4b415b536f8b2d856474b3f8ec {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres')
),
labels as (
  select string_agg(e.enumlabel, ',' order by e.enumsortorder) as l
  from pg_enum e where e.enumtypid = 'public.order_status'::regtype
),
guard_trigger as (
  select string_agg(pg_get_triggerdef(t.oid), ' | ') as d
  from pg_trigger t where t.tgrelid = 'public.trading_orders'::regclass and t.tgname = 'trading_orders_status_guard'
),
statuses as (
  select coalesce(string_agg(s.st || '=' || s.n, ' ' order by s.st), 'none') as d,
         coalesce(sum(s.n) filter (where s.st in ('PENDING', 'PARTIALLY_FILLED', 'SUBMITTED')), 0) as stranded
  from (select o.status::text as st, count(*) as n from public.trading_orders o group by 1) s
),
history as (
  select to_regclass('supabase_migrations.schema_migrations') is not null as present,
         case when to_regclass('supabase_migrations.schema_migrations') is null then 0
              else (xpath('/row/n/text()', query_to_xml(
                     'select count(*) as n from supabase_migrations.schema_migrations', false, true, '')))[1]::text::int
         end as n
),
-- Per order: what its HOLD/RELEASE rows and its trades' rows moved in and out of
-- the lock must be exactly what it still holds.
order_locks as (
  select o.id, o.status::text as st, o.locked_amount, o.locked_asset_id, o.filled_amount,
         coalesce((select sum(l.locked_delta) from public.ledger_entries l
                    where (l.reference_type = 'order' and l.reference_id = o.id)
                       or (l.reference_type = 'trade' and l.reference_id in
                             (select t.id from public.trades t where t.buy_order_id = o.id or t.sell_order_id = o.id))), 0) as ledger_locked,
         coalesce((select sum(t.amount) from public.trades t where t.buy_order_id = o.id or t.sell_order_id = o.id), 0) as traded
  from public.trading_orders o
),
money as (
  select
    (select count(*) from order_locks where locked_amount <> ledger_locked) as lock_vs_ledger,
    (select count(*) from order_locks where filled_amount <> traded) as filled_vs_trades,
    (select count(*) from order_locks
      where locked_amount > 0 and (st not in ('OPEN', 'SUBMITTED', 'PARTIALLY_FILLED') or locked_asset_id is null)) as stray_locks,
    (select count(*) from order_locks where st = 'OPEN' and filled_amount <> 0) as open_with_fills,
    (select count(*) from public.ledger_entries l
      where l.reference_type = 'order' and not exists (select 1 from public.trading_orders o where o.id = l.reference_id)) as orphan_order_rows,
    (select count(*) from public.reconcile_wallets()) as wallet_drift
),
checks(phase, id, name, ok, detail) as (
  -- ---------------------------------------------------------------- pre: exactly 021
  select 'pre', 'P01', 'role owns the functions 022 replaces',
         current_user = 'postgres'
           and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('apply_fill', 'cancel_order', 'guard_order_status_transition')
                 and p.proowner = (select oid from pg_roles where rolname = current_user)) = 3,
         'current_user ' || current_user
  union all
  select 'pre', 'P02', 'server and session',
         (select v from major) in (16, 17) and current_setting('transaction_isolation') = 'read committed',
         'PostgreSQL ' || current_setting('server_version') || ', ' || current_setting('transaction_isolation')
  union all
  select 'pre', 'P03', 'no migration history from another mechanism',
         (select n from history) = 0,
         case when (select present from history) then 'schema_migrations has ' || (select n from history) || ' rows'
              else 'no schema_migrations table' end
  union all
  select 'pre', 'P04', '022 not applied: order_status has no SUBMITTED',
         (select l from labels) = 'PENDING,OPEN,PARTIALLY_FILLED,FILLED,CANCELLED,REJECTED,EXPIRED',
         (select l from labels)
  union all
  select 'pre', 'P05', '022 not applied: none of its three new functions exists',
         not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('claim_order_for_submission', 'record_provider_order_id', 'finalize_venue_cancellation')),
         (select coalesce(string_agg(p.oid::regprocedure::text, ', '), 'none') from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('claim_order_for_submission', 'record_provider_order_id', 'finalize_venue_cancellation'))
  union all
  select 'pre', 'P06', '021 applied: BTC-USDT, ETH-USDT and SOL-USDT trade',
         (select count(*) from public.trading_pairs where symbol in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT') and trading_enabled) = 3,
         'enabled: ' || coalesce((select string_agg(symbol, ' ' order by symbol) from public.trading_pairs where trading_enabled), 'none')
  union all
  select 'pre', 'P07', 'public schema is a clean 001-021 build',
         (select differing from fingerprint where phase = 'pre') is null,
         coalesce('differing: ' || (select differing from fingerprint where phase = 'pre'), 'all categories match')
  union all
  select 'pre', 'P08', 'the functions 022 replaces are 005/018/020''s, with their privileges',
         (select string_agg(x, E'\n' order by x) from fn) = (select string_agg(x, E'\n' order by x) from fn_pre),
         (select string_agg(split_part(x, ' ', 1) || ' ' || left(split_part(x, ' ', 2), 8), ', ' order by x) from fn)
  union all
  select 'pre', 'P09', 'no order 022 would strand (PENDING, PARTIALLY_FILLED)',
         (select stranded from statuses) = 0,
         (select d from statuses)
  union all
  select 'pre', 'P10', 'no venue order id is recorded',
         not exists (select 1 from public.trading_orders where provider_order_id is not null),
         (select count(provider_order_id) || ' set, ' || count(distinct provider_order_id) || ' distinct' from public.trading_orders)
  -- ---------------------------------------------------------------- post: what 022 defines
  union all
  select 'post', 'Q01', 'order_status is 021''s with SUBMITTED after OPEN',
         (select l from labels) = 'PENDING,OPEN,SUBMITTED,PARTIALLY_FILLED,FILLED,CANCELLED,REJECTED,EXPIRED',
         (select l from labels)
  union all
  select 'post', 'Q02', 'public schema is a clean 001-022 build',
         (select differing from fingerprint where phase = 'post') is null,
         coalesce('differing: ' || (select differing from fingerprint where phase = 'post'), 'all categories match')
  union all
  select 'post', 'Q03', 'the six functions are 022''s, with exactly its privileges',
         (select string_agg(x, E'\n' order by x) from fn) = (select string_agg(x, E'\n' order by x) from fn_post),
         (select string_agg(split_part(x, ' ', 1) || ' ' || left(split_part(x, ' ', 2), 8), ', ' order by x) from fn)
  union all
  select 'post', 'Q04', 'the status guard fires on status and provider_order_id',
         (select d from guard_trigger) = 'CREATE TRIGGER trading_orders_status_guard BEFORE UPDATE OF status, provider_order_id ON public.trading_orders FOR EACH ROW EXECUTE FUNCTION guard_order_status_transition()',
         coalesce((select d from guard_trigger), 'missing')
  union all
  select 'post', 'Q05', 'row-level security on every table, 21 policies',
         not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity)
           and (select count(*) from pg_policies where schemaname = 'public') = 21,
         (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity)
           || ' tables with RLS, ' || (select count(*) from pg_policies where schemaname = 'public') || ' policies'
  union all
  select 'post', 'Q06', 'no migration history written',
         (select n from history) = 0,
         case when (select present from history) then 'schema_migrations has ' || (select n from history) || ' rows'
              else 'no schema_migrations table' end
  -- ---------------------------------------------------------------- both: the money is consistent
  union all
  select ph.phase, ph.prefix || '1', 'every order''s lock equals its ledger rows',
         (select lock_vs_ledger from money) = 0, (select lock_vs_ledger from money) || ' orders differ'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '2', 'every filled amount equals its trades',
         (select filled_vs_trades from money) = 0, (select filled_vs_trades from money) || ' orders differ'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '3', 'funds are locked only by live orders, never by an OPEN order with fills',
         (select stray_locks + open_with_fills from money) = 0,
         (select stray_locks from money) || ' stray locks, ' || (select open_with_fills from money) || ' OPEN orders with fills'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '4', 'no order ledger row without its order',
         (select orphan_order_rows from money) = 0, (select orphan_order_rows from money) || ' rows'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '5', 'every wallet equals its ledger (reconcile_wallets)',
         (select wallet_drift from money) = 0, (select wallet_drift from money) || ' wallets differ'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
)
select c.phase, c.id, c.name, c.ok, c.detail from checks c
union all
select v.phase, v.id, 'VERDICT', coalesce(bool_and(c.ok), false),
       case when coalesce(bool_and(c.ok), false) then v.yes else v.no end
from (values ('pre', 'P99', 'READY', 'BLOCKED'), ('post', 'Q99', 'PASS', 'FAIL')) v(phase, id, yes, no)
left join checks c on c.phase = v.phase
group by v.phase, v.id, v.yes, v.no
union all
select 'data', c.relname, 'rows', true,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text
       || ' md5=' || (xpath('/row/h/text()', query_to_xml(format(
            'select md5(coalesce(string_agg(t::text, %L order by t::text), %L)) as h from public.%I t', E'\n', '', c.relname),
            false, true, '')))[1]::text
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by 1 desc, 2
;
