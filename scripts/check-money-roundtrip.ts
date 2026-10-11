/**
 * End-to-end precision check of the money boundary against a real PostgreSQL.
 *
 *   node --experimental-strip-types scripts/check-money-roundtrip.ts generate > roundtrip.sql
 *   psql -At -f roundtrip.sql > roundtrip.out
 *   node --experimental-strip-types scripts/check-money-roundtrip.ts verify roundtrip.out
 *
 * Run by scripts/test-db.sh. Every value takes the whole path a real write and
 * read take, with the application's own code at each end:
 *
 *   Money
 *     -> moneyArgs("ledger_post", …) / moneyInsert("deposits", …)   (DbDecimal)
 *     -> JSON.stringify                       (what postgrest-js sends)
 *     -> json_to_record / json_populate_record (how PostgREST binds a body)
 *     -> ledger_post / INSERT                  (numeric(38,18))
 *     -> ::text                                (what moneySelect() asks for)
 *     -> fromDatabase                          (the read gate)
 *     -> Money, compared exactly with what was sent — and, for the ledger, with
 *        the running balance computed by addMoney.
 *
 * The values are the edges of numeric(38,18) plus a deterministic sweep, so a
 * failure can be replayed. Everything runs inside a transaction that is rolled
 * back.
 */

import { readFileSync } from "node:fs";

import { moneyArgs, moneyInsert } from "../src/lib/db/money-write.ts";
import { ZERO, addMoney, formatMoney, fromDatabase, isPositive, parseMoney, type Money } from "../src/lib/money.ts";

const USER = "00000000-0000-4000-8000-00000000d0d0";

/** Values sent through the ledger: positive, and together far below 10^20. */
function ledgerValues(): Money[] {
  const values = ["0.000000000000000001", "1", "1.000000000000000001", "0.1", "0.2", "999999999999.999999999999999999"].map(
    (v) => parseMoney(v),
  );
  let state = 0x9e3779b9n;
  const next = (): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return state;
  };
  for (let i = 0; i < 400; i++) {
    // Up to 12 integer digits and a full 18-digit fraction.
    const whole = next() % 10n ** 12n;
    const fraction = (next() % 10n ** 18n).toString().padStart(18, "0");
    values.push(parseMoney(`${whole}.${fraction}`));
  }
  return values.filter((v) => isPositive(v));
}

/** Values sent as a deposit row: the extremes of the column itself. */
function depositValues(): Money[] {
  return ["0.000000000000000001", "99999999999999999999.999999999999999999", "1234567890123456.123456789012345678"].map(
    (v) => parseMoney(v),
  );
}

/**
 * The body as SQL: a string literal, with the test asset's id substituted for
 * a placeholder inside PostgreSQL so the JSON is otherwise exactly what
 * JSON.stringify produced.
 */
const body = (value: unknown) =>
  `replace('${JSON.stringify(value).replaceAll("'", "''")}', '__ASSET__', (select id::text from rt_asset))::json`;

function generate(): string {
  const lines: string[] = [
    "\\set ON_ERROR_STOP 1",
    "begin;",
    `insert into auth.users (id, email) values ('${USER}', 'roundtrip@test.invalid');`,
    "create temporary table rt_asset as select id from public.assets where symbol = 'BTC';",
  ];

  ledgerValues().forEach((value, i) => {
    const args = moneyArgs("ledger_post", {
      p_user_id: USER,
      p_asset_id: "__ASSET__",
      p_entry_type: "DEPOSIT",
      p_amount: value,
      p_available_delta: value,
      p_locked_delta: ZERO,
      p_reference_type: "roundtrip",
      p_dedup_key: `roundtrip:${i}`,
      p_metadata: { case: String(i) },
    });
    lines.push(
      `select 'L|${i}|' || public.ledger_post(a.p_user_id, a.p_asset_id, a.p_entry_type, a.p_amount, ` +
        `a.p_available_delta, a.p_locked_delta, a.p_reference_type, a.p_reference_id, a.p_dedup_key, a.p_metadata) ` +
        `from json_to_record(${body(args)}) as a(p_user_id uuid, p_asset_id uuid, ` +
        `p_entry_type public.ledger_entry_type, p_amount numeric, p_available_delta numeric, p_locked_delta numeric, ` +
        `p_reference_type text, p_reference_id uuid, p_dedup_key text, p_metadata jsonb);`,
      `select 'B|${i}|' || w.available_balance::text from public.wallets w ` +
        `where w.user_id = '${USER}' and w.asset_id = (select id from rt_asset);`,
    );
  });

  depositValues().forEach((value, i) => {
    const row = moneyInsert("deposits", {
      user_id: USER,
      asset_id: "__ASSET__",
      amount: value,
      provider_reference: `roundtrip:${i}`,
    });
    lines.push(
      `insert into public.deposits (user_id, asset_id, amount, provider_reference) ` +
        `select d.user_id, d.asset_id, d.amount, d.provider_reference ` +
        `from json_populate_record(null::public.deposits, ${body(row)}) d;`,
      `select 'D|${i}|' || amount::text from public.deposits where provider_reference = 'roundtrip:${i}';`,
    );
  });

  lines.push("rollback;");
  return lines.join("\n") + "\n";
}

function verify(outputFile: string): void {
  const rows = readFileSync(outputFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[LBD]\|/.test(line));

  const balances = new Map<number, string>();
  const deposits = new Map<number, string>();
  let posted = 0;
  for (const row of rows) {
    const [kind, index, value] = row.split("|");
    if (kind === "L") posted += 1;
    if (kind === "B") balances.set(Number.parseInt(index!, 10), value!); // money-guard-allow: a row index, not money
    if (kind === "D") deposits.set(Number.parseInt(index!, 10), value!); // money-guard-allow: a row index, not money
  }

  const problems: string[] = [];
  const ledger = ledgerValues();
  if (posted !== ledger.length) problems.push(`ledger_post ran ${posted} times, expected ${ledger.length}`);

  let expected = ZERO;
  ledger.forEach((value, i) => {
    expected = addMoney(expected, value);
    const text = balances.get(i);
    if (text === undefined) {
      problems.push(`no balance read back after posting #${i}`);
      return;
    }
    const read = fromDatabase(text, "wallets.available_balance");
    if (read !== expected) {
      problems.push(`after #${i} (+${formatMoney(value)}): database has ${text}, expected ${formatMoney(expected)}`);
    }
  });

  depositValues().forEach((value, i) => {
    const text = deposits.get(i);
    if (text === undefined) problems.push(`deposit #${i} was not read back`);
    else if (fromDatabase(text, "deposits.amount") !== value) {
      problems.push(`deposit #${i}: sent ${formatMoney(value)}, database has ${text}`);
    }
  });

  if (problems.length > 0) {
    console.error(`money round trip FAILED (${problems.length}):`);
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `    ${ledger.length} ledger postings and ${depositValues().length} deposit rows round-tripped exactly ` +
      `(final balance ${formatMoney(expected)})`,
  );
}

const [mode, file] = process.argv.slice(2);
if (mode === "generate") process.stdout.write(generate());
else if (mode === "verify" && file) verify(file);
else {
  console.error("usage: check-money-roundtrip.ts generate | verify <output>");
  process.exit(2);
}
