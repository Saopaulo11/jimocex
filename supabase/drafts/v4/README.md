# Package v4: migrations 016 and 017 for the hosted project

Status: **release artifact, kept unchanged for a future rollout.** It is not a migration, nothing applies
it automatically, and keeping it here is not an authorization to apply it. Applying it needs the
project owner's explicit go for that step (`docs/rollout-019.md` §0, stage 1).

## What it is

`apply_016_017.sql` brings the hosted project from 015 to 017. It is one SQL statement, a `DO` block:
PostgreSQL applies all of it or nothing, however it is sent. Inside it, in order:
1. **Preflight.** It refuses unless the database is exactly the 015 state the package was built against:
   - role and server version;
   - the full migration history;
   - the shape of every function 016/017 replace;
   - no data the new constraints would refuse;
   - the md5 of its embedded 016/017 text;
   - the fingerprint of the `public` schema, `87f076b63039e2816cd0cec03594683d` (1240 items).
2. **Apply.** 016, then 017.
3. **Postflight.** It refuses unless the result is what 016/017 define, explicitly and as a whole: the fingerprint of a clean 001–017 build, `f48db42ea4cdfa14599f3f05197e2353` (1191 items).
4. **History.** Two rows in `supabase_migrations.schema_migrations`, then a check that the history holds exactly 001–017.

The file's header gives the details and the two ways to run it.

## Identity

| | |
|---|---|
| File | `apply_016_017.sql`, 58 639 bytes |
| sha256 | `2816d6898259be0057043b588f0becaceb053383050dab234b6ce788ebc2c081` (in `apply_016_017.sql.sha256`) |
| 016 inside | `supabase/migrations/016_money_functions_return_text.sql`, sha256 `73d599bbcc9484e369c073e8a4134504fd8e17d8b4df9ead11e984d2385111cf`; embedded text md5 `5f7d9d01cee5c693baf55626e487e3cb` |
| 017 inside | `supabase/migrations/017_money_integrity.sql`, sha256 `efbc5be4286992df8f490928a8915a83c125e4d1929f3dd00c708e4bbe6b431f`; embedded text md5 `e83898e978d513ffac57f77e4def931f` |

The embedded texts are the two migration files without their final newline. When this file was added,
017 with that hash was the working tree; the 017 committed at `b0ea211` is an earlier text. If 016 or 017
change in the repository, this package no longer matches them. It must then not be used: build a new
one and review it again.

## Checking it

From the repository root:

```bash
(cd supabase/drafts/v4 && sha256sum -c apply_016_017.sql.sha256)
python3 - <<'EOF'
import pathlib
v4 = pathlib.Path('supabase/drafts/v4/apply_016_017.sql').read_text()
for tag, f in (('mig016', '016_money_functions_return_text.sql'), ('mig017', '017_money_integrity.sql')):
    parts = v4.split(f'${tag}$')
    repo = pathlib.Path('supabase/migrations', f).read_text()
    print(f, 'matches' if len(parts) == 3 and parts[1] == repo.removesuffix('\n') else 'DIFFERS')
EOF
```

Both must pass: the hash, and both lines `matches`.

## How it was built

A builder script generated it from:
- the 015 state read from the hosted project (history, the text of 001–015, the schema fingerprint);
- the repository's 016 and 017.

A scenario suite of 21 cases then ran it against local PostgreSQL 17 replicas of hosted 015. Every
case passed. They cover:
- the correct state, as one message and through `psql -f`, and a second run;
- errors injected between 016 and 017 and in the middle of 017, also under psql without `ON_ERROR_STOP`;
- unexpected grants and function overloads, before and during the run;
- a missing function, and wrong result types before and after;
- history that is missing, already recorded or altered;
- a failing postflight, and a failing final history check.

The builder, its inputs and the scenarios are in the session scratchpad, not in this repository (open
item N7 in `docs/review-019-privileges.md`). Until they are, this file is the artifact. It is verified by
the checks above, not rebuilt.

## Checks around a rollout

Read-only, from the repository (`docs/rollout-019.md` §0, stage 1):
- **Before.** `supabase/drafts/019_preflight.sql` must give the 015 signature: `BLOCKED`, failures exactly `A3 H3 H4 O3 S1 S2 S3 S4 S5 S6`, `T1` and `V1` ok. The package's own preflight then also checks the 015 fingerprint.
- **After.**
  - The package's own postflight and history check have passed (otherwise nothing was applied).
  - `019_preflight.sql` gives `PASS`.
  - `supabase/tests/02_money_catalog.sql` with `scripts/check-privileges.ts … 017` matches.
- **Application.** The code at `b0ea211` calls `limit_usage_total()`, which exists only after 017. A deployment that calls `limit_usage_in_window()` stops working when 016 drops it. See the compatibility table in `docs/rollout-019.md`.

## Not here

- It is not in `supabase/migrations`, so neither `scripts/test-db.sh` nor the Supabase CLI runs it.
- It does not contain 019, which is `supabase/drafts/019_table_privileges.sql`, a separate stage under a separate authorization.
- Never edit the SQL file: any change breaks its hash and its own md5 checks.
