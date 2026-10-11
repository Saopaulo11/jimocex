-- =============================================================================
-- JimoCex — catalog snapshot for the money registry check
--
-- Not an assertion suite. Emits one JSON document describing every column,
-- CHECK constraint, function and balance-table privilege in `public`, as the
-- migrations actually built them. scripts/check-money-catalog.ts compares it
-- with src/lib/db/money-columns.ts, so the registry is checked against the
-- database itself rather than against a reading of the migration text.
-- =============================================================================

-- Every type that is, or contains, a numeric or float: arrays of one, domains
-- over one, composite types (including table row types) with one inside. A
-- money value hidden in any of them reaches PostgREST's JSON as a number all
-- the same.
with recursive numericish(oid) as (
  select t.oid from pg_type t where t.typname in ('numeric', 'float4', 'float8', 'money')
  union
  select t.oid
  from pg_type t
  join numericish n
    on t.typelem = n.oid
    or t.typbasetype = n.oid
    or (t.typrelid <> 0 and exists (
          select 1 from pg_attribute a
          where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped
            and a.atttypid = n.oid))
)
select json_build_object(
  'columns', (
    select json_agg(json_build_object(
             'table',     c.table_name,
             'column',    c.column_name,
             'type',      c.data_type,
             'precision', c.numeric_precision,
             'scale',     c.numeric_scale,
             'generated', c.is_generated = 'ALWAYS',
             'nullable',  c.is_nullable = 'YES')
           order by c.table_name, c.ordinal_position)
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  ),
  -- Columns whose type CONTAINS a numeric without being one: numeric[], a
  -- domain, a composite. None is allowed; a plain numeric column is checked
  -- against the registry above.
  'indirectNumericColumns', (
    select coalesce(json_agg(rel.relname || '.' || att.attname || ' ' || format_type(att.atttypid, att.atttypmod)
                             order by rel.relname, att.attname), '[]'::json)
    from pg_attribute att
    join pg_class rel on rel.oid = att.attrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and rel.relkind in ('r', 'p', 'v', 'm', 'f')
      and att.attnum > 0 and not att.attisdropped
      and att.atttypid in (select oid from numericish)
      and att.atttypid not in (select t.oid from pg_type t where t.typname in ('numeric', 'float4', 'float8', 'money'))
  ),
  'checks', (
    select json_agg(json_build_object(
             'table', rel.relname,
             'name',  con.conname,
             'def',   pg_get_constraintdef(con.oid))
           order by rel.relname, con.conname)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype = 'c'
  ),
  'views', (
    select coalesce(json_agg(c.relname order by c.relname), '[]'::json)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  ),
  'functions', (
    select json_agg(json_build_object(
             'name',      p.proname,
             'identity',  pg_get_function_identity_arguments(p.oid),
             'result',    pg_get_function_result(p.oid),
             'isTrigger', p.prorettype = 'trigger'::regtype,
             -- Every argument with its mode: i(n), o(ut), b(oth), v(ariadic),
             -- t(able column). Table columns are what RETURNS TABLE produces.
             'args', (
               select coalesce(json_agg(json_build_object(
                        'name', a.name,
                        'type', format_type(a.type, null),
                        'numericish', a.type in (select oid from numericish),
                        'mode', a.mode) order by a.ord), '[]'::json)
               from unnest(
                      coalesce(p.proallargtypes, p.proargtypes::oid[]),
                      p.proargnames,
                      coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs]))
                    ) with ordinality as a(type, name, mode, ord)
             ),
             -- A function returning a table's rowtype hands over all of its
             -- columns, so their types count as the result too.
             'rowtypeColumns', (
               select coalesce(json_agg(format_type(att.atttypid, null)), '[]'::json)
               from pg_type t
               join pg_attribute att on att.attrelid = t.typrelid
              where t.oid = p.prorettype and t.typrelid <> 0
                and att.attnum > 0 and not att.attisdropped
             ),
             'scalarResult', format_type(p.prorettype, null),
             'scalarNumericish', p.prorettype in (select oid from numericish),
             'executableBy', json_build_object(
               'anon',          has_function_privilege('anon', p.oid, 'execute'),
               'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
               'service_role',  has_function_privilege('service_role', p.oid, 'execute')),
             'source', p.prosrc)
           order by p.proname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ),
  -- What each client role may do to each table, beyond reading it.
  'tablePrivileges', (
    select json_agg(json_build_object(
             'table',     c.relname,
             'role',      r.name,
             'privilege', priv.name)
           order by c.relname, r.name, priv.name)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(name)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as priv(name)
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_table_privilege(r.name, c.oid, priv.name)
  ),
  'truncateTriggers', (
    select coalesce(json_agg(c.relname order by c.relname), '[]'::json)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and (t.tgtype::int & 32) <> 0   -- TRIGGER_TYPE_TRUNCATE
  )
);
