-- =============================================================================
-- JimoCex — 012_harden_functions
--
-- Closes two classes of exposure the database linter found after 010/011.
--
-- 1. Mutable search_path on the trigger functions.
--    Without `set search_path = ''`, name resolution inside these functions
--    follows the *caller's* search_path. A caller who can create objects in a
--    schema that resolves earlier can shadow a function or operator the body
--    relies on. The guards below are exactly the code that must not be
--    redirectable — they are what stops a tier change or a ledger edit — so they
--    get a pinned, empty search_path. `pg_catalog` is always searched first
--    regardless, so built-ins like now() keep resolving.
--
-- 2. SECURITY DEFINER functions reachable over the REST API.
--    Supabase exposes every function in `public` as /rest/v1/rpc/<name>.
--    `handle_new_user` is a signup trigger and has no business being callable at
--    all; `is_admin` and `has_admin_role` exist for policy evaluation, not for
--    clients to probe. All three are revoked from anon and authenticated.
--    A user who needs to know whether they are staff reads their own row
--    through the admin_users_self_read policy instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pin search_path on every trigger function
-- -----------------------------------------------------------------------------

alter function public.touch_updated_at()                   set search_path = '';
alter function public.forbid_mutation()                    set search_path = '';
alter function public.guard_order_status_transition()       set search_path = '';
alter function public.guard_swap_status_transition()        set search_path = '';
alter function public.guard_withdrawal_status_transition()  set search_path = '';
alter function public.guard_profile_privileged_columns()    set search_path = '';
alter function public.guard_notification_columns()          set search_path = '';

-- -----------------------------------------------------------------------------
-- 2. Take the SECURITY DEFINER helpers off the public API surface
--
-- EXECUTE on a trigger function is checked when the trigger is created, not
-- each time it fires, so revoking here does not stop on_auth_user_created from
-- running: the auth service writes auth.users as supabase_auth_admin, and the
-- trigger fires as the function's owner regardless. The signup path is
-- re-verified by a probe immediately after this migration.
-- -----------------------------------------------------------------------------

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon, authenticated;
revoke all on function public.has_admin_role(public.admin_role[]) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Record why four tables carry RLS with no policy
--
-- The linter reports this as INFO and it is deliberate: enabled RLS with zero
-- policies denies everything to anon and authenticated, which is the intended
-- posture for the compliance and operational tables. They are read by the admin
-- surface, which runs server-side as service_role and checks staff authority in
-- code before querying (spec §43, §64).
-- -----------------------------------------------------------------------------

comment on table public.audit_logs is
  'Append-only record of every privileged action (spec §42). RLS enabled with no
   client policy: deny-all by design. Read only server-side, as service_role,
   after an explicit staff-authority check.';

comment on table public.idempotency_keys is
  'Generic at-most-once claim (spec §20). RLS enabled with no client policy:
   deny-all by design — a readable key table would let a caller discover and
   replay another request''s claim.';

comment on table public.provider_events is
  'Every inbound webhook, recorded before it is acted on (spec §58). RLS enabled
   with no client policy: deny-all by design. Payloads carry provider data that
   no customer may read.';
