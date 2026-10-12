/**
 * End-to-end precision check of the money boundary against a real PostgreSQL.
 *
 *   node --experimental-strip-types scripts/check-money-roundtrip.ts generate > roundtrip.sql
 *   psql -At -f roundtrip.sql > roundtrip.out
 *   node --experimental-strip-types scripts/check-money-roundtrip.ts verify roundtrip.out
 *
 * Run by scripts/test-db.sh. Every value takes the path a real write and read
 * take, with the application's own code at each end:
 *
 *   decimal literal -> parseMoney -> Money
 *     -> moneyArgs("ledger_post", …) / moneyInsert("deposits", …)   (DbDecimal)
 *     -> JSON.stringify                         (what postgrest-js sends)
 *     -> json_to_record / json_populate_record  (how PostgREST binds a body)
 *     -> ledger_post / INSERT                   (numeric(38,18))
 *     -> ::text                                 (what moneySelect() asks for)
 *     -> fromDatabase -> Money
 *
 * The same path covers the two functions that hand money back from a sum or a
 * stored row: limit_usage_total() over more rows than one PostgREST page (1000),
 * written as one bulk JSON body as PostgREST writes it, and consume_quote().
 *
 * The result is checked three independent ways, so a defect shared by the code
 * under test and its own check cannot pass unnoticed:
 *
 *   1. as TEXT against the original literal, padded to 18 places by string
 *      manipulation alone (sums: added as BigInt units by this file's own
 *      parser) — no money.ts involved;
 *   2. for sums, against PostgreSQL's own sum of the same literals, inserted
 *      directly as SQL numerics — no JSON, no function under test involved;
 *   3. as Money, against parseMoney/addMoney — the application's arithmetic.
 *
 * Two controls prove the check can fail: the write helpers must refuse a
 * JavaScript number outright, and one value sent as a JavaScript number in
 * spite of them must come back DIFFERENT from what was meant.
 *
 * Everything runs inside a transaction that is rolled back.
 */

import { readFileSync } from "node:fs";

import { moneyArgs, moneyInsert } from "../src/lib/db/money-write.ts";
import { ZERO, addMoney, formatMoney, fromDatabase, parseMoney, type Money } from "../src/lib/money.ts";

const USER = "00000000-0000-4000-8000-00000000d0d0";
const QUOTE = "00000000-0000-4000-8000-0000000a0001";
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

/** The values the specification names, always included. */
const REQUIRED = [
  "0.000000000000000001",
  "0.0001",
  "1",
  "1.5",
  "1234567890123456.123456789012345678",
  "999999999999999999.999999999999999999",
];

/** Ledger postings: the required values, a few more edges, and a deterministic sweep. */
function ledgerLiterals(): string[] {
  const values = [...REQUIRED, "1.000000000000000001", "0.1", "0.2"];
  let state = 0x9e3779b9n;
  const next = (): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return state;
  };
  for (let i = 0; i < 400; i++) {
    const whole = next() % 10n ** 12n;
    const fraction = (next() % 10n ** 18n).toString().padStart(18, "0");
    values.push(`${whole}.${fraction}`);
  }
  // Positive only — a deposit moves a positive amount.
  return values.filter((v) => /[1-9]/.test(v));
}

/** Deposit rows: the required values and the column's own maximum. */
function depositLiterals(): string[] {
  return [...REQUIRED, "99999999999999999999.999999999999999999"];
}

/** Window usage rows: the required values and the smallest unit, enough rows to pass one API page. */
function usageLiterals(): string[] {
  return [...REQUIRED, ...Array.from({ length: 1100 }, () => "0.000000000000000001")];
}

/** The quote consume_quote must hand back exactly. */
const QUOTE_FIELDS = {
  from_amount: "1234567890123456.123456789012345678",
  rate: "0.000000000000000001",
  fee: "0.0001",
  output_amount: "999999999999999999.999999999999999999",
} as const;

/** A sum of decimal literals as numeric(…,18) text, with BigInt units parsed here — not by money.ts. */
function sumAsText(literals: readonly string[]): string {
  let units = 0n;
  for (const literal of literals) {
    const [whole = "0", fraction = ""] = literal.split(".");
    units += BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  }
  const text = units.toString().padStart(19, "0");
  return `${text.slice(0, -18).replace(/^0+(?=\d)/, "")}.${text.slice(-18)}`;
}

/** numeric(38,18)::text for a decimal literal, by string manipulation only. */
function asNumeric38_18Text(literal: string): string {
  const [whole = "0", fraction = ""] = literal.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(18, "0")}`;
}

/**
 * The body as SQL: a string literal, with the test asset's id substituted for
 * a placeholder inside PostgreSQL so the JSON is otherwise exactly what
 * JSON.stringify produced.
 */
const jsonBody = (json: string) =>
  `replace(replace('${json.replaceAll("'", "''")}', '__ASSET__', (select id::text from rt_asset)), ` +
  `'__ASSET2__', (select id::text from rt_asset2))::json`;

const LEDGER_RECORD =
  "a(p_user_id uuid, p_asset_id uuid, p_entry_type public.ledger_entry_type, p_amount numeric, " +
  "p_available_delta numeric, p_locked_delta numeric, p_reference_type text, p_reference_id uuid, " +
  "p_dedup_key text, p_metadata jsonb)";

const ledgerCall = (json: string, tag: string) =>
  `select '${tag}' || public.ledger_post(a.p_user_id, a.p_asset_id, a.p_entry_type, a.p_amount, ` +
  `a.p_available_delta, a.p_locked_delta, a.p_reference_type, a.p_reference_id, a.p_dedup_key, a.p_metadata) ` +
  `from json_to_record(${jsonBody(json)}) as ${LEDGER_RECORD};`;

function generate(): string {
  // Control 1: the write helpers refuse a JavaScript number outright.
  let refusals = 0;
  const attempts = [
    () =>
      moneyArgs("ledger_post", {
        p_user_id: USER,
        p_asset_id: "x",
        p_entry_type: "DEPOSIT",
        p_amount: 1.5 as unknown as Money,
        p_available_delta: ZERO,
        p_locked_delta: ZERO,
      }),
    () => moneyInsert("deposits", { user_id: USER, asset_id: "x", amount: 1.5 as unknown as Money }),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      if (error instanceof TypeError) refusals += 1;
    }
  }

  const lines: string[] = [
    "\\set ON_ERROR_STOP 1",
    "begin;",
    `insert into auth.users (id, email) values ('${USER}', 'roundtrip@test.invalid');`,
    "create temporary table rt_asset as select id from public.assets where symbol = 'BTC';",
    "create temporary table rt_asset2 as select id from public.assets where symbol = 'USDT';",
    "create temporary table rt_expected (v numeric);",
    "create temporary table rt_usage_expected (v numeric);",
    `select 'R|${refusals}';`,
  ];

  ledgerLiterals().forEach((literal, i) => {
    const value = parseMoney(literal);
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
      ledgerCall(JSON.stringify(args), `L|${i}|`),
      // Independent expectation: the literal itself, straight into SQL.
      `insert into rt_expected values (${literal});`,
      `select 'B|${i}|' || w.available_balance::text || '|' || (select sum(v)::numeric(38,18)::text from rt_expected) ` +
        `from public.wallets w where w.user_id = '${USER}' and w.asset_id = (select id from rt_asset);`,
      `select 'E|${i}|' || amount::text from public.ledger_entries where dedup_key = 'roundtrip:${i}';`,
    );
  });

  // Window usage: one bulk body, as PostgREST inserts an array, then the sum the engine reads.
  const usage = usageLiterals().map((literal, i) =>
    moneyInsert("limit_usage", {
      user_id: USER,
      operation: "SWAP",
      usd_equivalent: parseMoney(literal),
      quote_currency: "USD",
      reference_type: "roundtrip",
      reference_id: uuid(i + 1),
    }),
  );
  lines.push(
    `insert into public.limit_usage (user_id, operation, usd_equivalent, quote_currency, reference_type, reference_id) ` +
      `select u.user_id, u.operation, u.usd_equivalent, u.quote_currency, u.reference_type, u.reference_id ` +
      `from json_populate_recordset(null::public.limit_usage, ${jsonBody(JSON.stringify(usage))}) u;`,
    `insert into rt_usage_expected values ${usageLiterals().map((literal) => `(${literal})`).join(", ")};`,
    `select 'U|' || public.limit_usage_total(a.p_user_id, a.p_operation, a.p_quote_currency, a.p_since) || '|' || ` +
      `(select sum(v)::numeric(38,18)::text from rt_usage_expected) || '|' || ` +
      `(select count(*) from public.limit_usage where user_id = '${USER}') ` +
      `from json_to_record(${jsonBody(
        JSON.stringify({ p_user_id: USER, p_operation: "SWAP", p_quote_currency: "USD", p_since: "2000-01-01T00:00:00.000Z" }),
      )}) as a(p_user_id uuid, p_operation public.limit_operation, p_quote_currency text, p_since timestamptz);`,
  );

  // A quote written through the boundary and claimed through consume_quote().
  const quote = moneyInsert("swap_quotes", {
    id: QUOTE,
    user_id: USER,
    from_asset_id: "__ASSET2__",
    to_asset_id: "__ASSET__",
    from_amount: parseMoney(QUOTE_FIELDS.from_amount),
    rate: parseMoney(QUOTE_FIELDS.rate),
    fee: parseMoney(QUOTE_FIELDS.fee),
    output_amount: parseMoney(QUOTE_FIELDS.output_amount),
    rate_source: "roundtrip",
    expires_at: "2999-01-01T00:00:00.000Z",
  });
  lines.push(
    `insert into public.swap_quotes (id, user_id, from_asset_id, to_asset_id, from_amount, rate, fee, output_amount, ` +
      `rate_source, expires_at) select q.id, q.user_id, q.from_asset_id, q.to_asset_id, q.from_amount, q.rate, q.fee, ` +
      `q.output_amount, q.rate_source, q.expires_at ` +
      `from json_populate_record(null::public.swap_quotes, ${jsonBody(JSON.stringify(quote))}) q;`,
    `select 'Q|' || r.from_amount || '|' || r.rate || '|' || r.fee || '|' || r.output_amount ` +
      `from json_to_record(${jsonBody(JSON.stringify({ p_quote_id: QUOTE, p_user_id: USER }))}) ` +
      `as a(p_quote_id uuid, p_user_id uuid), public.consume_quote(a.p_quote_id, a.p_user_id) r;`,
  );

  depositLiterals().forEach((literal, i) => {
    const row = moneyInsert("deposits", {
      user_id: USER,
      asset_id: "__ASSET__",
      amount: parseMoney(literal),
      provider_reference: `roundtrip:${i}`,
    });
    lines.push(
      `insert into public.deposits (user_id, asset_id, amount, provider_reference) ` +
        `select d.user_id, d.asset_id, d.amount, d.provider_reference ` +
        `from json_populate_record(null::public.deposits, ${jsonBody(JSON.stringify(row))}) d;`,
      `select 'D|${i}|' || amount::text from public.deposits where provider_reference = 'roundtrip:${i}';`,
    );
  });

  // Control 2: the same kind of write with a JavaScript number in the body —
  // what the boundary exists to prevent. It must come back changed.
  const lossy = JSON.stringify({
    user_id: USER,
    asset_id: "__ASSET__",
    amount: 1234567890123456.123456789012345678, // money-guard-allow: deliberate JS number, the negative control
    provider_reference: "roundtrip:lossy",
  });
  lines.push(
    `insert into public.deposits (user_id, asset_id, amount, provider_reference) ` +
      `select d.user_id, d.asset_id, d.amount, d.provider_reference ` +
      `from json_populate_record(null::public.deposits, ${jsonBody(lossy)}) d;`,
    `select 'X|' || amount::text from public.deposits where provider_reference = 'roundtrip:lossy';`,
    "rollback;",
  );
  return lines.join("\n") + "\n";
}

function verify(outputFile: string): void {
  const rows = readFileSync(outputFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[RLBEDXUQ]\|/.test(line));

  const balances = new Map<string, { db: string; sql: string }>();
  const deposits = new Map<string, string>();
  const entries = new Map<string, string>();
  let posted = 0;
  let refusals = "";
  let lossy = "";
  let usage: string[] | undefined;
  let quote: string[] | undefined;
  for (const row of rows) {
    const [kind, a = "", b = "", c = ""] = row.split("|");
    if (kind === "R") refusals = a;
    if (kind === "L") posted += 1;
    if (kind === "B") balances.set(a, { db: b, sql: c });
    if (kind === "E") entries.set(a, b);
    if (kind === "D") deposits.set(a, b);
    if (kind === "X") lossy = a;
    if (kind === "U") usage = row.split("|").slice(1);
    if (kind === "Q") quote = row.split("|").slice(1);
  }

  const problems: string[] = [];
  if (refusals !== "2") problems.push(`the write helpers refused ${refusals || 0} of 2 JavaScript numbers`);

  const ledger = ledgerLiterals();
  if (posted !== ledger.length) problems.push(`ledger_post ran ${posted} times, expected ${ledger.length}`);

  let expected = ZERO;
  ledger.forEach((literal, i) => {
    expected = addMoney(expected, parseMoney(literal));
    const got = balances.get(String(i));
    if (!got) {
      problems.push(`no balance read back after posting #${i}`);
      return;
    }
    // 2. PostgreSQL's own sum of the literals, no JSON and no ledger_post involved.
    if (got.db !== got.sql) problems.push(`after #${i} (+${literal}): wallet ${got.db}, SQL sum of the literals ${got.sql}`);
    // 3. The application's arithmetic, through the read gate.
    if (fromDatabase(got.db, "wallets.available_balance") !== expected) {
      problems.push(`after #${i} (+${literal}): wallet ${got.db}, addMoney ${formatMoney(expected)}`);
    }
    // 1. The entry itself, as text against the literal.
    const entry = entries.get(String(i));
    if (entry !== asNumeric38_18Text(literal)) problems.push(`ledger entry #${i} (${literal}): database has ${entry}`);
  });

  // Window usage through limit_usage_total(): all three ways.
  const usageRows = usageLiterals();
  if (!usage) {
    problems.push("limit_usage_total() returned nothing");
  } else {
    const [total = "", sqlSum = "", count = ""] = usage;
    if (count !== String(usageRows.length)) problems.push(`limit_usage holds ${count} rows, expected ${usageRows.length}`);
    if (total !== sqlSum) problems.push(`limit_usage_total ${total}, PostgreSQL's own sum of the literals ${sqlSum}`);
    if (total !== sumAsText(usageRows)) problems.push(`limit_usage_total ${total}, BigInt sum of the literals ${sumAsText(usageRows)}`);
    const appSum = usageRows.reduce((sum, literal) => addMoney(sum, parseMoney(literal)), ZERO);
    if (fromDatabase(total, "limit_usage_total") !== appSum) problems.push(`limit_usage_total ${total}, addMoney ${formatMoney(appSum)}`);
  }

  // consume_quote(): every money field exact, as text and as Money.
  if (!quote) {
    problems.push("consume_quote() returned nothing");
  } else {
    Object.entries(QUOTE_FIELDS).forEach(([field, literal], i) => {
      const text = quote[i];
      if (text !== asNumeric38_18Text(literal)) problems.push(`consume_quote ${field}: ${text}, expected ${asNumeric38_18Text(literal)}`);
      if (text === undefined || fromDatabase(text, `consume_quote.${field}`) !== parseMoney(literal)) {
        problems.push(`consume_quote ${field}: Money mismatch`);
      }
    });
  }

  depositLiterals().forEach((literal, i) => {
    const text = deposits.get(String(i));
    if (text === undefined) {
      problems.push(`deposit #${i} was not read back`);
      return;
    }
    // 1. Text against the literal, by string manipulation alone.
    if (text !== asNumeric38_18Text(literal)) problems.push(`deposit ${literal}: database has ${text}`);
    // 3. Through the read gate.
    if (fromDatabase(text, "deposits.amount") !== parseMoney(literal)) problems.push(`deposit ${literal}: Money mismatch`);
  });

  // Control 2 must have been distorted, or this check could not see a loss.
  if (lossy === "" || lossy === asNumeric38_18Text("1234567890123456.123456789012345678")) {
    problems.push(`the negative control was not distorted (got ${lossy || "nothing"}) — the check cannot detect a loss`);
  }

  if (problems.length > 0) {
    console.error(`money round trip FAILED (${problems.length}):`);
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `    ${ledger.length} ledger postings and ${depositLiterals().length} deposit rows round-tripped exactly, ` +
      `checked as text, against PostgreSQL's own sum and as Money (final balance ${formatMoney(expected)})`,
  );
  console.log(
    `    limit_usage_total over ${usageRows.length} rows = ${usage?.[0]} (= PostgreSQL's sum = BigInt sum = addMoney); ` +
      `consume_quote returned all ${Object.keys(QUOTE_FIELDS).length} money fields exactly`,
  );
  console.log(`    controls: both write helpers refused a JS number; a JS number sent anyway came back as ${lossy}`);
}

const [mode, file] = process.argv.slice(2);
if (mode === "generate") process.stdout.write(generate());
else if (mode === "verify" && file) verify(file);
else {
  console.error("usage: check-money-roundtrip.ts generate | verify <output>");
  process.exit(2);
}
