#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  npm run seed-marketplace -- --file ./package-seed.json [options]

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

function templateText(value) {
  return text(value);
}

function githubReleaseUrl(gitRepoUrl, releaseTag, packageSlug) {
  const repo = new URL(gitRepoUrl);
  if (repo.protocol !== "https:" || repo.hostname !== "github.com" || repo.search || repo.hash) {
    throw new Error(`${packageSlug}.git_repo_url must be a GitHub HTTPS URL`);
  }
  const repoPath = repo.pathname.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) {
    throw new Error(`${packageSlug}.git_repo_url must point to an owner/repository`);
  }
  return `https://github.com/${repoPath}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(`${packageSlug}.canister_hub.toml`)}`;
}

async function templatesFrom(seed, filePath) {
  const entries = seed?.templates ?? [];
  if (!Array.isArray(entries)) throw new Error("templates must be an array");
  const defaultReleaseTag = seed.version;
  const packageBase = seed.packages?.[0]?.download_url;
  const baseUrl = packageBase ? new URL(packageBase).origin : null;
  const result = [];

  for (const [index, entry] of entries.entries()) {
    const label = `templates[${index}]`;
    for (const field of ["title", "description", "git_repo_url", "package_slug"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${label}.${field} must be a non-empty string`);
      }
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.package_slug)) {
      throw new Error(`${label}.package_slug is invalid`);
    }
    const releaseTag = entry.release_tag ?? defaultReleaseTag;
    if (typeof releaseTag !== "string" || !/^[A-Za-z0-9._-]+$/.test(releaseTag)) {
      throw new Error(`${label}.release_tag is invalid`);
    }

    let manifestHash = entry.manifest_sha ?? entry.manifest_hash;
    if (typeof manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(manifestHash)) {
      if (!entry.manifest_file) {
        throw new Error(`${label}.manifest_sha must be lowercase SHA-256 hex (or provide manifest_file)`);
      }
      let manifest = await readFile(path.resolve(path.dirname(filePath), entry.manifest_file), "utf8");
      if (baseUrl) {
        let replacements = 0;
        manifest = manifest.replace(
          /^(\s*url\s*=\s*)"https:\/\/[^\s"]+\/([^/"#]+\.wasm)"(\s*(?:#.*)?)$/gm,
          (_match, prefix, filename, suffix) => {
            replacements += 1;
            return `${prefix}"${baseUrl}/${encodeURIComponent(defaultReleaseTag)}/${encodeURIComponent(filename)}"${suffix}`;
          },
        );
        if (!replacements) throw new Error(`${label}.manifest_file has no HTTPS package Wasm URLs`);
      }
      manifestHash = createHash("sha256").update(manifest).digest("hex");
    }
    const releaseUrl = entry.github_release_url ?? githubReleaseUrl(entry.git_repo_url, releaseTag, entry.package_slug);
    const bytes = Buffer.from(manifestHash, "hex");
    result.push({
      title: entry.title,
      packageSlug: entry.package_slug,
      candid: `(record {
        title = ${templateText(entry.title)};
        description = ${templateText(entry.description)};
        web_url = ${entry.web_url ? `opt ${templateText(entry.web_url)}` : "null"};
        git_repo_url = ${templateText(entry.git_repo_url)};
        download_url = ${templateText(releaseUrl)};
        release_tag = ${templateText(releaseTag)};
        package_slug = ${templateText(entry.package_slug)};
        manifest_hash = vec { ${[...bytes].join("; ")} };
      })`,
    });
  }
  return result;
}

function candidError(response) {
  const match = response.match(/variant\s*\{\s*Err\s*=\s*"((?:\\.|[^"\\])*)"/);
  return match ? JSON.parse(`"${match[1]}"`) : null;
}

function callCanister(options, method, candid, tempDir, index) {
  const argsFile = path.join(tempDir, `seed-${index}.did`);
  writeFileSync(argsFile, candid, { mode: 0o600 });
  const args = [
    "canister", "call", options.backend, method,
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
  const error = candidError(response);
  if (error) throw new Error(`${method} failed: ${error}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (!options.file) throw new Error("--file is required");

  const filePath = path.resolve(options.file);
  const seed = JSON.parse(await readFile(filePath, "utf8"));
  const packages = packagesFrom(seed);
  const templates = await templatesFrom(seed, filePath);
  if (options.dryRun) {
    console.log(`Validated ${packages.length} package(s) and ${templates.length} template(s).`);
    console.log(`Package Candid: ${candidArgs(packages)}`);
    for (const template of templates) console.log(`Template ${template.title} (${template.packageSlug}): ${template.candid}`);
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "canister-hub-seed-marketplace-"));
  try {
    callCanister(options, "upload_package_infos", candidArgs(packages), tempDir, 0);
    console.log(`Seeded ${packages.length} package(s) into ${options.backend}; package ids were assigned by the backend.`);
    for (let index = 0; index < templates.length; index += 1) {
      const template = templates[index];
      callCanister(options, "add_marketplace_template", template.candid, tempDir, index + 1);
      console.log(`Seeded template '${template.title}' (${template.packageSlug}) into ${options.backend}.`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
