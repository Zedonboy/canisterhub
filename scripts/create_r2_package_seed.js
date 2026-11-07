#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--version", "--base-url", "--wasm-dir", "--output"].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }
  for (const key of ["version", "base_url", "wasm_dir", "output"]) {
    if (!options[key]) throw new Error(`Missing --${key.replaceAll("_", "-")}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.version)) {
    throw new Error("Version/tag may contain only letters, numbers, dots, underscores, and hyphens");
  }
  const base = new URL(options.base_url);
  if (base.protocol !== "https:") throw new Error("--base-url must use HTTPS");
  options.base_url = base.href.replace(/\/$/, "");
  options.wasm_dir = path.resolve(projectRoot, options.wasm_dir);
  options.output = path.resolve(projectRoot, options.output);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const descriptions = JSON.parse(
    await readFile(path.join(scriptDir, "production-packages.v1.1.0.json"), "utf8"),
  );
  const records = [];
  for (const entry of descriptions) {
    const filename = `${entry.package_name}.wasm`;
    const bytes = await readFile(path.join(options.wasm_dir, filename));
    records.push({
      description: entry.description,
      package_name: entry.package_name,
      download_url: `${options.base_url}/${encodeURIComponent(options.version)}/${encodeURIComponent(filename)}`,
      version: options.version,
      sha: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(options.output, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`Wrote ${records.length} R2 package records to ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
