import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const runtimeDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function readPackageManifest(packagePath) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed package manifest at ${packagePath}: ${detail}`);
  }

  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error(`Malformed package manifest at ${packagePath}: expected a JSON object.`);
  }
  if (
    packageJson.publishConfig !== undefined &&
    (!packageJson.publishConfig || typeof packageJson.publishConfig !== "object" || Array.isArray(packageJson.publishConfig))
  ) {
    throw new Error(`Malformed package manifest at ${packagePath}: publishConfig must be an object.`);
  }
  for (const field of runtimeDependencyFields) {
    const dependencies = packageJson[field];
    if (dependencies !== undefined && (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))) {
      throw new Error(`Malformed package manifest at ${packagePath}: ${field} must be an object.`);
    }
  }
  return packageJson;
}

function runtimeOpenTagDependencies(packageJson) {
  const dependencies = new Set();
  for (const field of runtimeDependencyFields) {
    for (const dependencyName of Object.keys(packageJson[field] ?? {})) {
      if (dependencyName.startsWith("@opentag/")) {
        dependencies.add(dependencyName);
      }
    }
  }
  return [...dependencies].sort();
}

function insertSorted(values, value) {
  const index = values.findIndex((candidate) => candidate > value);
  if (index === -1) {
    values.push(value);
  } else {
    values.splice(index, 0, value);
  }
}

export function buildPublicPackagePlan(packagesDirectory) {
  const packageEntries = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packagePath = path.join(packagesDirectory, entry.name, "package.json");
      if (!existsSync(packagePath)) {
        return undefined;
      }
      return {
        directory: entry.name,
        packageJson: readPackageManifest(packagePath)
      };
    })
    .filter((entry) => entry !== undefined)
    .sort((left, right) => compareStrings(left.directory, right.directory));

  const directoryByName = new Map();
  for (const entry of packageEntries) {
    const packageName = entry.packageJson.name;
    if (typeof packageName !== "string" || packageName.trim() === "") {
      if (entry.packageJson.publishConfig?.access === "public") {
        throw new Error(`Malformed package manifest at packages/${entry.directory}/package.json: public packages require a name.`);
      }
      continue;
    }
    const existingDirectory = directoryByName.get(packageName);
    if (existingDirectory) {
      throw new Error(
        `Duplicate package name ${packageName} in packages/${existingDirectory}/package.json and packages/${entry.directory}/package.json.`
      );
    }
    directoryByName.set(packageName, entry.directory);
  }

  const publicEntries = packageEntries.filter((entry) => entry.packageJson.publishConfig?.access === "public");
  if (publicEntries.length === 0) {
    throw new Error(`No public packages found in ${packagesDirectory}.`);
  }
  const publicEntryByName = new Map();
  const packageNamesByVersion = new Map();
  for (const entry of publicEntries) {
    const packageName = entry.packageJson.name;
    if (typeof entry.packageJson.version !== "string" || entry.packageJson.version.trim() === "") {
      throw new Error(`Malformed package manifest at packages/${entry.directory}/package.json: public packages require a version.`);
    }
    publicEntryByName.set(packageName, entry);
    const packageNames = packageNamesByVersion.get(entry.packageJson.version) ?? [];
    packageNames.push(packageName);
    packageNamesByVersion.set(entry.packageJson.version, packageNames);
  }
  if (packageNamesByVersion.size > 1) {
    const versions = [...packageNamesByVersion.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([version, packageNames]) => `${version} (${packageNames.sort().join(", ")})`);
    throw new Error(`Public packages must use a lockstep version; found ${versions.join("; ")}.`);
  }

  const dependenciesByName = new Map();
  const dependentsByName = new Map(publicEntries.map((entry) => [entry.packageJson.name, []]));
  for (const entry of publicEntries) {
    const packageName = entry.packageJson.name;
    const dependencies = runtimeOpenTagDependencies(entry.packageJson);
    for (const dependencyName of dependencies) {
      if (!publicEntryByName.has(dependencyName)) {
        throw new Error(
          `Public package ${packageName} has runtime dependency ${dependencyName}, which is not in the public package set.`
        );
      }
      dependentsByName.get(dependencyName).push(packageName);
    }
    dependenciesByName.set(packageName, dependencies);
  }

  for (const dependents of dependentsByName.values()) {
    dependents.sort();
  }

  const ready = [...publicEntryByName.keys()]
    .filter((packageName) => dependenciesByName.get(packageName).length === 0)
    .sort();
  const orderedNames = [];

  while (ready.length > 0) {
    const packageName = ready.shift();
    orderedNames.push(packageName);
    for (const dependentName of dependentsByName.get(packageName)) {
      const remainingDependencies = dependenciesByName
        .get(dependentName)
        .filter((dependencyName) => dependencyName !== packageName);
      dependenciesByName.set(dependentName, remainingDependencies);
      if (remainingDependencies.length === 0) {
        insertSorted(ready, dependentName);
      }
    }
  }

  if (orderedNames.length !== publicEntries.length) {
    const cycleMembers = [...publicEntryByName.keys()]
      .filter((packageName) => dependenciesByName.get(packageName).length > 0)
      .sort();
    throw new Error(`Cycle detected in public package runtime dependencies: ${cycleMembers.join(", ")}.`);
  }

  return orderedNames.map((packageName) => publicEntryByName.get(packageName));
}
