import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMoney, type Money } from "../../src/lib/money.ts";
import {
  checkFundingEnvironment,
  DEMO_OPENING_BALANCES,
  dedupKeyFor,
  ensureDemoAccountFunded,
  FundingRefused,
  type FundingDeps,
} from "../demo-funding.ts";

/**
 * Demo funding (Slice 10): the environment guard must fail closed, and funding
 * must be ledger-only and idempotent. The ports are fakes; the real
 * `ledger_post` contract (an ADJUSTMENT under a dedup key, a repeat refused) is
 * proven by supabase/tests/01_invariants.sql ("demo funding: …").
 */

const TEST_REF = "abcdefghijklmnopqrst";

/** A complete, valid preview environment; each test breaks one thing. */
const previewEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NEXT_PUBLIC_JIMOCEX_DEMO_MODE: "true",
  NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_REF}.supabase.co`,
  JIMOCEX_DEMO_FUNDING_PROJECT_REF: TEST_REF,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-of-the-test-project",
  JIMOCEX_DEMO_ACCOUNT_EMAIL: "Demo@Example.com",
  ...over,
});

const refusal = (env: Record<string, string | undefined>): string => {
  const r = checkFundingEnvironment(env);
  assert.equal(r.ok, false, "expected a refusal");
  return r.ok ? "" : r.reason;
};

describe("checkFundingEnvironment — fail closed", () => {
  test("a complete preview environment passes, naming the test project's host", () => {
    const r = checkFundingEnvironment(previewEnv());
    assert.ok(r.ok);
    assert.deepEqual(r.target, { environment: "preview", host: `${TEST_REF}.supabase.co` });
    assert.equal(r.email, "demo@example.com");
  });

  test("a loopback Supabase URL is development", () => {
    const r = checkFundingEnvironment(
      previewEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", JIMOCEX_DEMO_FUNDING_PROJECT_REF: undefined }),
    );
    assert.ok(r.ok && r.target.environment === "development");
  });

  test("demo mode unset, false or anything but exactly \"true\" is refused", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      assert.match(refusal(previewEnv({ NEXT_PUBLIC_JIMOCEX_DEMO_MODE: value })), /demo mode is not on/);
    }
  });

  test("a production marker is refused even with everything else valid", () => {
    assert.match(refusal(previewEnv({ NODE_ENV: "production" })), /production/);
    assert.match(refusal(previewEnv({ VERCEL_ENV: "production" })), /production/);
  });

  test("the production project is refused even when the operator names it", () => {
    const prod = "sykhghtlkcrzwaoehlhf";
    assert.match(
      refusal(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${prod}.supabase.co`, JIMOCEX_DEMO_FUNDING_PROJECT_REF: prod })),
      /production project/,
    );
  });

  test("a supabase.co project the operator did not name is refused", () => {
    assert.match(refusal(previewEnv({ JIMOCEX_DEMO_FUNDING_PROJECT_REF: undefined })), /must name the same test project/);
    assert.match(refusal(previewEnv({ JIMOCEX_DEMO_FUNDING_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" })), /must name the same test project/);
  });

  test("an unknown environment is refused, never guessed", () => {
    for (const url of [
      "https://db.example.com",
      `http://${TEST_REF}.supabase.co`,
      `https://${TEST_REF}.supabase.co.evil.example`,
      "https://supabase.co",
      "not a url",
      "",
    ]) {
      assert.ok(!checkFundingEnvironment(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: url })).ok, url);
    }
    assert.ok(!checkFundingEnvironment(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined })).ok);
  });

  test("credentials in the URL, a missing key or a missing email are refused", () => {
    assert.match(refusal(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://u:p@${TEST_REF}.supabase.co` })), /credentials/);
    assert.match(refusal(previewEnv({ SUPABASE_SERVICE_ROLE_KEY: "" })), /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(refusal(previewEnv({ JIMOCEX_DEMO_ACCOUNT_EMAIL: undefined })), /JIMOCEX_DEMO_ACCOUNT_EMAIL/);
    assert.match(refusal(previewEnv({ JIMOCEX_DEMO_ACCOUNT_EMAIL: "not-an-email" })), /JIMOCEX_DEMO_ACCOUNT_EMAIL/);
  });

  test("a refusal never repeats the service-role key", () => {
    const key = "super-secret-service-role-key";
    for (const env of [
      previewEnv({ SUPABASE_SERVICE_ROLE_KEY: key, NEXT_PUBLIC_JIMOCEX_DEMO_MODE: "false" }),
      previewEnv({ SUPABASE_SERVICE_ROLE_KEY: key, NEXT_PUBLIC_SUPABASE_URL: "https://db.example.com" }),
      previewEnv({ SUPABASE_SERVICE_ROLE_KEY: key, JIMOCEX_DEMO_ACCOUNT_EMAIL: "" }),
    ]) {
      assert.doesNotMatch(refusal(env), new RegExp(key));
    }
  });
});

/* ===========================================================================
   Funding
   =========================================================================== */

/**
 * An in-memory ledger that behaves like ledger_post's dedup contract: an entry
 * per dedup key, a repeat refused as DUPLICATE. Balances are derived from the
 * entries, never written.
 */
function fakeLedger(over: Partial<FundingDeps> = {}) {
  const entries = new Map<string, { entryId: string; userId: string; assetId: string; amount: Money }>();
  const audits: string[] = [];
  const posts: { assetId: string; amount: string; dedupKey: string }[] = [];
  let n = 0;
  const deps: FundingDeps = {
    findAccount: async () => ({ userId: "user-demo", status: "ACTIVE" }),
    findAsset: async (symbol) => ({ assetId: `asset-${symbol}`, decimals: symbol === "USDT" ? 6 : 8, isActive: true }),
    findEntry: async (key) => {
      const e = entries.get(key);
      return e ? { entryId: e.entryId } : null;
    },
    postOpeningBalance: async ({ userId, assetId, amount, dedupKey }) => {
      if (entries.has(dedupKey)) return { ok: false, reason: "DUPLICATE" };
      const entryId = `entry-${++n}`;
      entries.set(dedupKey, { entryId, userId, assetId, amount });
      posts.push({ assetId, amount: formatMoney(amount), dedupKey });
      return { ok: true, entryId };
    },
    hasAuditRecord: async (entryId) => audits.includes(entryId),
    recordAudit: async ({ entryId }) => {
      audits.push(entryId);
    },
    ...over,
  };
  return { deps, entries, audits, posts };
}

const run = (deps: FundingDeps) => ensureDemoAccountFunded(deps, { email: "demo@example.com", environment: "preview" });

describe("ensureDemoAccountFunded", () => {
  test("a fresh account gets each opening balance once, through the ledger, with an audit record", async () => {
    const { deps, posts, audits } = fakeLedger();
    const report = await run(deps);

    assert.deepEqual(
      posts.map((p) => [p.assetId, p.amount, p.dedupKey]),
      DEMO_OPENING_BALANCES.map((b) => [`asset-${b.symbol}`, b.amount, dedupKeyFor("user-demo", b.symbol)]),
    );
    assert.ok(report.lines.every((l) => l.outcome === "funded"));
    assert.equal(audits.length, DEMO_OPENING_BALANCES.length);
  });

  test("a second run funds nothing and audits nothing more", async () => {
    const { deps, posts, audits } = fakeLedger();
    await run(deps);
    const second = await run(deps);

    assert.equal(posts.length, DEMO_OPENING_BALANCES.length);
    assert.equal(audits.length, DEMO_OPENING_BALANCES.length);
    assert.ok(second.lines.every((l) => l.outcome === "already funded"));
  });

  test("losing a race to a concurrent run is 'already funded', not a second entry", async () => {
    const ledger = fakeLedger();
    // The check sees nothing, then the post meets the winner's entry.
    let first = true;
    const realFind = ledger.deps.findEntry;
    ledger.deps.findEntry = async (key) => {
      if (first && key.endsWith(":USDT")) {
        first = false;
        ledger.entries.set(key, { entryId: "entry-winner", userId: "user-demo", assetId: "asset-USDT", amount: 0n as Money });
        return null;
      }
      return realFind(key);
    };
    const report = await run(ledger.deps);
    const usdt = report.lines.find((l) => l.symbol === "USDT");
    assert.deepEqual(usdt && [usdt.outcome, usdt.entryId], ["already funded", "entry-winner"]);
    assert.ok(!ledger.posts.some((p) => p.dedupKey.endsWith(":USDT")));
  });

  test("an interrupted run's missing audit record is completed on the next run", async () => {
    const { deps, audits } = fakeLedger();
    const failing = { ...deps, recordAudit: async () => { throw new Error("audit insert failed"); } };
    await assert.rejects(run(failing), /audit insert failed/);
    assert.equal(audits.length, 0);

    await run(deps);
    assert.equal(audits.length, DEMO_OPENING_BALANCES.length);
  });

  test("no account, or an account that is not ACTIVE, is refused before anything is posted", async () => {
    for (const account of [null, { userId: "user-demo", status: "SUSPENDED" }]) {
      const { deps, posts } = fakeLedger({ findAccount: async () => account });
      await assert.rejects(run(deps), FundingRefused);
      assert.equal(posts.length, 0);
    }
  });

  test("a missing, inactive or too-precise asset is refused before anything is posted", async () => {
    const cases: FundingDeps["findAsset"][] = [
      async (s) => (s === "SOL" ? null : { assetId: `asset-${s}`, decimals: 8, isActive: true }),
      async (s) => ({ assetId: `asset-${s}`, decimals: 8, isActive: s !== "ETH" }),
    ];
    for (const findAsset of cases) {
      const { deps, posts } = fakeLedger({ findAsset });
      await assert.rejects(run(deps), FundingRefused);
      assert.equal(posts.length, 0, "validation runs before the first post");
    }
  });

  test("the plan is whole units in exact Money — no float ever reaches the ledger", async () => {
    const { deps, posts } = fakeLedger();
    await run(deps);
    assert.deepEqual(posts.map((p) => p.amount), ["10000", "1", "10", "100"]);
  });
});
