-- =============================================================================
-- JimoCex — Supabase primitives, stubbed for a local PostgreSQL cluster
--
-- The migrations depend on four things a hosted Supabase project provides and a
-- bare PostgreSQL cluster does not: the `anon` / `authenticated` / `service_role`
-- roles, the `auth` schema, `auth.users`, and `auth.uid()`.
--
-- This file recreates just enough of them to apply the real migrations
-- unchanged and exercise the real policies. It is TEST SCAFFOLDING: it is never
-- applied to the hosted project, where the genuine articles already exist.
--
-- The one behaviour that matters for the RLS tests is `auth.uid()` reading the
-- `request.jwt.claims` GUC, because that is how Supabase passes the signed-in
-- user down to a policy. The stub matches that contract exactly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles
--
-- `service_role` carries BYPASSRLS in a real project; that is the whole reason
-- server-side code must check authorization itself. Reproduced here so a test
-- cannot accidentally pass by relying on RLS the server does not get.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants table privileges to the client roles by default and relies on
-- RLS to constrain them. Mirrored here, including the default for tables the
-- migrations create later — otherwise a policy test would pass for the wrong
-- reason (no privilege rather than no policy). ALL, as on the hosted project:
-- that includes TRUNCATE, REFERENCES and TRIGGER, which a narrower stub would
-- hide from the catalog check. Sequences get USAGE, SELECT and UPDATE, also as
-- on the hosted project.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select, update on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- auth schema
-- -----------------------------------------------------------------------------

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  aud        text default 'authenticated',
  role       text default 'authenticated',
  created_at timestamptz not null default now()
);

-- The real auth.uid() reads the request's JWT claims out of a GUC. Same here, so
-- `set_config('request.jwt.claims', ...)` drives the policies in tests exactly
-- as a signed-in request drives them in production.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- Supabase records applied migrations here; the local runner writes to it too so
-- the two environments can be compared.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name    text,
  statements text[]
);
