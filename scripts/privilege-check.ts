/**
 * The comparison behind scripts/check-privileges.ts, without any I/O, so that
 * every rule can be tested against a catalog that breaks it
 * (scripts/__tests__/check-privileges.test.ts).
 *
 * The catalog is the JSON supabase/tests/02_money_catalog.sql emits.
 */

import {
  CLIENT_ROLE_BYPASSRLS,
  CLIENT_ROLE_MEMBERS,
  FORCE_RLS_TABLES,
  FUNCTION_SEARCH_PATH,
  POLICIES,
  PRIVILEGE_REGISTRY,
  ROLES,
  SCHEMA_PUBLIC,
  SECURITY_DEFINER_FUNCTIONS,
  TABLE_PRIVILEGE_LETTERS,
  type ColumnGrant,
  type Policy,
  type PrivilegeProfile,
} from "./privilege-registry.ts";

type PrivilegeKind = keyof typeof TABLE_PRIVILEGE_LETTERS;

export type CatalogFunction = {
  name: string;
  identity: string;
  executableBy: Record<"PUBLIC" | (typeof ROLES)[number], boolean>;
  otherGrantees: string[];
  securityDefiner: boolean;
  config: string[];
  owner: string;
};

export type CatalogPolicy = {
  table: string;
  name: string;
  cmd: string;
  permissive: boolean;
  roles: string[];
  using: string | null;
  check: string | null;
  expr: string;
};

export type PrivilegeCatalog = {
  functions: CatalogFunction[] | null;
  privileges: {
    serverVersionNum: number;
    tableKinds: PrivilegeKind[];
    relations: { name: string; kind: string; rls: boolean; force: boolean; owner: string }[];
    tableAcl: { table: string; role: string; privileges: PrivilegeKind[] }[];
    otherTableGrantees: string[];
    columnAcl: { table: string; column: string; grantee: string; privilege: string }[];
    policies: CatalogPolicy[];
    roles: {
      name: string;
      super: boolean;
      inherit: boolean;
      createrole: boolean;
      createdb: boolean;
      replication: boolean;
      login: boolean;
      bypassrls: boolean;
    }[];
    memberships: { role: string; member: string; inherit: boolean | null; set: boolean | null; admin: boolean }[];
    schemaPublic: { role: string; usage: boolean; create: boolean }[];
  };
};

const KIND_NAMES: Record<string, string> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
  S: "sequence",
};
const CLIENT = new Set<string>(ROLES);

/** pg_get_expr output, comparable across versions and search paths. */
export const normalizeExpr = (expr: string | null) =>
  expr === null ? null : expr.replace(/\bpublic\./g, "").replace(/\s+/g, " ").trim();

export function checkPrivileges(catalog: PrivilegeCatalog, profile: PrivilegeProfile): { problems: string[]; summary: string } {
  const { privileges } = catalog;
  const functions = catalog.functions ?? []; // json_agg over no rows is null
  const registry = PRIVILEGE_REGISTRY[profile];
  const problems: string[] = [];

  const letter = (kind: PrivilegeKind) => TABLE_PRIVILEGE_LETTERS[kind];
  // Only the kinds this server has: MAINTAIN is not checked on PostgreSQL 16.
  const checkedLetters = new Set<string>(privileges.tableKinds.map(letter));
  const expectedLetters = (spec: string) => new Set([...spec].filter((l) => checkedLetters.has(l)));
  const render = (letters: Iterable<string>) => {
    const order = Object.values(TABLE_PRIVILEGE_LETTERS) as string[];
    return [...letters].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join("") || "-";
  };

  /* -------------------------------------------------------------- relations */

  const relations = new Map(privileges.relations.map((r) => [r.name, r]));
  for (const rel of privileges.relations) {
    if (!(rel.name in registry.tables)) {
      problems.push(`${KIND_NAMES[rel.kind] ?? rel.kind} ${rel.name} is not in the privilege registry (profile ${profile})`);
    } else if (rel.kind !== "r") {
      problems.push(`${rel.name} is a ${KIND_NAMES[rel.kind] ?? rel.kind}; the registry lists it as a table`);
    }
    // Every client privilege in the registry assumes RLS decides which rows.
    if (rel.kind === "r" && !rel.rls) problems.push(`${rel.name} has row level security disabled`);
    if (rel.force !== FORCE_RLS_TABLES.includes(rel.name)) {
      problems.push(`${rel.name} ${rel.force ? "forces" : "does not force"} row level security; the registry says the opposite`);
    }
    // An owner holds every privilege implicitly and can alter or drop the table.
    if (CLIENT.has(rel.owner)) problems.push(`${rel.name} is owned by the client role ${rel.owner}`);
  }
  for (const table of Object.keys(registry.tables)) {
    if (!relations.has(table)) problems.push(`the privilege registry lists ${table}, which does not exist`);
  }

  /* ----------------------------------------------------------- table grants */

  for (const acl of privileges.tableAcl) {
    const spec = registry.tables[acl.table];
    if (!spec) continue; // reported above
    const held = new Set<string>(acl.privileges.map(letter));
    const expected = acl.role === "public" ? new Set<string>() : expectedLetters(spec[acl.role as (typeof ROLES)[number]]);
    const extra = [...held].filter((l) => !expected.has(l));
    const missing = [...expected].filter((l) => !held.has(l));
    const who = acl.role === "public" ? "PUBLIC" : acl.role;
    if (extra.length > 0 || missing.length > 0) {
      problems.push(
        `${acl.table}: ${who} holds ${render(held)}, the registry says ${render(expected)}` +
          (extra.length > 0 ? ` (extra ${render(extra)})` : "") +
          (missing.length > 0 ? ` (missing ${render(missing)})` : ""),
      );
    }
  }
  for (const table of Object.keys(registry.tables)) {
    for (const role of [...ROLES, "public"]) {
      if (relations.has(table) && !privileges.tableAcl.some((a) => a.table === table && a.role === role)) {
        problems.push(`${table}: no privilege row for ${role} in the catalog snapshot`);
      }
    }
  }
  for (const grant of privileges.otherTableGrantees) {
    problems.push(`table grant to a role outside the registry: ${grant}`);
  }

  /* ---------------------------------------------------------- column grants */

  const columnKey = (c: { table: string; column: string; grantee: string; privilege: string }) =>
    `${c.table}.${c.column}: ${c.grantee} ${c.privilege}`;
  const heldColumns = new Set(privileges.columnAcl.map(columnKey));
  const expectedColumns = new Set(registry.columns.map((c: ColumnGrant) => columnKey(c)));
  for (const k of heldColumns) if (!expectedColumns.has(k)) problems.push(`column grant not in the registry: ${k}`);
  for (const k of expectedColumns) if (!heldColumns.has(k)) problems.push(`column grant missing: ${k}`);

  /* -------------------------------------------------------------- functions */

  const seen = new Map<string, number>();
  for (const fn of functions) {
    seen.set(fn.name, (seen.get(fn.name) ?? 0) + 1);
    const label = `${fn.name}(${fn.identity})`;
    const expected = registry.functions[fn.name];
    if (!expected) {
      problems.push(`${label} is not in the privilege registry (profile ${profile})`);
      continue;
    }
    if (fn.executableBy.PUBLIC) problems.push(`${label} is executable by PUBLIC, i.e. by every role`);
    const granted = ROLES.filter((role) => fn.executableBy[role]);
    if ([...granted].sort().join() !== [...expected].sort().join()) {
      problems.push(`${label} is executable by [${granted}], the registry says [${[...expected].sort()}]`);
    }
    for (const grantee of fn.otherGrantees) problems.push(`${label}: EXECUTE granted to ${grantee}, a role outside the registry`);
    const definer = SECURITY_DEFINER_FUNCTIONS.includes(fn.name);
    if (fn.securityDefiner !== definer) {
      problems.push(`${label} is SECURITY ${fn.securityDefiner ? "DEFINER" : "INVOKER"}; the registry says ${definer ? "DEFINER" : "INVOKER"}`);
    }
    if (!fn.config.includes(FUNCTION_SEARCH_PATH)) {
      problems.push(`${label} does not pin ${FUNCTION_SEARCH_PATH} (config: [${fn.config}])`);
    }
    if (CLIENT.has(fn.owner)) problems.push(`${label} is owned by the client role ${fn.owner}`);
  }
  for (const [name, count] of seen) {
    if (count > 1) problems.push(`${name} is overloaded (${count} functions); the registry keys functions by name`);
  }
  for (const name of Object.keys(registry.functions)) {
    if (!seen.has(name)) problems.push(`the privilege registry lists function ${name}, which does not exist`);
  }
  for (const name of SECURITY_DEFINER_FUNCTIONS) {
    if (!(name in registry.functions)) problems.push(`SECURITY_DEFINER_FUNCTIONS lists ${name}, which the registry does not know`);
  }

  /* --------------------------------------------------------------- policies */

  const policyKey = (p: { table: string; name: string }) => `${p.table}.${p.name}`;
  const expectedPolicies = new Map(POLICIES.map((p: Policy) => [policyKey(p), p]));
  const heldPolicies = new Map(privileges.policies.map((p) => [policyKey(p), p]));
  for (const [key, held] of heldPolicies) {
    const want = expectedPolicies.get(key);
    if (!want) {
      problems.push(`policy ${key} is not in the registry (cmd ${held.cmd}, roles ${held.roles}, using ${held.using ?? "-"})`);
      continue;
    }
    const diffs: string[] = [];
    if (held.cmd !== want.cmd) diffs.push(`cmd ${held.cmd} ≠ ${want.cmd}`);
    if (held.permissive !== want.permissive) diffs.push(held.permissive ? "permissive ≠ restrictive" : "restrictive ≠ permissive");
    if ([...held.roles].sort().join() !== [...want.roles].sort().join()) diffs.push(`roles [${held.roles}] ≠ [${want.roles}]`);
    if (normalizeExpr(held.using) !== want.using) diffs.push(`using ${normalizeExpr(held.using)} ≠ ${want.using}`);
    if (normalizeExpr(held.check) !== want.check) diffs.push(`with check ${normalizeExpr(held.check)} ≠ ${want.check}`);
    if (diffs.length > 0) problems.push(`policy ${key} differs from the registry: ${diffs.join("; ")}`);
  }
  for (const key of expectedPolicies.keys()) {
    if (!heldPolicies.has(key)) problems.push(`policy ${key} is in the registry but does not exist`);
  }

  // A function an RLS policy calls must be executable by every client role the
  // policy applies to, or each query it guards fails with 42501 for that role.
  for (const policy of privileges.policies) {
    const roles = policy.roles.includes("PUBLIC") ? [...ROLES] : ROLES.filter((r) => policy.roles.includes(r));
    for (const fn of functions) {
      if (!new RegExp(`(^|[^\\w.])(public\\.)?${fn.name}\\(`).test(policy.expr)) continue;
      for (const role of roles) {
        if (!fn.executableBy[role]) {
          problems.push(`policy ${policy.name} on ${policy.table} calls ${fn.name}(), which ${role} cannot execute`);
        }
      }
    }
  }

  /* ---------------------------------------------------------- roles, schema */

  for (const role of ROLES) {
    const r = privileges.roles.find((x) => x.name === role);
    if (!r) {
      problems.push(`role ${role} does not exist`);
      continue;
    }
    for (const attr of ["super", "createrole", "createdb", "replication", "login"] as const) {
      if (r[attr]) problems.push(`role ${role} has ${attr.toUpperCase()}; client roles have none of these`);
    }
    if (r.bypassrls !== CLIENT_ROLE_BYPASSRLS[role]) {
      problems.push(`role ${role} ${r.bypassrls ? "bypasses" : "does not bypass"} RLS; the registry says the opposite`);
    }
  }
  for (const m of privileges.memberships) {
    if (CLIENT.has(m.member)) {
      problems.push(
        `client role ${m.member} is a member of ${m.role} (inherit ${m.inherit}, set ${m.set}); client roles belong to no role`,
      );
    }
    if (CLIENT.has(m.role)) {
      const allowed = CLIENT_ROLE_MEMBERS[m.member];
      if (!allowed) {
        problems.push(`${m.member} is a member of ${m.role}, and only ${Object.keys(CLIENT_ROLE_MEMBERS).join(", ")} may be`);
      } else if (allowed.inherit === false && m.inherit === true) {
        problems.push(`${m.member} inherits the privileges of ${m.role}; it may only SET ROLE to it`);
      }
    }
  }
  for (const s of privileges.schemaPublic) {
    const who = s.role === "public" ? "PUBLIC" : s.role;
    if (s.create !== (SCHEMA_PUBLIC.create as readonly string[]).includes(s.role)) {
      problems.push(`${who} ${s.create ? "can" : "cannot"} create objects in schema public; the registry says the opposite`);
    }
    if (s.role !== "public" && s.usage !== (SCHEMA_PUBLIC.usage as readonly string[]).includes(s.role)) {
      problems.push(`${who} ${s.usage ? "has" : "lacks"} USAGE on schema public; the registry says the opposite`);
    }
  }
  for (const role of ROLES) {
    if (!privileges.schemaPublic.some((s) => s.role === role)) problems.push(`schema public: no row for ${role} in the catalog snapshot`);
  }

  const version = Math.floor(privileges.serverVersionNum / 10000);
  const summary =
    `profile ${profile}, PostgreSQL ${version}: ${privileges.relations.length} tables x ${ROLES.length + 1} roles x ` +
    `${privileges.tableKinds.length} privileges, ${privileges.columnAcl.length} column grants, ` +
    `${functions.length} functions, ${privileges.policies.length} policies, ` +
    `${privileges.memberships.length} memberships: privilege registry matches the catalog` +
    (checkedLetters.has("M") ? "" : " (no MAINTAIN on this server)");
  return { problems, summary };
}
