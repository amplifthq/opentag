// Run inside the disposable image: audit installed versions, not a newly
// resolved lockfile. Only public dependency names and versions leave the image.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const inventory = Object.create(null);
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name === "package.json") {
      const { name, version } = JSON.parse(await readFile(path, "utf8"));
      if (typeof name !== "string" || typeof version !== "string" || name.startsWith("@opentag/")) continue;
      inventory[name] ??= [];
      if (!inventory[name].includes(version)) inventory[name].push(version);
    }
  }
}
await collect("/workspace/apps/control-plane/node_modules");
if (Object.keys(inventory).length < 1) throw new Error("image_audit_inventory_empty");
const response = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(inventory), signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`image_audit_registry_failed:${response.status}`);
const advisories = await response.json();
if (!advisories || typeof advisories !== "object" || Array.isArray(advisories)) {
  throw new Error("image_audit_response_invalid");
}
let blocking = false;
let count = 0;
for (const [name, entries] of Object.entries(advisories)) {
  if (!inventory[name] || !Array.isArray(entries)) throw new Error("image_audit_response_invalid");
  for (const entry of entries) {
    if (!entry || !["info", "low", "moderate", "high", "critical"].includes(entry.severity)
      || typeof entry.url !== "string") throw new Error("image_audit_response_invalid");
    count += 1;
    console.log(JSON.stringify({ package: name, severity: entry.severity, url: entry.url }));
    blocking ||= ["high", "critical"].includes(entry.severity);
  }
}
console.log(`Image audit: ${Object.keys(inventory).length} public packages; ${count} advisories.`);
if (blocking) throw new Error("image_audit_high_or_critical_advisory");
