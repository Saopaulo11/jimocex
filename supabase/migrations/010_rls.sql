-- =============================================================================
-- JimoCex — 010_rls
--
-- Row Level Security (spec §47). RLS is enabled on every table in `public`,
-- with no exceptions: a table with RLS enabled and no policy denies everything
-- to `anon` and `authenticated`, which is the correct default for a financial
-- table. `service_role` bypasses RLS, which is why every server write goes
-- through code that checks authorization explicitly.
--
-- What a user may do here is deliberately narrow:
--   * read their own rows;
--   * update their own display name, country and notification read state.
-- Nothing else. A user cannot write a balance, a ledger entry, a quote, an
-- order, a tier or a KYC verdict under any policy below (spec §47, §80.9,
-- §80.12, §80.21).
--
-- Two of these rules cannot be expressed as a policy at all, because a policy
-- cannot say "this column must not change". Those are triggers instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere
-- -----------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.admin_users         enable row level security;
alter table public.account_tiers       enable row level security;
alter table public.tier_limits         enable row level security;
alter table public.assets              enable row level security;
alter table public.asset_networks      enable row level security;
alter table public.trading_pairs       enable row level security;
alter table public.wallets             enable row level security;
alter table public.ledger_entries      enable row level security;
alter table public.trading_orders      enable row level security;
alter table public.trades              enable row level security;
alter table public.swap_quotes         enable row level security;
alter table public.swap_orders         enable row level security;
alter table public.deposits            enable row level security;
alter table public.withdrawals         enable row level security;
alter table public.fee_rules           enable row level security;
alter table public.kyc_verifications   enable row level security;
alter table public.risk_events         enable row level security;
alter table public.audit_logs          enable row level security;
alter table public.idempotency_keys    enable row level security;
alter table public.provider_events     enable row level security;
alter table public.notifications       enable row level security;

-- -----------------------------------------------------------------------------
-- Public reference data
--
-- The asset list, the pair list, the tier ladder and the fee and limit
-- schedules are published information: /markets, /fees and the FAQ all need
-- them, signed in or not. Read-only to everyone; writes are service_role only.
-- -----------------------------------------------------------------------------

create policy assets_public_read on public.assets
  for select to anon, authenticated using (true);

create policy asset_networks_public_read on public.asset_networks
  for select to anon, authenticated using (true);

create policy trading_pairs_public_read on public.trading_pairs
  for select to anon, authenticated using (true);

create policy account_tiers_public_read on public.account_tiers
  for select to anon, authenticated using (true);

create policy tier_limits_public_read on public.tier_limits
  for select to anon, authenticated using (is_active);

create policy fee_rules_public_read on public.fee_rules
  for select to anon, authenticated using (is_active);

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create policy profiles_own_read on public.profiles
  for select to authenticated using (user_id = auth.uid());

create policy profiles_own_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No INSERT policy: a profile is created by the on_auth_user_created trigger.
-- No DELETE policy: deleting a profile would orphan its financial history.

-- A policy can restrict which ROWS a user may update, never which COLUMNS. Tier,
-- status, KYC state, identity and email are platform decisions, so the
-- restriction has to be a trigger (spec §80.21, §80.22).
create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  -- The server, acting as service_role, is the only thing allowed to move a
  -- tier or a KYC verdict — and only after RiskEngine and ComplianceGate.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if new.user_id   is distinct from old.user_id
     or new.email      is distinct from old.email
     or new.tier_code  is distinct from old.tier_code
     or new.status     is distinct from old.status
     or new.kyc_status is distinct from old.kyc_status then
    raise exception
      'profiles: user_id, email, tier_code, status and kyc_status are not user-writable'
      using errcode = 'insufficient_privilege',
            hint = 'Tier and verification state change only through the platform''s own review flow.';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_privileged_columns
  before update on public.profiles
  for each row execute function public.guard_profile_privileged_columns();

-- -----------------------------------------------------------------------------
-- Staff
--
-- A user may check whether they themselves are staff; the roster is not public.
-- Granting or revoking staff access is service_role only, so an admin cannot
-- promote themselves through the API.
-- -----------------------------------------------------------------------------

create policy admin_users_self_read on public.admin_users
  for select to authenticated using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Money: read-only to its owner, never writable
--
-- Every one of these tables already had INSERT/UPDATE/DELETE revoked from the
-- client roles in earlier migrations. The absence of a write policy here is the
-- second, independent lock (spec §47).
-- -----------------------------------------------------------------------------

create policy wallets_own_read on public.wallets
  for select to authenticated using (user_id = auth.uid());

create policy ledger_entries_own_read on public.ledger_entries
  for select to authenticated using (user_id = auth.uid());

create policy deposits_own_read on public.deposits
  for select to authenticated using (user_id = auth.uid());

create policy withdrawals_own_read on public.withdrawals
  for select to authenticated using (user_id = auth.uid());

create policy trading_orders_own_read on public.trading_orders
  for select to authenticated using (user_id = auth.uid());

create policy swap_orders_own_read on public.swap_orders
  for select to authenticated using (user_id = auth.uid());

create policy kyc_verifications_own_read on public.kyc_verifications
  for select to authenticated using (user_id = auth.uid());

-- A trade is visible to the owner of either order behind it. Written as an
-- EXISTS over trading_orders so the check reuses that table's own ownership
-- rule rather than restating it.
create policy trades_own_read on public.trades
  for select to authenticated
  using (
    exists (
      select 1 from public.trading_orders o
      where o.id in (trades.buy_order_id, trades.sell_order_id)
        and o.user_id = auth.uid()
    )
  );

-- A quote belongs to the signed-in user who requested it. Anonymous quotes from
-- the public widget are keyed by session_id, which only the server knows, so
-- they are not readable through the client at all.
create policy swap_quotes_own_read on public.swap_quotes
  for select to authenticated using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Notifications
--
-- The one place a user legitimately writes: marking a notification read.
-- -----------------------------------------------------------------------------

create policy notifications_own_read on public.notifications
  for select to authenticated using (user_id = auth.uid());

create policy notifications_own_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Same reasoning as profiles: restrict the columns, not just the rows.
create or replace function public.guard_notification_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.channel     is distinct from old.channel
     or new.title       is distinct from old.title
     or new.body        is distinct from old.body
     or new.entity_type is distinct from old.entity_type
     or new.entity_id   is distinct from old.entity_id
     or new.sent_at     is distinct from old.sent_at then
    raise exception 'notifications: only read_at and status may be changed by the recipient'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger notifications_guard_columns
  before update on public.notifications
  for each row execute function public.guard_notification_columns();

-- -----------------------------------------------------------------------------
-- No client access at all
--
-- risk_events, audit_logs, idempotency_keys and provider_events have RLS enabled
-- and deliberately no policy, so every client read returns nothing. They are
-- read by the admin surface, which runs server-side as service_role and checks
-- staff authority in code before it queries (spec §43, §64).
--
-- A user cannot see their own risk verdicts by design: telling someone which
-- rule flagged them is how a rule gets evaded.
-- -----------------------------------------------------------------------------

comment on table public.risk_events is
  'Append-only RiskEngine / ComplianceGate verdicts (spec §24). RLS enabled with
   no client policy: unreadable through the API by anyone, including the subject.';
