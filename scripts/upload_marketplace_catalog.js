#!/usr/bin/env node
"use strict";

/**
 * Uploads controller-curated templates and free packages to the backend.
 *
 * The script deliberately delegates signing, root-key handling, and network
 * selection to `icp canister call`. It therefore uses the same named identity
 * and environment as the rest of the project and never handles a controller
 * private key itself.
 *
 * Usage:
 *   npm run upload-catalog -- --file ./catalog.json --identity deploy -e ic
 *
 * Run with --help for every option and the catalog shape.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const backendDid = path.join(projectRoot, "backend", "backend.did");

function usage() {
  console.log(`Usage:
  node scripts/upload_marketplace_catalog.js --file <catalog.json> [options]

Options:
  -f, --file <path>          JSON catalog to upload (required)
  -e, --environment <name>  ICP environment (default: local)
  -i, --identity <name>     Named ICP CLI identity (default: current identity)
  -b, --backend <target>    Backend canister name or principal (default: backend)
      --dry-run             Validate/hash everything without canister calls
  -h, --help                Show this help

Catalog shape:
{
  "templates": [{
    "title": "Food Order Service",
    "description": "A complete ordering stack",
    "web_url": "https://example.com/food-order",
    "git_repo_url": "https://github.com/owner/repo",
    "download_url": "https://github.com/owner/repo/releases/download/v1/canister_hub.toml",
    "release_tag": "v1",
    "package_slug": "food-order-service",
    "manifest_file": "../Templates/food-order-service/canister_hub.toml"
  }],
  "packages": [{
    "title": "Agent",
    "description": "Private SME AI agent",
    "git_repo_url": "https://github.com/owner/repo",
    "download_url": "https://github.com/owner/repo/releases/download/v1/agent.canister_hub.toml",
    "release_tag": "v1",
    "package_slug": "agent",
    "wasm_file": "../packages/bin/agent.wasm"
  }]
}

File paths are resolved relative to the catalog file. Packages uploaded by
this script are free. Use publish_to_marketplace.js for paid/encrypted items.`);
}

function parseArgs(argv) {
  const options = {
    environment: "local",
    identity: null,
    backend: "backend",
    file: null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
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

function requiredString(item, field, label) {
  const value = item[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(item, field, label) {
  const value = item[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label}.${field} must be a string`);
  return value;
}

function candidText(value) {
  // Candid text strings accept the same escapes used here. Keeping Unicode
  // characters literal makes catalog descriptions readable in dry-run logs.
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function candidBlob(bytes) {
  return `blob "${Buffer.from(bytes)
    .toString("hex")
    .match(/../g)
    .map((pair) => `\\${pair}`)
    .join("")}"`;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest();
}

function resolveReadableFile(catalogDir, file, label) {
  const resolved = path.resolve(catalogDir, requiredString({ file }, "file", label));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} does not exist or is not a file: ${resolved}`);
  return resolved;
}

function prepareCatalog(raw, catalogDir) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("catalog root must be a JSON object");
  }
  const templates = raw.templates ?? [];
  const packages = raw.packages ?? [];
  if (!Array.isArray(templates)) throw new Error("catalog.templates must be an array");
  if (!Array.isArray(packages)) throw new Error("catalog.packages must be an array");

  const prepareCommon = (item, label) => ({
    title: requiredString(item, item.package_name ? "package_name" : "title", label),
    description: requiredString(item, "description", label),
    webUrl: optionalString(item, "web_url", label),
    gitRepoUrl: requiredString(item, "git_repo_url", label),
    downloadUrl: requiredString(item, "download_url", label),
    releaseTag: requiredString(item, "release_tag", label),
    packageSlug: requiredString(item, "package_slug", label),
  });

  const prepared = {
    templates: templates.map((item, index) => {
      const label = `templates[${index}]`;
      const common = prepareCommon(item, label);
      const manifestFile = resolveReadableFile(
        catalogDir,
        requiredString(item, "manifest_file", label),
        `${label}.manifest_file`,
      );
      return { ...common, manifestFile, manifestHash: sha256File(manifestFile) };
    }),
    packages: packages.map((item, index) => {
      const label = `packages[${index}]`;
      const packageName = requiredString(item, "package_name", label);
      if (/\.[a-z0-9]{1,8}$/i.test(packageName)) {
        throw new Error(`${label}.package_name must be a display name without a file extension`);
      }
      const common = prepareCommon(item, label);
      if (item.price_e8s !== undefined && item.price_e8s !== null) {
        throw new Error(
          `${label}.price_e8s is not supported here; use publish_to_marketplace.js for paid/encrypted packages`,
        );
      }
      const wasmFile = resolveReadableFile(
        catalogDir,
        requiredString(item, "wasm_file", label),
        `${label}.wasm_file`,
      );
      return { ...common, wasmFile, wasmHash: sha256File(wasmFile) };
    }),
  };

  const identities = new Set();
  for (const item of [...prepared.templates, ...prepared.packages]) {
    const identity = `${item.gitRepoUrl.toLowerCase()}\0${item.packageSlug}`;
    if (identities.has(identity)) {
      throw new Error(
        `duplicate marketplace repository/package slug in catalog: ${item.gitRepoUrl} / ${item.packageSlug}`,
      );
    }
    identities.add(identity);
  }
  return prepared;
}

function callArgs(options, method, argsFile) {
  const args = [
    "canister",
    "call",
    options.backend,
    method,
    "--args-file",
    argsFile,
    "--args-format",
    "candid",
    "--candid",
    backendDid,
    "--json",
    "-e",
    options.environment,
  ];
  if (options.identity) args.push("--identity", options.identity);
  return args;
}

function runCall(options, method, candidArgs, tempDir) {
  if (options.dryRun) {
    console.log(`[dry-run] ${method} ${candidArgs}`);
    return null;
  }
  const argsFile = path.join(tempDir, `${method}-${crypto.randomUUID()}.did`);
  fs.writeFileSync(argsFile, candidArgs, { mode: 0o600 });
  const stdout = execFileSync("icp", callArgs(options, method, argsFile), {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const envelope = JSON.parse(stdout);
  const response = envelope.response_candid ?? envelope.response_text ?? stdout.trim();
  if (/variant\s*\{\s*Err\s*=/.test(response)) {
    throw new Error(`${method} failed: ${response}`);
  }
  return response;
}

function identityPrincipal(options) {
  const args = ["identity", "principal"];
  if (options.identity) args.push("--identity", options.identity);
  return execFileSync("icp", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function templateArgs(item) {
  return `(record {
    title = ${candidText(item.title)};
    description = ${candidText(item.description)};
    web_url = ${item.webUrl ? `opt ${candidText(item.webUrl)}` : "null"};
    git_repo_url = ${candidText(item.gitRepoUrl)};
    download_url = ${candidText(item.downloadUrl)};
    release_tag = ${candidText(item.releaseTag)};
    package_slug = ${candidText(item.packageSlug)};
    manifest_hash = ${candidBlob(item.manifestHash)};
  })`;
}

function registerRepoArgs(repoUrl, principal) {
  return `(${candidText(repoUrl)}, principal ${candidText(principal)})`;
}

function packageArgs(item) {
  return `(
    variant { Package },
    ${item.webUrl ? `opt ${candidText(item.webUrl)}` : "null"},
    ${candidText(item.gitRepoUrl)},
    ${candidText(item.title)},
    ${candidText(item.description)},
    ${candidText(item.downloadUrl)},
    ${candidText(item.releaseTag)},
    null,
    null,
    ${candidText(item.packageSlug)},
    ${candidBlob(item.wasmHash)}
  )`;
}

function itemId(response) {
  return response?.match(/Ok\s*=\s*([0-9_]+)/)?.[1]?.replaceAll("_", "") ?? "unknown";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.file) throw new Error("--file is required");
  if (!fs.existsSync(backendDid)) throw new Error(`backend Candid file not found: ${backendDid}`);

  const catalogFile = path.resolve(process.cwd(), options.file);
  const catalogDir = path.dirname(catalogFile);
  const raw = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const catalog = prepareCatalog(raw, catalogDir);
  console.log(
    `Validated ${catalog.templates.length} template(s) and ${catalog.packages.length} package(s) from ${catalogFile}`,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canister-hub-catalog-"));
  try {
    for (const template of catalog.templates) {
      const response = runCall(options, "add_marketplace_template", templateArgs(template), tempDir);
      console.log(`${options.dryRun ? "Would upload" : "Uploaded"} template ${template.packageSlug} (#${itemId(response)})`);
    }

    if (catalog.packages.length > 0) {
      const principal = options.dryRun
        ? options.identity
          ? `<principal for ${options.identity}>`
          : "<current identity principal>"
        : identityPrincipal(options);
      const registered = new Set();
      for (const pkg of catalog.packages) {
        const repoKey = pkg.gitRepoUrl.toLowerCase();
        if (!registered.has(repoKey)) {
          runCall(options, "register_repo_publisher", registerRepoArgs(pkg.gitRepoUrl, principal), tempDir);
          registered.add(repoKey);
        }
        const response = runCall(options, "publish_marketplace_item", packageArgs(pkg), tempDir);
        console.log(`${options.dryRun ? "Would upload" : "Uploaded"} package ${pkg.packageSlug} (#${itemId(response)})`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
