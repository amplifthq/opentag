#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const providerPackages = new Set([
  "@opentag/github", "@opentag/slack",
]);
const sourceApps = [
  ["packages/slack", "@opentag/slack"],
];
const forbiddenImplementations = new Set([
  "@opentag/governance", "@opentag/local-runtime",
  "@opentag/runner", "@opentag/store",
]);
const runtimeAllowed = new Map([
  ["packages/source-app-runtime", new Set(["@opentag/core", "@opentag/delivery-contract"])],
  ["packages/delivery-runtime", new Set(["@opentag/delivery-contract", "@opentag/source-app-runtime"])],
]);
const errors = [];

function productionDependencies(packageDir) {
  const manifestPath = join(root, packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return { manifestPath, dependencies: Object.keys(manifest.dependencies ?? {}) };
}

const workspacePackages = new Map();
for (const base of ["apps", "packages"]) {
  for (const name of readdirSync(join(root, base)).sort()) {
    const packageDir = join(base, name);
    const manifestPath = join(root, packageDir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name === "string") workspacePackages.set(manifest.name, packageDir);
  }
}

function sourceFiles(directory) {
  const output = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) output.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/u.test(name)) output.push(path);
  }
  return output;
}

function importsFrom(path) {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "require" && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

function importDeclarationsFrom(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      declarations.push({ module: statement.moduleSpecifier.text,
        defaultImport: clause?.name?.text,
        namespaceImport: clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings),
        namedImports: clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.map((element) => (element.propertyName ?? element.name).text)
          : [] });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      declarations.push({ module: statement.moduleSpecifier.text, reexport: true, namedImports: [] });
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)
      && ((node.expression.kind === ts.SyntaxKind.ImportKeyword)
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      declarations.push({ module: node.arguments[0].text, dynamicImport: true, namedImports: [] });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return declarations;
}

function report(path, dependency, reason) {
  errors.push(`${relative(root, path)}: ${reason}: ${dependency}`);
}

for (const [packageDir, ownProvider] of sourceApps) {
  const directory = join(root, packageDir);
  const { manifestPath, dependencies } = productionDependencies(packageDir);
  for (const dependency of dependencies) {
    if (forbiddenImplementations.has(dependency)) {
      report(manifestPath, dependency, "Source App manifest depends on a hosted/store/governance implementation");
    }
    if (providerPackages.has(dependency) && dependency !== ownProvider) {
      report(manifestPath, dependency, `Source App for ${ownProvider} depends on another provider package`);
    }
  }
  for (const path of sourceFiles(join(directory, "src"))) {
    for (const dependency of importsFrom(path)) {
      if (forbiddenImplementations.has(dependency)
        || /(?:^|\/)hosted-runs(?:\/|$)|(?:^|\/)(?:runner|store)\/.*repository|governance\/.*evaluator/u.test(dependency)) {
        report(path, dependency, "Source App imports a hosted/Runner/store/governance implementation");
      }
      if (providerPackages.has(dependency) && dependency !== ownProvider) {
        report(path, dependency, `Source App for ${ownProvider} imports another provider package`);
      }
    }
  }
}

for (const [packageDir, allowed] of runtimeAllowed) {
  const { manifestPath, dependencies } = productionDependencies(packageDir);
  for (const dependency of dependencies) {
    if (dependency.startsWith("@opentag/") ? !allowed.has(dependency)
      : /(?:drizzle|sqlite|postgres|mysql|hono|express|fastify|koa|nestjs|slack|github|gitlab|lark|linear|discord|telegram|teams)/iu.test(dependency)) {
      report(manifestPath, dependency, "provider-neutral runtime manifest contains a DB, HTTP, provider, or application dependency");
    }
  }
}

const controlPlaneForbidden = new Set([
  "@opentag/store", "better-sqlite3",
  ...[...providerPackages].filter((name) => name !== "@opentag/slack" && name !== "@opentag/github"),
]);
const allowedControlPlaneGitHubHelpers = new Set([
  "assessExactPullRequestReadiness",
]);
const observedControlPlaneGitHubHelpers = new Set();
for (const path of sourceFiles(join(root, "apps/control-plane/src"))) {
  for (const declaration of importDeclarationsFrom(path)) {
    if (declaration.module === "@opentag/github") {
      const invalid = declaration.defaultImport || declaration.namespaceImport || declaration.reexport
        || declaration.dynamicImport
        || declaration.namedImports.length === 0
        || declaration.namedImports.some((name) => !allowedControlPlaneGitHubHelpers.has(name));
      if (invalid) report(path, "@opentag/github",
        "Control Plane may import only the explicitly classified pure GitHub publication helper by name");
      for (const name of declaration.namedImports) observedControlPlaneGitHubHelpers.add(name);
    }
  }
  for (const dependency of importsFrom(path)) {
    if (/drizzle-orm\/(?:better-sqlite3|bun-sqlite|expo-sqlite|op-sqlite|sql-js|sqlite-core)/u.test(dependency)) {
      report(path, dependency, "Control Plane imports a SQLite Drizzle adapter");
    }
    if (dependency === "@opentag/github"
      && !importDeclarationsFrom(path).some((declaration) => declaration.module === dependency)) {
      report(path, dependency, "Control Plane dynamically imports or re-exports the GitHub Source App package");
    }
  }
}
if ([...allowedControlPlaneGitHubHelpers].some((name) => !observedControlPlaneGitHubHelpers.has(name))) {
  report(join(root, "apps/control-plane/src"), "@opentag/github",
    "Control Plane GitHub helper allowlist drifted; the classified publication helper must remain explicit");
}
const visited = new Set();
function inspectControlPlaneGraph(packageDir) {
  if (visited.has(packageDir)) return;
  visited.add(packageDir);
  const { manifestPath, dependencies } = productionDependencies(packageDir);
  for (const dependency of dependencies) {
    if (controlPlaneForbidden.has(dependency)
      || /drizzle-orm\/(?:better-sqlite3|bun-sqlite|expo-sqlite|op-sqlite|sql-js|sqlite-core)/u.test(dependency)) {
      report(manifestPath, dependency, "Control Plane production dependency graph crosses a forbidden boundary");
    }
    if (dependency.startsWith("@opentag/")) {
      if (packageDir === "apps/control-plane" && dependency === "@opentag/github") continue;
      const child = workspacePackages.get(dependency);
      if (child) inspectControlPlaneGraph(child);
    }
  }
}
inspectControlPlaneGraph("apps/control-plane");

if (errors.length > 0) {
  console.error("Source App architecture boundary check failed:");
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  console.error("Move shared contracts/helpers into a provider-neutral package; do not import provider applications or hosted/store implementations across this boundary.");
  process.exit(1);
}
console.log(`Source App architecture boundaries passed (${sourceApps.length} app surfaces, ${runtimeAllowed.size} neutral runtimes, ${visited.size} Control Plane graph packages).`);
