#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const backendDid = path.join(projectRoot, "backend", "backend.did");

function text(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function usage() {
  console.log(`Usage:
  npm run seed-packages -- --file ./package-seed.json [options]

Options:
  -f, --file <path>          Package JSON file (required)
  -e, --environment <name>  ICP environment (default: local)
  -i, --identity <name>     Controller identity (default: current identity)
  -b, --backend <target>    Backend name or principal (default: backend)
      --dry-run             Validate and print Candid without changing state
  -h, --help                Show this help`);
}

function parseArgs(argv) {
  const options = { file: null, environment: "local", identity: null, backend: "backend", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "-f" || arg === "--file") options.file = next();
    else if (arg === "-e" || arg === "--environment") options.environment = next();
    else if (arg === "-i" || arg === "--identity") options.identity = next();
    else if (arg === "-b" || arg === "--backend") options.backend = next();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function packagesFrom(raw) {
  const packages = Array.isArray(raw) ? raw : raw?.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("package file must be a non-empty JSON array or an object with a packages array");
  }
  return packages.map((pkg, index) => {
    const label = `packages[${index}]`;
    for (const field of ["description", "package_name", "download_url", "version", "sha"]) {
      if (typeof pkg[field] !== "string" || pkg[field].trim() === "") {
        throw new Error(`${label}.${field} must be a non-empty string`);
      }
    }
    const artifactName = new URL(pkg.download_url).pathname.split("/").filter(Boolean).at(-1);
    if (!artifactName?.endsWith(".wasm")) {
      throw new Error(`${label}.download_url must end with a .wasm filename`);
    }
    if (`${pkg.package_name}.wasm` !== artifactName) {
      throw new Error(`${label}.package_name must match the download_url filename without its .wasm extension`);
    }
    if (!/^[0-9a-f]{64}$/.test(pkg.sha)) throw new Error(`${label}.sha must be lowercase SHA-256 hex`);
    if (new URL(pkg.download_url).protocol !== "https:") {
      throw new Error(`${label}.download_url must use HTTPS`);
    }
    return { ...pkg, url: pkg.download_url };
  });
}

function candidArgs(packages) {
  const records = packages.map((pkg) => `record {
    description = ${text(pkg.description)};
    url = ${text(pkg.url)};
    version = ${text(pkg.version)};
    sha = ${text(pkg.sha)};
  }`).join(";\n");
  return `(vec { ${records} })`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (!options.file) throw new Error("--file is required");

  const packages = packagesFrom(JSON.parse(await readFile(path.resolve(options.file), "utf8")));
  const candid = candidArgs(packages);
  if (options.dryRun) {
    console.log(`Validated ${packages.length} package(s).\n${candid}`);
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "canister-hub-seed-packages-"));
  const argsFile = path.join(tempDir, "package-infos.did");
  try {
    await writeFile(argsFile, candid, { mode: 0o600 });
    const args = [
      "canister", "call", options.backend, "upload_package_infos",
      "--args-file", argsFile,
      "--args-format", "candid",
      "--candid", backendDid,
      "--json",
      "-e", options.environment,
    ];
    if (options.identity) args.push("--identity", options.identity);
    const stdout = execFileSync("icp", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const envelope = JSON.parse(stdout);
    const response = envelope.response_candid ?? envelope.response_text ?? stdout.trim();
    if (/variant\s*\{\s*Err\s*=/.test(response)) {
      throw new Error(`upload_package_infos failed: ${response}`);
    }
    console.log(`Seeded ${packages.length} package(s) into ${options.backend}; package ids were assigned by the backend.`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
