#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--version", "--base-url", "--wasm-dir", "--output", "--template-dir"].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }
  for (const key of ["version", "base_url", "wasm_dir", "output", "template_dir"]) {
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
  options.template_dir = path.resolve(projectRoot, options.template_dir);
  return options;
}

function renderTemplateManifest(source, baseUrl, version, label) {
  let replacements = 0;
  const rendered = source.replace(
    /^(\s*url\s*=\s*)"https:\/\/[^\s"]+\/([^/"#]+\.wasm)"(\s*(?:#.*)?)$/gm,
    (_match, prefix, filename, suffix) => {
      replacements += 1;
      return `${prefix}"${baseUrl}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}"${suffix}`;
    },
  );
  if (replacements === 0) {
    throw new Error(`${label} has no HTTPS package Wasm URLs to rewrite for this release`);
  }
  return rendered;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const seed = JSON.parse(
    await readFile(path.join(scriptDir, "package-seed.json"), "utf8"),
  );
  const packageDefinitions = Array.isArray(seed) ? seed : seed.packages;
  const templateDefinitions = Array.isArray(seed) ? [] : seed.templates ?? [];
  if (!Array.isArray(packageDefinitions) || packageDefinitions.length === 0) {
    throw new Error("package-seed.json must contain a non-empty packages array");
  }
  const records = [];
  for (const entry of packageDefinitions) {
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

  await mkdir(options.template_dir, { recursive: true });
  const templates = [];
  for (const entry of templateDefinitions) {
    for (const field of ["title", "description", "git_repo_url", "package_slug", "manifest_file"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`template ${entry.package_slug ?? "<unknown>"}.${field} must be a non-empty string`);
      }
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.package_slug)) {
      throw new Error(`template has an invalid package_slug: ${entry.package_slug}`);
    }
    const repositoryUrl = new URL(entry.git_repo_url);
    if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com" || repositoryUrl.search || repositoryUrl.hash) {
      throw new Error(`template ${entry.package_slug}.git_repo_url must be a GitHub HTTPS URL`);
    }
    const repositoryPath = repositoryUrl.pathname.replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryPath)) {
      throw new Error(`template ${entry.package_slug}.git_repo_url must point to an owner/repository`);
    }
    const sourcePath = path.resolve(scriptDir, entry.manifest_file);
    const source = await readFile(sourcePath, "utf8");
    const rendered = renderTemplateManifest(source, options.base_url, options.version, sourcePath);
    const filename = `${entry.package_slug}.canister_hub.toml`;
    const outputPath = path.join(options.template_dir, filename);
    await writeFile(outputPath, rendered);
    templates.push({
      title: entry.title,
      description: entry.description,
      git_repo_url: repositoryUrl.href.replace(/\/$/, ""),
      download_url: `${options.base_url}/${encodeURIComponent(options.version)}/${encodeURIComponent(filename)}`,
      release_tag: options.version,
      package_slug: entry.package_slug,
      manifest_sha: createHash("sha256").update(rendered).digest("hex"),
      github_release_url: `https://github.com/${repositoryPath}/releases/download/${encodeURIComponent(options.version)}/${encodeURIComponent(filename)}`,
    });
  }

  const output = {
    schema_version: 1,
    version: options.version,
    packages: records,
    templates,
  };
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${records.length} package and ${templates.length} template records to ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
