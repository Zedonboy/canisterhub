#!/usr/bin/env -S deno run -A

import { execFileSync } from "node:child_process";
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
  deno task seed-packages --file ./production-packages.v1.0.0.json [options]

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
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("package file must be a non-empty JSON array");
  return raw.map((pkg, index) => {
    const label = `packages[${index}]`;
    for (const field of ["description", "package_name", "version", "sha"]) {
      if (typeof pkg[field] !== "string" || pkg[field].trim() === "") {
        throw new Error(`${label}.${field} must be a non-empty string`);
      }
    }
    if (!pkg.package_name.startsWith("https://")) throw new Error(`${label}.package_name must use HTTPS`);
    const artifactName = new URL(pkg.package_name).pathname.split("/").filter(Boolean).at(-1);
    if (!artifactName?.endsWith(".wasm")) {
      throw new Error(`${label}.package_name must be a GitHub release URL ending with a .wasm filename`);
    }
    if (!/^[0-9a-f]{64}$/.test(pkg.sha)) throw new Error(`${label}.sha must be lowercase SHA-256 hex`);
    const releasePath = new URL(pkg.package_name).pathname;
    if (new URL(pkg.package_name).hostname !== "github.com" || !releasePath.includes("/releases/download/")) {
      throw new Error(`${label}.package_name must point to a GitHub release asset`);
    }
    return { ...pkg, url: pkg.package_name };
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
  const options = parseArgs(Deno.args);
  if (options.help) return usage();
  if (!options.file) throw new Error("--file is required");

  const packages = packagesFrom(JSON.parse(await Deno.readTextFile(path.resolve(options.file))));
  const candid = candidArgs(packages);
  if (options.dryRun) {
    console.log(`Validated ${packages.length} package(s).\n${candid}`);
    return;
  }

  const argsFile = await Deno.makeTempFile({ suffix: ".did" });
  try {
    await Deno.writeTextFile(argsFile, candid);
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
    await Deno.remove(argsFile).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
});
