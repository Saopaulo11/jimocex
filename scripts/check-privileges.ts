/**
 * Compares the privilege registry (scripts/privilege-registry.ts) with the
 * catalog of a database built from the migrations.
 *
 *   node --experimental-strip-types scripts/check-privileges.ts catalog.json [017|019]
 *
 * Run by scripts/test-db.sh on the JSON that supabase/tests/02_money_catalog.sql
 * emits, with the profile from JIMOCEX_PRIVILEGE_PROFILE (default 017). Exact in
 * both directions: a privilege the registry does not list fails, and so does one
 * it lists that the database lacks. The rules are in scripts/privilege-check.ts.
 *
 * Exits 1 listing every disagreement.
 */

import { readFileSync } from "node:fs";

import { checkPrivileges, type PrivilegeCatalog } from "./privilege-check.ts";
import { isPrivilegeProfile } from "./privilege-registry.ts";

const [file, profile = "017"] = process.argv.slice(2);
if (!file || !isPrivilegeProfile(profile)) {
  console.error("usage: check-privileges.ts <catalog.json> [017|019]");
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(file, "utf8")) as PrivilegeCatalog;
const { problems, summary } = checkPrivileges(catalog, profile);

if (problems.length > 0) {
  console.error(`privilege registry (profile ${profile}) does not match the database (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`    ${summary}`);
