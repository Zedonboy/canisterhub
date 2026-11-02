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
import { purchaseMarketplaceAccess, recordDownload } from "./marketplace";
import { addProjectCanisters, getProject, type CanisterKind } from "./backend";
import type { MarketplaceItem } from "../bindings/backend";
import { runtimeValue } from "./canisterEnv";
import { backendCanisterId } from "./actors";
import { getModuleConfigSchema, setModuleConfig } from "./moduleConfig";

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

function isNotificationPackage(packageSlug: string): boolean {
  return packageSlug.toLowerCase().trim().replaceAll("-", "_") === "notification";
}

async function ensureNotificationSlotIsAvailable(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} was not found`);
  if (Object.values(project.canisters).some((info) => info.kind === "notification")) {
    throw new Error("This project already has a notification canister. Share it with the new module instead of deploying another one.");
  }
}

export interface DeployedCanister {
  name: string;
  id: string;
}

/** Deploys one real marketplace item directly from the browser:
 * download (+ real vetKD decrypt if gated - see `lib/vetkeyDecrypt.ts`),
 * create a canister, install the code, set controllers to
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
  const notification = isNotificationPackage(item.package_slug);
  if (notification) await ensureNotificationSlotIsAvailable(projectId);
  // For a paid item this approves ICP, lets the backend pull payment with
  // ICRC-2 transfer_from, and grants the caller vetkey Read access. It is
  // idempotent, so a retry after a later deployment failure is not charged
  // again. Free items return immediately.
  await purchaseMarketplaceAccess(item);
  const wasm = await fetchMarketplaceWasm(item);
  const actor = await managementActor(network);

  const { canister_id: canisterId } =
    network === "local"
      ? await actor.provisional_create_canister_with_cycles({ amount: [], settings: [], specified_id: [], sender_canister_version: [] })
      : await actor.create_canister({ settings: [], sender_canister_version: [] });

  await actor.install_code({
    mode: { install: null },
    canister_id: canisterId,
    wasm_module: wasm,
    // Valid Candid encoding of the empty argument tuple `()`.
    arg: new Uint8Array([68, 73, 68, 76, 0, 0]),
    sender_canister_version: [],
  });

  const orchestrator = orchestratorPrincipal();
  const controllers = orchestrator ? [userPrincipal, orchestrator] : [userPrincipal];
  await actor.update_settings({ canister_id: canisterId, settings: { controllers: [controllers] }, sender_canister_version: [] });

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

  // Project packages send owner notifications through the backend, which
  // verifies project membership before forwarding to this canister. Trusting
  // only that backend here keeps arbitrary project canisters from bypassing
  // the project-scoped authorization gateway and selecting another recipient.
  if (notification) {
    await setModuleConfig(canisterId.toText(), network, {
      trusted_senders: { Vector: [{ PrincipalId: backendCanisterId() }] },
    });
  }

  // A short suffix of the canister's own (globally unique) id keeps this
  // name collision-free within the project without needing to know its
  // other canister names ahead of time.
  const name = notification ? "notification" : `${slugify(item.title)}-${canisterId.toText().slice(0, 5)}`;
  const kind: CanisterKind = notification ? "notification" : "other";
  await addProjectCanisters(projectId, [[name, { id: canisterId.toText(), kind }]]);
  await recordDownload(item.id);

  return { name, id: canisterId.toText() };
}
