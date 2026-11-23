#!/usr/bin/env node

// Downloads `package-seed.json` from a GitHub release and seeds the backend
// with it through seed_package_infos.js. The download goes to a temp
// directory - never over the checked-in scripts/package-seed.json, which is
// the release workflow's input.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ASSET_NAME = "package-seed.json";
const DEFAULT_REPO = "Zedonboy/canisterhub";

function usage() {
  console.log(`Usage:
  npm run seed-latest -- [options]

Options:
  -r, --repo <owner/name>    GitHub repository (default: ${DEFAULT_REPO})
  -t, --tag <tag>            Release tag (default: the latest release)
  -e, --environment <name>   ICP environment (default: local)
  -i, --identity <name>      Controller identity (default: current identity)
  -b, --backend <target>     Backend name or principal (default: backend)
      --dry-run              Validate and print Candid without changing state
  -h, --help                 Show this help

Set GITHUB_TOKEN to avoid API rate limits or to read a private repository.`);
}

function parseArgs(argv) {
  const options = { repo: DEFAULT_REPO, tag: null, passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "-r" || arg === "--repo") options.repo = next();
    else if (arg === "-t" || arg === "--tag") options.tag = next();
    else if (arg === "-e" || arg === "--environment") options.passthrough.push("--environment", next());
    else if (arg === "-i" || arg === "--identity") options.passthrough.push("--identity", next());
    else if (arg === "-b" || arg === "--backend") options.passthrough.push("--backend", next());
    else if (arg === "--dry-run") options.passthrough.push("--dry-run");
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
    throw new Error("--repo must look like owner/name");
  }
  if (options.tag !== null && !/^[A-Za-z0-9._-]+$/.test(options.tag)) {
    throw new Error("--tag may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return options;
}

function headers(accept) {
  const h = { Accept: accept, "User-Agent": "canister-hub-seed-latest" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();

  const releaseUrl = options.tag
    ? `https://api.github.com/repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`
    : `https://api.github.com/repos/${options.repo}/releases/latest`;
  const releaseResponse = await fetch(releaseUrl, { headers: headers("application/vnd.github+json") });
  if (!releaseResponse.ok) {
    throw new Error(`could not read release (${releaseResponse.status}) from ${releaseUrl}`);
  }
  const release = await releaseResponse.json();
  const asset = release.assets?.find((a) => a.name === ASSET_NAME);
  if (!asset) throw new Error(`release ${release.tag_name} has no ${ASSET_NAME} asset`);

  // The asset API URL works for public and private repos alike.
  const assetResponse = await fetch(asset.url, { headers: headers("application/octet-stream") });
  if (!assetResponse.ok) throw new Error(`could not download ${ASSET_NAME} (${assetResponse.status})`);
  const body = await assetResponse.text();
  const seed = JSON.parse(body);
  if (seed.version !== release.tag_name) {
    throw new Error(`seed version ${seed.version} does not match release ${release.tag_name}`);
  }
  console.log(
    `Release ${release.tag_name}: ${seed.packages?.length ?? 0} package(s), ${seed.templates?.length ?? 0} template(s)`,
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "seed-latest-"));
  try {
    const file = path.join(dir, ASSET_NAME);
    await writeFile(file, body);
    execFileSync(
      process.execPath,
      [path.join(scriptDir, "seed_package_infos.js"), "--file", file, ...options.passthrough],
      { stdio: "inherit" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
