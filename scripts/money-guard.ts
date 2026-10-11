/**
 * The money guard: a static check of the application code against the money
 * boundary (src/lib/money.ts, src/lib/db/money-columns.ts).
 *
 * It replaces a set of regular expressions that each claimed more than they
 * caught — `select("*")`, embedded resources, `Number(row.amount)` and every
 * write went straight past them. This one works on the TypeScript program
 * itself, with the type checker, so it sees through formatting, variables and
 * aliases:
 *
 *   select   a query on a money or jsonb table must cast every money column to
 *            text — a literal checked by selectProblems(), or moneySelect() on
 *            the same table. `*`, a bare select(), a dynamic column list and
 *            an uncast column inside an embedded resource are refused.
 *   write    insert/update/upsert on a money or jsonb table goes through
 *            moneyInsert()/moneyUpdate(); wallets and ledger_entries are never
 *            written directly at all.
 *   rpc      the function name is a literal listed in DB_FUNCTIONS; a function
 *            with money arguments receives them through moneyArgs().
 *   filter   a filter on a money column is never given a number or a Money.
 *            (postgrest-js types gt/gte/lt/lte with an `unknown` overload, so
 *            the compiler alone cannot refuse one.)
 *   float    Number(), parseFloat(), parseInt(), toFixed(), toPrecision(),
 *            valueAsNumber and Intl.NumberFormat are refused everywhere: none
 *            is needed outside money.ts, and each is how a figure becomes a
 *            double.
 *   money-op a Money is never an operand of arithmetic or ordering, never
 *            converted with String(), a template literal, toString() or
 *            JSON.stringify, never passed to Math — outside money.ts, which is
 *            where its arithmetic lives. A Money is a bigint scaled by 10^18:
 *            `a * b` compiles and is wrong by that factor, `${a}` renders the
 *            scaled digits.
 *
 * A line can be exempted with `// money-guard-allow: <reason>` on it or on the
 * line above. The reason is mandatory and every exemption is listed in the
 * test output, so none is invisible.
 *
 * Run by src/lib/db/__tests__/money-guard.test.ts, which also proves each rule
 * catches the violation it names, against fixtures.
 */

import path from "node:path";

import ts from "typescript";

import { DB_FUNCTIONS, JSON_COLUMNS, LEDGER_ONLY_TABLES, MONEY_COLUMNS, moneySelect, selectProblems } from "../src/lib/db/money-columns.ts";

export type Rule = "select" | "write" | "rpc" | "filter" | "float" | "money-op" | "allow";

export type Offence = {
  rule: Rule;
  file: string;
  line: number;
  message: string;
};

export type Exemption = { file: string; line: number; reason: string };

export const ROOT = path.resolve(import.meta.dirname, "..");

const SENSITIVE_TABLES = new Set<string>([...Object.keys(MONEY_COLUMNS), ...Object.keys(JSON_COLUMNS)]);
const LEDGER_ONLY = new Set<string>(LEDGER_ONLY_TABLES);
const MONEY_COLUMN_NAMES = new Set<string>(Object.values(MONEY_COLUMNS).flat());

const FILTER_METHODS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "like", "ilike", "filter", "not"]);
/** Filters whose value comes after an operator: `.filter(column, op, value)`, `.not(column, op, value)`. */
const OPERATOR_FILTERS = new Set(["filter", "not"]);
const WRITE_METHODS = new Set(["insert", "update", "upsert"]);
/** Number's members that inspect or name a value rather than produce a double from one. */
const SAFE_NUMBER_MEMBERS = new Set([
  "isInteger",
  "isSafeInteger",
  "isFinite",
  "isNaN",
  "MAX_SAFE_INTEGER",
  "MIN_SAFE_INTEGER",
  "MAX_VALUE",
  "MIN_VALUE",
  "EPSILON",
  "POSITIVE_INFINITY",
  "NEGATIVE_INFINITY",
]);
const FLOAT_METHODS = new Set(["toFixed", "toPrecision"]);
const MONEY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
]);

/** The module that implements Money is the one place its arithmetic may live. */
const MONEY_MODULE = path.join(ROOT, "src/lib/money.ts");

/** Application source the guard scans: src/ and scripts/, without tests. */
export function isScannedFile(fileName: string): boolean {
  const relative = path.relative(ROOT, fileName);
  if (relative.startsWith("..") || relative.includes("node_modules")) return false;
  if (!/^(src|scripts)[\\/]/.test(relative)) return false;
  if (/[\\/]__tests__[\\/]/.test(relative)) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(relative)) return false;
  return /\.[cm]?[jt]sx?$/.test(relative) && !relative.endsWith(".d.ts");
}

/**
 * Builds the TypeScript program from the project's tsconfig, plus any virtual
 * files (absolute path → source) — the test's fixtures.
 */
export function createGuardProgram(virtualFiles: Readonly<Record<string, string>> = {}): ts.Program {
  const configPath = path.join(ROOT, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`could not read ${configPath}`);

  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };
  delete options.tsBuildInfoFile;

  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtualFiles[fileName];
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.fileExists = (fileName) => fileName in virtualFiles || fileExists(fileName);
  host.readFile = (fileName) => virtualFiles[fileName] ?? readFile(fileName);

  return ts.createProgram({
    rootNames: [...parsed.fileNames, ...Object.keys(virtualFiles)],
    options,
    host,
  });
}

/** Checks the given files of a program. Returns offences and honoured exemptions. */
export function checkFiles(
  program: ts.Program,
  fileNames: readonly string[],
): { offences: Offence[]; exemptions: Exemption[] } {
  const checker = program.getTypeChecker();
  const offences: Offence[] = [];
  const exemptions: Exemption[] = [];

  for (const fileName of fileNames) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) throw new Error(`not in the program: ${fileName}`);
    const allows = collectAllows(sourceFile, offences);
    const isMoneyModule = path.resolve(fileName) === MONEY_MODULE;

    const report = (node: ts.Node, rule: Rule, message: string) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const reason = allows.get(line) ?? allows.get(line - 1);
      if (reason) {
        exemptions.push({ file: relative(fileName), line, reason });
        return;
      }
      offences.push({ rule, file: relative(fileName), line, message });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) checkFloatIdentifier(node, report);

      if (ts.isCallExpression(node)) {
        checkQueryCall(node, checker, report);
        checkFloatCall(node, report);
        if (!isMoneyModule) checkMoneyConversionCall(node, checker, report);
      } else if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === "valueAsNumber") report(node, "float", "valueAsNumber reads an input as a double");
      } else if (ts.isNewExpression(node)) {
        if (isIntlNumberFormat(node.expression)) report(node, "float", "Intl.NumberFormat formats a double");
      } else if (!isMoneyModule && ts.isBinaryExpression(node)) {
        if (MONEY_OPERATORS.has(node.operatorToken.kind) && (isMoney(checker, node.left) || isMoney(checker, node.right))) {
          report(
            node,
            "money-op",
            `"${node.operatorToken.getText()}" on a Money — use addMoney/subtractMoney/multiplyMoney/compareMoney from @/lib/money`,
          );
        }
      } else if (!isMoneyModule && ts.isPrefixUnaryExpression(node)) {
        if (
          (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) &&
          isMoney(checker, node.operand)
        ) {
          report(node, "money-op", "unary +/- on a Money — use negateMoney()");
        }
      } else if (!isMoneyModule && ts.isTemplateSpan(node)) {
        if (isMoney(checker, node.expression)) {
          report(node, "money-op", "a Money in a template literal renders its 10^18-scaled digits — use formatMoney()");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { offences, exemptions };
}

/* ===========================================================================
   Queries
   =========================================================================== */

type Report = (node: ts.Node, rule: Rule, message: string) => void;

function checkQueryCall(call: ts.CallExpression, checker: ts.TypeChecker, report: Report): void {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;

  if (method === "rpc" && isSupabaseClient(checker, callee.expression)) {
    checkRpc(call, report);
    return;
  }

  if (method !== "select" && !WRITE_METHODS.has(method) && !FILTER_METHODS.has(method) && method !== "match") {
    return;
  }

  const target = queryTarget(checker, callee.expression);
  if (target === null) return; // not a Supabase query
  if (target.kind === "rpc") return; // shaped by DB_FUNCTIONS; checked at the .rpc() call

  if (target.table === null) {
    report(call, "select", `.from() with a non-literal table: the guard cannot tell whether it holds money`);
    return;
  }
  const table = target.table;

  if (method === "select") checkSelect(call, table, report);
  else if (WRITE_METHODS.has(method)) checkWrite(call, table, method, report);
  else checkFilter(call, table, method, checker, report);
}

function checkSelect(call: ts.CallExpression, table: string, report: Report): void {
  const sensitive = SENSITIVE_TABLES.has(table);
  const arg = call.arguments[0];

  if (arg === undefined) {
    // A select() after a write returns the written row; on a money table
    // that row carries money uncast just the same.
    if (sensitive) report(call, "select", `.select() with no columns on ${table} reads every money column uncast`);
    return;
  }

  const literal = stringLiteral(arg);
  if (literal !== null) {
    for (const problem of selectProblems(sensitive ? table : null, literal)) {
      report(arg, "select", `${table}: ${problem}`);
    }
    return;
  }

  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === "moneySelect") {
    const tableArg = arg.arguments[0] && stringLiteral(arg.arguments[0]);
    const columnsArg = arg.arguments[1] && stringLiteral(arg.arguments[1]);
    if (tableArg !== table) {
      report(arg, "select", `moneySelect("${tableArg ?? "?"}") on a query from "${table}"`);
      return;
    }
    if (columnsArg === null || columnsArg === undefined) {
      report(arg, "select", `moneySelect() with a non-literal column list cannot be checked`);
      return;
    }
    try {
      moneySelect(tableArg as Parameters<typeof moneySelect>[0], columnsArg);
    } catch (error) {
      report(arg, "select", (error as Error).message);
    }
    return;
  }

  report(arg, "select", `${table}: a dynamic column list cannot be checked — use a literal or moneySelect()`);
}

function checkWrite(call: ts.CallExpression, table: string, method: string, report: Report): void {
  if (LEDGER_ONLY.has(table)) {
    report(call, "write", `${method}() on ${table}: balances move only through rpc("ledger_post", moneyArgs(…))`);
    return;
  }
  if (!SENSITIVE_TABLES.has(table)) return;

  const arg = call.arguments[0] && unwrap(call.arguments[0]);
  const helper = method === "update" ? "moneyUpdate" : "moneyInsert";
  const viaHelper = (node: ts.Node | undefined): boolean => {
    const inner = node && unwrap(node);
    return (
      inner !== undefined &&
      ts.isCallExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      (inner.expression.text === "moneyInsert" || inner.expression.text === "moneyUpdate") &&
      stringLiteral(inner.arguments[0]) === table
    );
  };

  const ok =
    viaHelper(arg) || (arg !== undefined && ts.isArrayLiteralExpression(arg) && arg.elements.every((e) => viaHelper(e)));
  if (!ok) report(call, "write", `${method}() on ${table} must pass its row through ${helper}("${table}", …)`);
}

function checkFilter(
  call: ts.CallExpression,
  table: string,
  method: string,
  checker: ts.TypeChecker,
  report: Report,
): void {
  if (method === "match") {
    const arg = call.arguments[0] && unwrap(call.arguments[0]);
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const property of arg.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name.getText().replace(/^["']|["']$/g, "");
        if (isMoneyFilterColumn(table, name) && isNumericValue(checker, property.initializer)) {
          report(property, "filter", `match() on ${table}.${name} with a number — filter with toDatabase(…)`);
        }
      }
    }
    return;
  }

  const column = call.arguments[0] && stringLiteral(call.arguments[0]);
  const valueIndex = OPERATOR_FILTERS.has(method) ? 2 : 1;
  const value = call.arguments[valueIndex] && unwrap(call.arguments[valueIndex]);
  if (!column || value === undefined || !isMoneyFilterColumn(table, column)) return;

  const values = method === "in" && ts.isArrayLiteralExpression(value) ? [...value.elements] : [value];
  for (const item of values) {
    if (isNumericValue(checker, item)) {
      report(item, "filter", `${method}("${column}") on ${table} with a number — filter with toDatabase(…)`);
    }
  }
}

function isMoneyFilterColumn(table: string, column: string): boolean {
  // "relation.column" filters an embedded resource; any money name counts.
  const bare = column.includes(".") ? column.split(".").pop()! : column;
  const own = (MONEY_COLUMNS as Record<string, readonly string[]>)[table] ?? [];
  return own.includes(bare) || (column.includes(".") && MONEY_COLUMN_NAMES.has(bare));
}

function checkRpc(call: ts.CallExpression, report: Report): void {
  const name = call.arguments[0] && stringLiteral(call.arguments[0]);
  if (!name) {
    report(call, "rpc", "rpc() with a non-literal function name cannot be checked");
    return;
  }
  const entry = (DB_FUNCTIONS as Record<string, { args: readonly string[] }>)[name];
  if (!entry) {
    report(call, "rpc", `rpc("${name}"): not in DB_FUNCTIONS — classify it in src/lib/db/money-columns.ts`);
    return;
  }
  if (entry.args.length === 0) return;

  const args = call.arguments[1];
  const viaHelper =
    args !== undefined &&
    ts.isCallExpression(args) &&
    ts.isIdentifier(args.expression) &&
    args.expression.text === "moneyArgs" &&
    stringLiteral(args.arguments[0]) === name;
  if (!viaHelper) report(call, "rpc", `rpc("${name}") takes money arguments; pass them through moneyArgs("${name}", …)`);
}

/**
 * Which table a query-builder expression targets, read from its type: the
 * postgrest-js builders carry the relation name as a string-literal type
 * argument, so this sees through variables and helper functions alike.
 */
function queryTarget(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): { kind: "from"; table: string | null } | { kind: "rpc" } | null {
  // Syntactic first: `client.from("x")…` and `client.rpc("x")…` directly.
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      const name = current.expression.name.text;
      if ((name === "from" || name === "rpc") && isSupabaseClient(checker, current.expression.expression)) {
        if (name === "rpc") return { kind: "rpc" };
        const table = current.arguments[0] ? stringLiteral(current.arguments[0]) : null;
        return { kind: "from", table };
      }
      current = current.expression.expression;
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else {
      break;
    }
  }

  // Through a variable: read the builder's type.
  const type = checker.getTypeAtLocation(expression);
  const symbolName = type.getSymbol()?.getName() ?? "";
  if (!/^Postgrest(Query|Filter|Transform)Builder$/.test(symbolName)) return null;
  const isReference = ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
  for (const argument of isReference ? checker.getTypeArguments(type as ts.TypeReference) : []) {
    if (argument.isStringLiteral()) {
      if (argument.value in DB_FUNCTIONS) return { kind: "rpc" };
      return { kind: "from", table: argument.value };
    }
  }
  return { kind: "from", table: null };
}

function isSupabaseClient(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(expression);
  const apparent = checker.getApparentType(type);
  return ["from", "rpc", "schema"].every((name) => apparent.getProperty(name) !== undefined);
}

/* ===========================================================================
   Floats and Money conversions
   =========================================================================== */

/**
 * Any reference to Number, parseFloat or parseInt as a value — a call, an alias
 * (`const N = Number`), a callback (`.map(Number)`), `globalThis.parseFloat` —
 * except Number's inspecting members (`Number.isInteger`) and type positions.
 * Matching references rather than calls is what makes an alias no way around it.
 */
function checkFloatIdentifier(node: ts.Identifier, report: Report): void {
  const name = node.text;
  if (name !== "Number" && name !== "parseFloat" && name !== "parseInt") return;

  const parent = node.parent;
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    // `x.parseFloat` — the global reached through an object. `Number.parseFloat`
    // is reported once, on Number.
    if (name === "Number") return;
    if (ts.isIdentifier(parent.expression) && parent.expression.text === "Number") return;
    report(node, "float", `${name} turns a figure into a double — parse decimals with @/lib/money`);
    return;
  }
  if (
    (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return; // an object key that happens to be spelled the same
  }
  if (name === "Number" && ts.isPropertyAccessExpression(parent) && SAFE_NUMBER_MEMBERS.has(parent.name.text)) return;

  report(node, "float", `${name} turns a figure into a double — parse decimals with @/lib/money`);
}

function checkFloatCall(call: ts.CallExpression, report: Report): void {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (FLOAT_METHODS.has(name)) {
      report(call, "float", `${name}() formats a double — format Money with formatMoney()`);
    } else if (isIntlNumberFormat(callee.expression) && name === "format") {
      report(call, "float", "Intl.NumberFormat formats a double");
    }
  } else if (isIntlNumberFormat(callee)) {
    report(call, "float", "Intl.NumberFormat formats a double");
  }
}

function checkMoneyConversionCall(call: ts.CallExpression, checker: ts.TypeChecker, report: Report): void {
  const callee = call.expression;
  const first = call.arguments[0];

  if (ts.isIdentifier(callee) && callee.text === "String" && first && isMoney(checker, first)) {
    report(call, "money-op", "String() on a Money renders its 10^18-scaled digits — use formatMoney()");
  } else if (ts.isPropertyAccessExpression(callee)) {
    const receiver = callee.expression;
    const name = callee.name.text;
    if ((name === "toString" || name === "toLocaleString" || name === "valueOf") && isMoney(checker, receiver)) {
      report(call, "money-op", `${name}() on a Money — use formatMoney() or toDecimalString()`);
    } else if (ts.isIdentifier(receiver) && receiver.text === "Math" && call.arguments.some((a) => isMoney(checker, a))) {
      report(call, "money-op", `Math.${name}() on a Money — Math works on doubles`);
    } else if (
      ts.isIdentifier(receiver) &&
      receiver.text === "JSON" &&
      name === "stringify" &&
      first &&
      isMoney(checker, first)
    ) {
      report(call, "money-op", "JSON.stringify of a Money — serialise with toDecimalString()");
    }
  }
}

/** A Money, or a union containing one (Money | null). Recognised by its brand. */
function isMoney(checker: ts.TypeChecker, node: ts.Node): boolean {
  return hasBrand(checker.getTypeAtLocation(unwrap(node)), "MoneyBrand");
}

function hasBrand(type: ts.Type, brand: string): boolean {
  if (type.isUnion()) return type.types.some((t) => hasBrand(t, brand));
  return type.getProperties().some((property) => property.getEscapedName().toString().includes(brand));
}

/** A filter value that is a number, a bigint or a Money — never a decimal string. */
function isNumericValue(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(unwrap(node));
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (t) => (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0 || hasBrand(t, "MoneyBrand"),
  );
}

function isIntlNumberFormat(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Intl" &&
    node.name.text === "NumberFormat"
  );
}

/* ===========================================================================
   Helpers
   =========================================================================== */

function stringLiteral(node: ts.Node | undefined): string | null {
  const inner = node && unwrap(node);
  if (inner && (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))) return inner.text;
  return null;
}

/**
 * Looks through `as`, `!`, `satisfies`, `<T>x` and parentheses. A type
 * assertion changes what the compiler believes, not what is sent: `price as
 * unknown as string` is still a Money at runtime, so the guard judges the
 * expression underneath.
 */
function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** `// money-guard-allow: <reason>` — by line. A marker without a reason is itself an offence. */
function collectAllows(sourceFile: ts.SourceFile, offences: Offence[]): Map<number, string> {
  const allows = new Map<number, string>();
  sourceFile.text.split("\n").forEach((text, index) => {
    const match = /\/\/\s*money-guard-allow:?(.*)$/.exec(text);
    if (!match) return;
    const reason = (match[1] ?? "").trim();
    if (!reason) {
      offences.push({
        rule: "allow",
        file: relative(sourceFile.fileName),
        line: index + 1,
        message: "money-guard-allow needs a reason",
      });
      return;
    }
    allows.set(index + 1, reason);
  });
  return allows;
}

function relative(fileName: string): string {
  return path.relative(ROOT, fileName);
}
