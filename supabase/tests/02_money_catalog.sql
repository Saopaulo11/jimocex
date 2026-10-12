-- =============================================================================
-- JimoCex — catalog snapshot for the money registry check
--
-- Not an assertion suite. Emits one JSON document describing every column,
-- CHECK constraint, function and privilege in `public`, as the migrations
-- actually built them. scripts/check-money-catalog.ts compares it with
-- src/lib/db/money-columns.ts, and scripts/check-privileges.ts with
-- scripts/privilege-registry.ts, so both registries are checked against the
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
),
-- The table privileges this server knows. MAINTAIN exists from PostgreSQL 17
-- on, and naming it on 16 is an error, so the list comes from the version
-- instead of being written into a has_table_privilege() call.
table_privilege_kinds(kind, ord) as (
  select k, o
  from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
              || case when current_setting('server_version_num')::integer >= 170000
                      then array['MAINTAIN'] else array[]::text[] end) with ordinality as u(k, o)
),
privilege_roles(name) as (
  values ('anon'), ('authenticated'), ('service_role'), ('public')
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
               'PUBLIC',        has_function_privilege('public', p.oid, 'execute'),
               'anon',          has_function_privilege('anon', p.oid, 'execute'),
               'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
               'service_role',  has_function_privilege('service_role', p.oid, 'execute')),
             'securityDefiner', p.prosecdef,
             'config', coalesce(to_json(p.proconfig), '[]'::json),
             'owner', pg_get_userbyid(p.proowner),
             -- Explicit EXECUTE grants to anyone but the owner and the roles above.
             'otherGrantees', (
               select coalesce(json_agg(distinct pg_get_userbyid(a.grantee)), '[]'::json)
               from aclexplode(p.proacl) a
               where a.grantee <> 0 and a.grantee <> p.proowner
                 and pg_get_userbyid(a.grantee) not in ('anon', 'authenticated', 'service_role')),
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
  -- Who could execute a function postgres creates in public next, by default:
  -- the global default — PostgreSQL's built-in one, EXECUTE for PUBLIC, when
  -- there is no global row — plus the per-schema one. Reading only the
  -- per-schema row misses PUBLIC, which every role inherits.
  'defaultFunctionGrants', (
    select coalesce(json_agg(distinct g.name order by g.name), '[]'::json)
    from (
      select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as name
      from aclexplode(coalesce(
             (select d.defaclacl from pg_default_acl d
               where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'),
             acldefault('f', 'postgres'::regrole))) a
      where a.privilege_type = 'EXECUTE'
      union all
      select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
      from pg_default_acl d, aclexplode(d.defaclacl) a
      where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
        and d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE'
    ) g
    where g.name in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ),
  'truncateTriggers', (
    select coalesce(json_agg(c.relname order by c.relname), '[]'::json)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and (t.tgtype::int & 32) <> 0   -- TRIGGER_TYPE_TRUNCATE
  ),
  -- The exact privilege state of public, for scripts/check-privileges.ts.
  'privileges', json_build_object(
    'serverVersionNum', current_setting('server_version_num')::integer,
    'tableKinds', (select json_agg(k.kind order by k.ord) from table_privilege_kinds k),
    'relations', (
      select coalesce(json_agg(json_build_object(
               'name', c.relname, 'kind', c.relkind::text, 'rls', c.relrowsecurity,
               'force', c.relforcerowsecurity, 'owner', pg_get_userbyid(c.relowner))
             order by c.relname), '[]'::json)
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    ),
    -- Effective privileges (has_table_privilege: direct, through PUBLIC, through
    -- role membership), every kind, every client role and PUBLIC.
    'tableAcl', (
      select coalesce(json_agg(json_build_object(
               'table', c.relname,
               'role', r.name,
               'privileges', (select coalesce(json_agg(k.kind order by k.ord), '[]'::json)
                              from table_privilege_kinds k
                              where has_table_privilege(r.name, c.oid, k.kind)))
             order by c.relname, r.name), '[]'::json)
      from pg_class c
      cross join privilege_roles r
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
    ),
    -- Explicit table grants to anyone but the owner, PUBLIC and the client roles.
    'otherTableGrantees', (
      select coalesce(json_agg(format('%s: %s %s', c.relname, pg_get_userbyid(a.grantee), a.privilege_type)
                               order by c.relname, a.privilege_type), '[]'::json)
      from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and a.grantee <> 0 and a.grantee <> c.relowner
        and pg_get_userbyid(a.grantee) not in ('anon', 'authenticated', 'service_role')
    ),
    -- Column-level grants: they exist only explicitly, in pg_attribute.attacl.
    'columnAcl', (
      select coalesce(json_agg(json_build_object(
               'table', c.relname,
               'column', att.attname,
               'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
               'privilege', a.privilege_type)
             order by c.relname, att.attname, a.grantee, a.privilege_type), '[]'::json)
      from pg_attribute att
      join pg_class c on c.oid = att.attrelid
      cross join aclexplode(att.attacl) a
      where c.relnamespace = 'public'::regnamespace and att.attnum > 0 and not att.attisdropped
    ),
    -- Every RLS policy, whole: the registry pins them, and a function a policy
    -- calls is checked against the roles the policy applies to.
    'policies', (
      select coalesce(json_agg(json_build_object(
               'table', c.relname,
               'name', pol.polname,
               'cmd', pol.polcmd::text,
               'permissive', pol.polpermissive,
               'roles', (select json_agg(case when r = 0 then 'PUBLIC' else pg_get_userbyid(r) end order by 1)
                         from unnest(pol.polroles) r),
               'using', pg_get_expr(pol.polqual, pol.polrelid),
               'check', pg_get_expr(pol.polwithcheck, pol.polrelid),
               'expr', concat_ws(' ', pg_get_expr(pol.polqual, pol.polrelid),
                                      pg_get_expr(pol.polwithcheck, pol.polrelid)))
             order by c.relname, pol.polname), '[]'::json)
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      where c.relnamespace = 'public'::regnamespace
    ),
    -- The client roles themselves: attributes, and every membership that
    -- involves them in either direction (inherited or SET-only alike).
    'roles', (
      select coalesce(json_agg(json_build_object(
               'name', r.rolname, 'super', r.rolsuper, 'inherit', r.rolinherit,
               'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb,
               'replication', r.rolreplication, 'login', r.rolcanlogin, 'bypassrls', r.rolbypassrls)
             order by r.rolname), '[]'::json)
      from pg_roles r
      where r.rolname in ('anon', 'authenticated', 'service_role')
    ),
    'memberships', (
      select coalesce(json_agg(json_build_object(
               'role', pg_get_userbyid(m.roleid),
               'member', pg_get_userbyid(m.member),
               -- PostgreSQL 16 records INHERIT and SET per membership; on 15 they are absent (null).
               'inherit', (to_jsonb(m) ->> 'inherit_option')::boolean,
               'set', (to_jsonb(m) ->> 'set_option')::boolean,
               'admin', m.admin_option)
             order by pg_get_userbyid(m.roleid), pg_get_userbyid(m.member)), '[]'::json)
      from pg_auth_members m
      where pg_get_userbyid(m.roleid) in ('anon', 'authenticated', 'service_role')
         or pg_get_userbyid(m.member) in ('anon', 'authenticated', 'service_role')
    ),
    -- Who may use, and who may create objects in, schema public.
    'schemaPublic', (
      select json_agg(json_build_object(
               'role', r.name,
               'usage', has_schema_privilege(r.name, 'public', 'USAGE'),
               'create', has_schema_privilege(r.name, 'public', 'CREATE'))
             order by r.name)
      from privilege_roles r
    )
  )
);
