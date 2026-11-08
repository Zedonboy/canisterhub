// Real, direct-from-the-browser marketplace-item deploy - "the frontend
// downloads the wasm from url, using the auth identity it deploys it to
// local/mainnet... user id and orchestrator id becomes controllers" (the
// user's own framing). No orchestrator HTTP call anywhere in this file -
// creating a canister, installing code, and setting controllers are all
// real IC management-canister calls made with the signed-in user's own
// identity, the same way `lib/canisterOps.ts` already does for
// stop/start/delete.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";
import { fetchMarketplaceWasm } from "./vetkeyDecrypt";
import { fetchVerifiedPackageWasm, type PackageInfo } from "./packageRegistry";
import { purchaseMarketplaceAccess, recordDownload } from "./marketplace";
import { addProjectCanisters, getProject, type CanisterKind } from "./backend";
import type { MarketplaceItem } from "../bindings/backend";
import { runtimeValue } from "./canisterEnv";
import { getModuleConfigSchema, setModuleConfig } from "./moduleConfig";
import { findPackageInfoForRelease, packageShaHex, projectPackageCanistersByName, recordProjectPackageInstallation } from "./packageRegistry";
import { encodeProjectContext } from "./candid/agentInit";
import { createAndInstallCanisterFromWasm } from "./runtime";

async function managementActor(network: string): Promise<ManagementService> {
  const agent = await getAgent(network);
  return Actor.createActor<ManagementService>(managementIdlFactory, { agent, canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID) });
}

/** `None` if unset - a controller-set with only the real user is still a
 * genuine, valid deploy, just without the orchestrator able to manage this
 * canister later on the user's behalf. */
function orchestratorPrincipal(): Principal | null {
  const text = runtimeValue("ORCHESTRATOR_PRINCIPAL");
  return text ? Principal.fromText(text) : null;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "item";
}

export interface DeployedCanister {
  name: string;
  id: string;
}

/** Deploys one real marketplace item directly from the browser:
 * download (+ real vetKD decrypt if gated - see `lib/vetkeyDecrypt.ts`),
 * create a canister (with `log_visibility: controllers` so the Logs
 * page's `fetch_canister_logs` tail works for its controllers), install
 * the code, set controllers to
 * `[user, orchestrator]`, and record the result on the project (as the
 * project's own owner - see `lib/backend.ts::addProjectCanisters`).
 *
 * `network === "local"` uses `provisional_create_canister_with_cycles`
 * (free, no funding needed - the same thing `icp deploy` itself relies on
 * locally). `network === "ic"` calls the real, standard `create_canister`
 * with no special workaround: a bare Internet Identity principal has no
 * way to attach cycles to that call today (no wallet/Cycles Ledger
 * integration exists anywhere in this codebase yet), so on real mainnet
 * this will surface a real, honest IC funding error rather than a
 * fabricated one - a known, disclosed gap, not something this function
 * silently works around. */
export async function deployMarketplaceItem(item: MarketplaceItem, network: string, projectId: string, userPrincipal: Principal): Promise<DeployedCanister> {
  // For a paid item this approves ICP, lets the backend pull payment with
  // ICRC-2 transfer_from, and grants the caller vetkey Read access. It is
  // idempotent, so a retry after a later deployment failure is not charged
  // again. Free items return immediately.
  await purchaseMarketplaceAccess(item);
  const wasm = await fetchMarketplaceWasm(item);
  const packageInfo = await findPackageInfoForRelease({
    sha: packageShaHex(item.wasm_hash),
    title: item.package_slug,
  });
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} was not found`);
  const initArg = encodeProjectContext({
    projectId,
    packageCanisters: await projectPackageCanistersByName(project),
  });
  const actor = await managementActor(network);

  const { canister_id: canisterId } =
    network === "local"
      ? await actor.provisional_create_canister_with_cycles({
          amount: [],
          settings: [{ controllers: [], log_visibility: [{ controllers: null }] }],
          specified_id: [],
          sender_canister_version: [],
        })
      : await actor.create_canister({
          settings: [{ controllers: [], log_visibility: [{ controllers: null }] }],
          sender_canister_version: [],
        });

  await actor.install_code({
    mode: { install: null },
    canister_id: canisterId,
    wasm_module: wasm,
    arg: initArg,
    sender_canister_version: [],
  });

  const orchestrator = orchestratorPrincipal();
  const controllers = orchestrator ? [userPrincipal, orchestrator] : [userPrincipal];
  await actor.update_settings({
    canister_id: canisterId,
    settings: { controllers: [controllers], log_visibility: [{ controllers: null }] },
    sender_canister_version: [],
  });

  // Packages use this registry key when calling project-scoped protocol APIs.
  // It is platform-owned deployment context, not something the SME should
  // have to copy into every package manually.
  try {
    const schema = await getModuleConfigSchema(canisterId.toText(), network);
    if (schema.some((field) => field.key === "project_id")) {
      await setModuleConfig(canisterId.toText(), network, {
        project_id: { Text: projectId },
      });
    }
  } catch {
    // Packages without the dynamic-config protocol remain installable.
  }

  // A short suffix of the canister's own (globally unique) id keeps this
  // name collision-free within the project without needing to know its
  // other canister names ahead of time.
  const name = `${slugify(item.title)}-${canisterId.toText().slice(0, 5)}`;
  const kind: CanisterKind = "other";
  await addProjectCanisters(projectId, [[name, {
    id: canisterId.toText(),
    kind,
    packageName: packageInfo?.name ?? null,
  }]]);
  // Official packages have a stable package id in the release registry. Save
  // the backend's own current version/SHA snapshot only after installation and
  // project tracking have both succeeded. Third-party marketplace packages
  // without a registry entry continue to install normally.
  if (packageInfo) {
    await recordProjectPackageInstallation(projectId, name, packageInfo.name);
  }
  await recordDownload(item.id);

  return { name, id: canisterId.toText() };
}

/** Deploys a free official package directly from the backend package-info
 * registry. The registry URL and SHA are the source of truth for this flow;
 * it does not consult MarketplaceItem download URLs. */
export async function deployPackageInfo(pkg: PackageInfo, network: string, projectId: string, userPrincipal: Principal): Promise<DeployedCanister> {
  const wasm = await fetchVerifiedPackageWasm(pkg);
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} was not found`);
  const initArg = encodeProjectContext({
    projectId,
    packageCanisters: await projectPackageCanistersByName(project),
  });
  const orchestrator = orchestratorPrincipal();
  const controllers = orchestrator ? [userPrincipal, orchestrator] : [userPrincipal];
  const canisterId = await createAndInstallCanisterFromWasm(network, wasm, controllers, initArg);

  try {
    const schema = await getModuleConfigSchema(canisterId.toText(), network);
    if (schema.some((field) => field.key === "project_id")) {
      await setModuleConfig(canisterId.toText(), network, { project_id: { Text: projectId } });
    }
  } catch {
    // Packages without dynamic project configuration remain installable.
  }

  const packageTitle = pkg.name.replace(/\.wasm$/i, "").replaceAll("_", " ");
  const name = `${slugify(packageTitle)}-${canisterId.toText().slice(0, 5)}`;
  await addProjectCanisters(projectId, [[name, {
    id: canisterId.toText(),
    kind: "other" as CanisterKind,
    packageName: pkg.name,
  }]]);
  await recordProjectPackageInstallation(projectId, name, pkg.name);
  return { name, id: canisterId.toText() };
}
