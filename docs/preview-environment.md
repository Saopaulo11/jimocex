# Preview environment: an isolated test database and a Vercel Preview (plan)

Status: **a plan.** Nothing described here exists yet: no test database, no Vercel project for this
repository. Every step marked **owner** needs the project owner's explicit go, and nothing here
touches the hosted JimoCex project (`sykhghtlkcrzwaoehlhf`) or its production settings.

## Why a Preview needs its own database

There is one hosted Supabase project for JimoCex. A Preview that points at it writes there. Anyone who
can open the Preview can make these writes, and a Preview domain changes none of them:
- **Sign-up** creates a row in `auth.users`, and `handle_new_user()` adds a profile.
- **Email confirmation and password reset** send real emails.
- **Row-level updates** the policies allow (own profile name, own notifications) write to production.

A Preview may only use a database that holds no production users and no financial data.

## What the application reads from the environment

Every read of `process.env` in `src/` (Phase 2.2 search; `scripts/` and the config files read none):

| Variable | Read in | Without it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `src/lib/supabase/server.ts:25`, `browser.ts:34`, `admin.ts:27`, `src/proxy.ts:50` | the server and browser clients throw "… is not set"; the proxy (`src/proxy.ts:56`) skips the session refresh instead of failing. Pages that read the database need it (not tested without it) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `server.ts:26`, `browser.ts:35`, `proxy.ts:51` | the same |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/admin.ts:28` only | `createAdminClient()` throws when called. See below |
| `NEXT_PUBLIC_APP_URL` | `src/app/auth/actions.ts:27` (origin of email links), `src/app/layout.tsx:12` (`metadataBase`) | email links use the request's own host (`x-forwarded-host`, then `host`), so a Preview links to itself; `metadataBase` stays unset |
| `JIMOCEX_MARKET_DATA_PROVIDER` | `src/lib/providers/market-data/index.ts:26` | `"unavailable"`: prices show as unavailable, never invented; an unknown name falls back to the same |

`NEXT_PUBLIC_*` values are inlined at build time. They must be set before the Preview is built.

**The service-role key is not needed by the current code.** Three things show it:
- `admin.ts` is imported only by `src/lib/engines/limit-engine.ts` (and one unit test), and nothing imports `limit-engine.ts`;
- a production build made without the key contains no reference to `SUPABASE_SERVICE_ROLE_KEY` or `createAdminClient` (Phase 2.2 local smoke);
- the app served every page without it.

This changes the day a route calls `checkEligibility()`. From then on the key is needed, and only the
**test** project's key may go into the Preview environment. Never production's.

## The test database

### Option A (recommended): a separate Supabase project

1. **Owner:** create a project, e.g. `jimocex-preview`, in "Saopaulo11's Org" (Pro plan: an extra project has its own compute cost). Use the production region (`ca-central-1`) and PostgreSQL 17.
2. **Owner, separate go:** apply the repository's migrations 001–017 in order, as `postgres`, each file in one transaction:

   ```bash
   for f in supabase/migrations/0*.sql; do
     psql "<test project connection>" -X -v ON_ERROR_STOP=1 -1 -f "$f" || break
   done
   ```

   - Not package v4: it is built for the hosted 015 state and refuses anything else.
   - 019 only if the owner decides, from `supabase/drafts/019_table_privileges.sql` after `sha256sum -c` (as `npm run test:db:019` does locally).
   - Reference data comes from the migrations (011, 015). Nothing is copied from production.
3. **Check schema and privileges, read-only:**
   - run `supabase/tests/02_money_catalog.sql` against the test project and save its JSON;
   - `node --experimental-strip-types scripts/check-privileges.ts <json> 017` (or `019`) must report a match;
   - `scripts/check-money-catalog.ts <json>` likewise.

   `supabase/tests/01_invariants.sql` is for throwaway local clusters (`scripts/test-db.sh`), not for a hosted project.
4. **Owner, Auth settings of the test project only:**
   - Site URL: the Preview branch URL;
   - Redirect URLs: the Preview domains of this project, e.g. `https://jimocex-*-work-app1.vercel.app/**`. No production URL;
   - email: the default provider is rate-limited. Use addresses you control, or a test SMTP account; never production SMTP credentials.
5. **Test accounts:** sign up through the Preview with addresses you control (plus-addressing works). There are no production users and no production data in this project, and none are copied into it.
6. **Keys:** the test project's URL and anon key go into the Vercel Preview environment. Its service-role key stays unset (see above).

### Option B: Supabase Branching on the JimoCex project

The plan allows it (Pro), and the project has no branches today. It needs Branching switched on for the
production project (a change to that project), the GitHub integration and a `supabase/config.toml`.
Branches start empty and run `supabase/migrations`, so a branch would be at 017 while production is at
015. Depending on configuration, the integration can also run migrations against production when the
production branch changes. That conflicts with the manual, authorized v4 procedure in
`docs/rollout-019.md`, so it is not recommended until the migration process is settled.

## Vercel Preview

Read-only, Phase 2.2: there is no Vercel project for this repository.
- The `work-app1` team has six projects, deployed from `Saopaulo11/Trust-` and `Saopaulo11/WorkAPP`, so the Vercel GitHub App is installed for the account.
- Whether its repository list includes `Saopaulo11/jimocex` cannot be seen from here.

Steps, all **owner**, after the test database exists:

1. **Decide the Production branch first.** GitHub's default branch is `feature/jimocex-mvp`. An import with default settings makes it the Production branch, and every push to it a Production deployment. Choosing another Production branch (for instance a `main` created from an agreed commit) is a separate decision. Until it is made, do not import.
2. **Import** `Saopaulo11/jimocex` into `work-app1`, giving the GitHub App access to the repository if it is not listed.
3. **Build settings:**
   - framework Next.js (`vercel.json`);
   - install `npm ci`;
   - build `npm run build` (`next build`);
   - output default;
   - **Node.js 22.x**, the version the tests ran on (22.22.0).
4. **Environment variables, scope Preview only:**
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` of the test project;
   - leave unset: `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL` (links then follow each Preview's own host; one fixed value would send every Preview's links to that one URL), `JIMOCEX_MARKET_DATA_PROVIDER`.

   Set nothing for Production. A Production deployment then cannot reach any database.
5. **Deployment Protection:** Vercel Authentication on Preview deployments, as on the team's other projects.
6. **Check after the first Preview build:**
   - the Preview variables name the test project's ref, not `sykhghtlkcrzwaoehlhf`; Production has none;
   - in the browser's network panel, the Preview calls only `https://<test ref>.supabase.co`;
   - a test sign-up appears in the test project's Auth users and nowhere else;
   - the read-only history and fingerprint checks of the hosted project (`docs/rollout-019.md`) show no change;
   - `/`, `/markets` (pairs from the test database), `/login` and `/signup` load, and `/dashboard` sends a signed-out visitor to `/login?next=%2Fdashboard`.

## Checked locally (Phase 2.2), and what was not

The setup: a production build of Next.js 16.3.8 against a stand-in for a test project (PostgreSQL 17.10
built from migrations 001–017, PostgREST 12.2.3, a gateway for `/rest/v1` with `/auth/v1` stubbed). The
build had only a test URL and a locally signed anon key: no service-role key, no `NEXT_PUBLIC_APP_URL`,
no market-data provider.
- Every public page answered 200, and `/markets` rendered 16 pairs read from the database.
- The application sent only `GET` requests to `/rest/v1`.
- `/auth/confirm` sent a forged token with `next=https://evil.example` back to `/login?error=invalid_link` on the same origin.
- `/markets` still answered with the database unreachable.
- `safeRedirectPath` refused absolute, protocol-relative, backslash and `javascript:` targets.

**Not checked:** real Supabase Auth flows (sign-up, emails, sessions), Vercel's build environment and edge network.
