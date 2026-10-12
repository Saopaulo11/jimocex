/**
 * Every rule of scripts/privilege-check.ts, seen failing. A catalog that
 * matches the registry exactly is built from the registry itself; each test
 * then breaks one thing and requires the problem that names it. The database
 * side — that 02_money_catalog.sql really reports these facts — is exercised by
 * scripts/test-db.sh and by the mutation runs in docs/review-019-privileges.md.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPrivileges, type PrivilegeCatalog } from "../privilege-check.ts";
import {
  FUNCTION_SEARCH_PATH,
  POLICIES,
  PRIVILEGE_PROFILES,
  PRIVILEGE_REGISTRY,
  ROLES,
  SECURITY_DEFINER_FUNCTIONS,
  TABLE_PRIVILEGE_LETTERS,
  type PrivilegeProfile,
} from "../privilege-registry.ts";

type Kind = keyof typeof TABLE_PRIVILEGE_LETTERS;
const KINDS = Object.keys(TABLE_PRIVILEGE_LETTERS) as Kind[];

/** A catalog exactly as the registry describes it, as one server version reports it. */
function catalogFor(profile: PrivilegeProfile, pg17 = true): PrivilegeCatalog {
  const registry = PRIVILEGE_REGISTRY[profile];
  const tableKinds = KINDS.filter((k) => pg17 || k !== "MAINTAIN");
  const kindsOf = (letters: string) => tableKinds.filter((k) => letters.includes(TABLE_PRIVILEGE_LETTERS[k]));
  return {
    functions: Object.entries(registry.functions).map(([name, executors]) => ({
      name,
      identity: "",
      executableBy: {
        PUBLIC: false,
        anon: executors.includes("anon"),
        authenticated: executors.includes("authenticated"),
        service_role: executors.includes("service_role"),
      },
      otherGrantees: [],
      securityDefiner: SECURITY_DEFINER_FUNCTIONS.includes(name),
      config: [FUNCTION_SEARCH_PATH],
      owner: "postgres",
    })),
    privileges: {
      serverVersionNum: pg17 ? 170010 : 160015,
      tableKinds,
      relations: Object.keys(registry.tables).map((name) => ({ name, kind: "r", rls: true, force: false, owner: "postgres" })),
      tableAcl: Object.entries(registry.tables).flatMap(([table, spec]) => [
        ...ROLES.map((role) => ({ table, role, privileges: kindsOf(spec[role]) })),
        { table, role: "public", privileges: [] },
      ]),
      otherTableGrantees: [],
      columnAcl: registry.columns.map((c) => ({ ...c })),
      policies: POLICIES.map((p) => ({
        ...p,
        roles: [...p.roles],
        expr: [p.using, p.check].filter(Boolean).join(" "),
      })),
      roles: ROLES.map((name) => ({
        name,
        super: false,
        inherit: true,
        createrole: false,
        createdb: false,
        replication: false,
        login: false,
        bypassrls: name === "service_role",
      })),
      memberships: ROLES.flatMap((role) => [
        { role, member: "authenticator", inherit: false, set: true, admin: false },
        { role, member: "postgres", inherit: true, set: true, admin: false },
      ]),
      schemaPublic: [...ROLES, "public"].map((role) => ({ role, usage: true, create: false })),
    },
  };
}

function problemsAfter(change: (c: PrivilegeCatalog) => void, profile: PrivilegeProfile = "019", pg17 = true) {
  const catalog = catalogFor(profile, pg17);
  change(catalog);
  return checkPrivileges(catalog, profile).problems;
}

function assertFlags(problems: string[], expected: RegExp) {
  assert.ok(
    problems.some((p) => expected.test(p)),
    `expected a problem matching ${expected}, got:\n  ${problems.join("\n  ") || "(none)"}`,
  );
}

const fn = (c: PrivilegeCatalog, name: string) => {
  const f = c.functions?.find((x) => x.name === name);
  assert.ok(f, `no function ${name} in the synthetic catalog`);
  return f;
};
const acl = (c: PrivilegeCatalog, table: string, role: string) => {
  const a = c.privileges.tableAcl.find((x) => x.table === table && x.role === role);
  assert.ok(a);
  return a;
};
const policy = (c: PrivilegeCatalog, name: string) => {
  const p = c.privileges.policies.find((x) => x.name === name);
  assert.ok(p);
  return p;
};

describe("a catalog that matches the registry", () => {
  for (const profile of PRIVILEGE_PROFILES) {
    for (const pg17 of [false, true]) {
      it(`passes for profile ${profile} on PostgreSQL ${pg17 ? 17 : 16}`, () => {
        assert.deepEqual(checkPrivileges(catalogFor(profile, pg17), profile).problems, []);
      });
    }
  }
});

describe("table and column grants", () => {
  it("an extra table privilege", () =>
    assertFlags(problemsAfter((c) => acl(c, "wallets", "authenticated").privileges.push("INSERT")), /wallets: authenticated .*\(extra I\)/));
  it("a missing table privilege", () =>
    assertFlags(problemsAfter((c) => (acl(c, "assets", "anon").privileges = [])), /assets: anon .*\(missing S\)/));
  it("a privilege for PUBLIC", () =>
    assertFlags(problemsAfter((c) => acl(c, "audit_logs", "public").privileges.push("SELECT")), /audit_logs: PUBLIC holds S/));
  it("MAINTAIN on PostgreSQL 17", () =>
    assertFlags(problemsAfter((c) => acl(c, "assets", "service_role").privileges.push("MAINTAIN")), /\(extra M\)/));
  it("MAINTAIN is not expected on PostgreSQL 16", () =>
    assert.deepEqual(problemsAfter(() => {}, "017", false), []));
  it("a grant to a role outside the registry", () =>
    assertFlags(problemsAfter((c) => c.privileges.otherTableGrantees.push("wallets: someone SELECT")), /outside the registry: wallets/));
  it("an extra column grant", () =>
    assertFlags(
      problemsAfter((c) => c.privileges.columnAcl.push({ table: "profiles", column: "tier_code", grantee: "authenticated", privilege: "UPDATE" })),
      /column grant not in the registry: profiles\.tier_code/,
    ));
  it("a missing column grant", () =>
    assertFlags(problemsAfter((c) => c.privileges.columnAcl.pop()), /column grant missing/));
});

describe("relations", () => {
  it("a table the registry does not know", () =>
    assertFlags(
      problemsAfter((c) => c.privileges.relations.push({ name: "tst_new", kind: "r", rls: true, force: false, owner: "postgres" })),
      /table tst_new is not in the privilege registry/,
    ));
  it("a view", () =>
    assertFlags(
      problemsAfter((c) => c.privileges.relations.push({ name: "tst_view", kind: "v", rls: false, force: false, owner: "postgres" })),
      /view tst_view is not in the privilege registry/,
    ));
  it("a registered table that is gone", () =>
    assertFlags(problemsAfter((c) => (c.privileges.relations = c.privileges.relations.filter((r) => r.name !== "trades"))), /lists trades, which does not exist/));
  it("RLS disabled", () =>
    assertFlags(problemsAfter((c) => (c.privileges.relations[0]!.rls = false)), /row level security disabled/));
  it("FORCE RLS on a table", () =>
    assertFlags(problemsAfter((c) => (c.privileges.relations[0]!.force = true)), /forces row level security/));
  it("a table owned by a client role", () =>
    assertFlags(problemsAfter((c) => (c.privileges.relations[0]!.owner = "service_role")), /owned by the client role service_role/));
});

describe("functions", () => {
  it("an extra executor", () =>
    assertFlags(problemsAfter((c) => (fn(c, "is_admin").executableBy.service_role = true)), /is_admin\(\) is executable by \[service_role\], the registry says \[\]/));
  it("a missing executor", () =>
    assertFlags(problemsAfter((c) => (fn(c, "limit_usage_total").executableBy.service_role = false)), /limit_usage_total\(\) is executable by \[\]/));
  it("EXECUTE for PUBLIC", () =>
    assertFlags(problemsAfter((c) => (fn(c, "ledger_post").executableBy.PUBLIC = true)), /ledger_post\(\) is executable by PUBLIC/));
  it("EXECUTE for a role outside the registry", () =>
    assertFlags(problemsAfter((c) => fn(c, "ledger_post").otherGrantees.push("someone")), /EXECUTE granted to someone/));
  it("a function the registry does not know", () =>
    assertFlags(
      problemsAfter((c) => c.functions!.push({ ...fn(c, "is_admin"), name: "tst_new_fn" })),
      /tst_new_fn\(\) is not in the privilege registry/,
    ));
  it("an overloaded name", () =>
    assertFlags(problemsAfter((c) => c.functions!.push({ ...fn(c, "is_admin"), identity: "x uuid" })), /is_admin is overloaded/));
  it("SECURITY DEFINER where the registry says INVOKER", () =>
    assertFlags(problemsAfter((c) => (fn(c, "limit_usage_total").securityDefiner = true)), /limit_usage_total\(\) is SECURITY DEFINER; the registry says INVOKER/));
  it("SECURITY INVOKER where the registry says DEFINER", () =>
    assertFlags(problemsAfter((c) => (fn(c, "ledger_post").securityDefiner = false)), /ledger_post\(\) is SECURITY INVOKER; the registry says DEFINER/));
  it("a function without an empty search_path", () =>
    assertFlags(problemsAfter((c) => (fn(c, "ledger_post").config = [])), /ledger_post\(\) does not pin search_path=""/));
  it("a function owned by a client role", () =>
    assertFlags(problemsAfter((c) => (fn(c, "ledger_post").owner = "authenticated")), /owned by the client role authenticated/));
});

describe("policies", () => {
  it("an unexpected policy", () =>
    assertFlags(
      problemsAfter((c) =>
        c.privileges.policies.push({ table: "wallets", name: "tst_leak", cmd: "r", permissive: true, roles: ["anon"], using: "true", check: null, expr: "true" }),
      ),
      /policy wallets\.tst_leak is not in the registry/,
    ));
  it("a dropped policy", () =>
    assertFlags(
      problemsAfter((c) => (c.privileges.policies = c.privileges.policies.filter((p) => p.name !== "notifications_own_update"))),
      /notifications_own_update is in the registry but does not exist/,
    ));
  it("a widened USING", () =>
    assertFlags(problemsAfter((c) => (policy(c, "profiles_own_update").using = "true")), /profiles_own_update differs .*using true/));
  it("a widened WITH CHECK", () =>
    assertFlags(problemsAfter((c) => (policy(c, "profiles_own_update").check = "true")), /profiles_own_update differs .*with check true/));
  it("a policy made restrictive", () =>
    assertFlags(problemsAfter((c) => (policy(c, "wallets_own_read").permissive = false)), /wallets_own_read differs .*restrictive/));
  it("a policy given to another role", () =>
    assertFlags(problemsAfter((c) => (policy(c, "wallets_own_read").roles = ["anon", "authenticated"])), /wallets_own_read differs .*roles/));
  it("a policy for another command", () =>
    assertFlags(problemsAfter((c) => (policy(c, "wallets_own_read").cmd = "*")), /wallets_own_read differs .*cmd \*/));
  it("formatting and schema qualification do not count as a change", () =>
    assert.deepEqual(
      problemsAfter((c) => (policy(c, "trades_own_read").using = policy(c, "trades_own_read").using!.replace("FROM trading_orders", "\n   FROM public.trading_orders"))),
      [],
    ));
  it("a policy that calls a function its role cannot execute", () =>
    assertFlags(
      problemsAfter((c) =>
        c.privileges.policies.push({
          table: "assets",
          name: "assets_public_read",
          cmd: "r",
          permissive: true,
          roles: ["anon"],
          using: "public.is_admin()",
          check: null,
          expr: "public.is_admin()",
        }),
      ),
      /calls is_admin\(\), which anon cannot execute/,
    ));
});

describe("roles and schema public", () => {
  it("a client role that is a member of another role, even SET-only", () =>
    assertFlags(
      problemsAfter((c) => c.privileges.memberships.push({ role: "service_role", member: "authenticated", inherit: false, set: true, admin: false })),
      /client role authenticated is a member of service_role/,
    ));
  it("a client role inheriting a predefined role", () =>
    assertFlags(
      problemsAfter((c) => c.privileges.memberships.push({ role: "pg_read_all_data", member: "anon", inherit: true, set: true, admin: false })),
      /client role anon is a member of pg_read_all_data/,
    ));
  it("an unexpected member of a client role", () =>
    assertFlags(
      problemsAfter((c) => c.privileges.memberships.push({ role: "service_role", member: "someone", inherit: false, set: true, admin: false })),
      /someone is a member of service_role, and only/,
    ));
  it("authenticator inheriting a client role", () =>
    assertFlags(
      problemsAfter((c) => (c.privileges.memberships.find((m) => m.member === "authenticator")!.inherit = true)),
      /authenticator inherits the privileges of anon/,
    ));
  it("a client role with LOGIN", () =>
    assertFlags(problemsAfter((c) => (c.privileges.roles.find((r) => r.name === "anon")!.login = true)), /role anon has LOGIN/));
  it("BYPASSRLS on anon", () =>
    assertFlags(problemsAfter((c) => (c.privileges.roles.find((r) => r.name === "anon")!.bypassrls = true)), /role anon bypasses RLS/));
  it("service_role without BYPASSRLS", () =>
    assertFlags(problemsAfter((c) => (c.privileges.roles.find((r) => r.name === "service_role")!.bypassrls = false)), /service_role does not bypass RLS/));
  it("a missing client role", () =>
    assertFlags(problemsAfter((c) => (c.privileges.roles = c.privileges.roles.filter((r) => r.name !== "anon"))), /role anon does not exist/));
  it("CREATE on schema public for a client role", () =>
    assertFlags(problemsAfter((c) => (c.privileges.schemaPublic.find((s) => s.role === "authenticated")!.create = true)), /authenticated can create objects in schema public/));
  it("CREATE on schema public for PUBLIC", () =>
    assertFlags(problemsAfter((c) => (c.privileges.schemaPublic.find((s) => s.role === "public")!.create = true)), /PUBLIC can create objects in schema public/));
  it("a client role without USAGE on schema public", () =>
    assertFlags(problemsAfter((c) => (c.privileges.schemaPublic.find((s) => s.role === "anon")!.usage = false)), /anon lacks USAGE on schema public/));
});
