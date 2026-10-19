# Package upgrade_021_022: migration 022 for a database already at 021

Status: **verified locally only, applied nowhere.** It is not a migration, nothing applies it
automatically, and keeping it here is not an authorization to apply it. The Preview's test project
remains at 021. Running it there needs the project owner's separate go
(`docs/preview-environment.md`, Option A, step 3b), and its procedure must be reviewed first.

**Preview upgrade procedure verified locally; Preview itself remains at 021.**

## Why it exists

Step 3's gate installs `supabase/migrations` into an **empty** project only. On a project that already
has 001–021, such as the Preview's test project, it stops at 001 (whose objects exist) and changes
nothing. That project holds demo users and their data, so it must not be rebuilt: it needs exactly
022, once, on top of what it has. This package is that step, built the way package v4
(`supabase/drafts/v4`) brings the hosted project from 015 to 017.

## What it is

| File | What it does |
|---|---|
| `checks.sql` | One read-only `SELECT`. Phase `pre`: the database is exactly the 021 state (verdict `P99`, `READY`). Phase `post`: it is what 022 defines (verdict `Q99`, `PASS`). Phase `data`: each table's row count and the md5 of all its rows. |
| `apply.sql` | One SQL statement, a `DO` block. PostgreSQL applies all of it or nothing. In order: lock_timeout 5s; the md5 of its two embedded texts; a `SHARE ROW EXCLUSIVE` lock on every table in `public` (writers wait, readers do not); `checks.sql` phase `pre`; phase `data`; `EXECUTE` 022; phase `post`; phase `data` again, which must equal the first. |

The `pre` checks (`checks.sql` names each in its output):

- **P01–P03, the environment:** run as `postgres`, owner of the functions 022 replaces; PostgreSQL 16 or 17, `read committed`; no migration history written by another mechanism.
- **P04–P08, the schema:**
  - 022 is not applied: no `SUBMITTED`, none of its three functions;
  - 021's three trading flags are set;
  - the `public` schema matches a clean 001–021 build;
  - `cancel_order`, `apply_fill` and the status guard are as 005/018/020 left them, privileges included.
- **P09, P10 and M1–M5, the data:**
  - no `PENDING` or `PARTIALLY_FILLED` order, which 022 would strand;
  - no recorded venue order id;
  - each order's lock equals its HOLD/RELEASE and trade ledger rows;
  - each filled amount equals its trades;
  - funds are locked only by live orders;
  - no order ledger row without its order;
  - every wallet equals its ledger (`reconcile_wallets`).

The `post` checks:

- **Q01–Q06, the schema:**
  - `SUBMITTED` after `OPEN`;
  - the schema matches a clean 001–022 build;
  - the six functions are 022's, with exactly its privileges;
  - the guard fires on `status` and `provider_order_id`;
  - row-level security is on every table, with 21 policies;
  - no migration history was written.
- **N1–N5, the data:** the same money checks as M1–M5.

The schema fingerprint is package v4's item query without three categories. Default privileges
(`defacl`) and the schema's own ACL (`nspacl`) are decided by the platform; `tier_limits` rows (`tier`)
are data. Its expected values come from clean local builds on PostgreSQL 16.15 and 17.10. These agree
except for table privileges, where 17 adds `MAINTAIN`, so those values are pinned per major version.

It writes **no migration history**: step 3's gate wrote none either, and the Preview's test project
has no `supabase_migrations.schema_migrations` table (Slice 12.9, read-only). History rows remain the
owner's separate decision.

## Identity

| | |
|---|---|
| `checks.sql` | 21634 bytes, sha256 `d809cf81f2b46a1eb02aa77c3f3beb18f501e69e33b60dfba0d99e27837cf0cb` (in `checks.sql.sha256`) |
| `apply.sql` | 56165 bytes, sha256 `1145a613375f23960a725a74ab7982cd22bee2861e82beef0c8199ac34bb1abd` (in `apply.sql.sha256`) |
| 022 inside | `supabase/migrations/022_submitted_lifecycle.sql`, sha256 `61d68773d53eb12798707f86b057c07715d55c730fb229e9db57e15bf71be0bb`; embedded text md5 `632fb1e868bf047954155b7b393baa73` |
| checks inside | `checks.sql` without its final `;`, md5 `70630ce9f65d527ab8ccb5c6297b0dd5` |

If 022 or `checks.sql` change, this package no longer matches them and must not be used: build it
again and review it again.

## Checking it

From the repository root:

```bash
(cd supabase/drafts/upgrade_021_022 && sha256sum -c checks.sql.sha256 apply.sql.sha256)
python3 - <<'EOF'
import pathlib
d = pathlib.Path('supabase/drafts/upgrade_021_022')
apply = (d / 'apply.sql').read_text()
for tag, text in (('mig022', pathlib.Path('supabase/migrations/022_submitted_lifecycle.sql').read_text().removesuffix('\n')),
                  ('checks', (d / 'checks.sql').read_text().removesuffix(';\n'))):
    parts = apply.split(f'${tag}$')
    print(tag, 'matches' if len(parts) == 3 and parts[1] == text else 'DIFFERS')
EOF
```

Both must pass: both hashes, and both lines `matches`. `scripts/test-db.sh` checks the same on every
run before it uses the package.

## Tested

Unlike package v4's, these scenarios are in the repository. `scripts/test-db.sh` ("upgrade 021 -> 022 on
existing databases") runs them on every `npm run test:db` and `npm run test:db:019`. Each runs on its
own copy of a 001–021 database that holds demo activity (`supabase/tests/03_upgrade_fixture_021.sql`):
funded users, resting BUY and SELL orders, a cancelled order and an order filled by 020's `apply_fill`.

| | Scenario | Result |
|---|---|---|
| A | clean 001–022 build | `post` PASS, `pre` BLOCKED |
| B | 021 → 022 | `pre` READY, then `post` PASS; every row of all 23 tables unchanged |
| C | a second run on the upgraded database; a run on a clean 001–022 build | refused (P04), nothing changed |
| D | a `PARTIALLY_FILLED` order; a `PENDING` order; a cancelled or a rejected order still holding funds; a wallet that differs from its ledger | refused (P09, P09, M3, M3, M5), nothing changed |
| E | a recorded venue order id; a duplicate venue order id | refused (P10); the duplicate cannot exist (005's UNIQUE constraint) |
| F | history rows 001–021; a history row 022; no history table at all | refused (P03), refused (P03); upgraded |
| G | a writer holding a lock past lock_timeout; an error after 022 ran; the session killed after 022 ran; default privileges granting the new functions to another role; two runs at once | refused, nothing changed; one run upgraded and the other waited and was refused |

After B, on the upgraded database:
- the privilege and money registries match its catalog (profile 017, or 019 once 019 is applied on top);
- `supabase/tests/01_invariants.sql` passes;
- an existing OPEN order can be claimed, after which its owner's cancel is refused;
- another existing OPEN order is still cancelled by its owner.

All of it passed on PostgreSQL 16.15 and 17.10, profiles 017 and 019 **[local]**. Step 3b's block was
tested separately, with a stand-in `psql` and with the real one against local clusters
(`docs/preview-environment.md`, step 3b).

**Not verified until it runs there [unverified]:**
- that the hosted test project's `public` schema matches the local fingerprint (P07). It is expected
  to: step 3 installed it from byte-identical files, and step 5 matched it in Slice 12.9;
- how Supabase's own sessions and the session pooler behave with the lock;
- anything about the hosted project beyond what checks.sql reads.
