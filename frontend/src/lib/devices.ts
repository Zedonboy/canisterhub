// Co-owner devices: extra principals (e.g. the same person's other Internet
// Identity) authorised to act as the owner. `backend` records the
// authorisation (`add_device`/`remove_device`, owner-only); this file makes
// the matching controller change on every canister the owner's projects
// track, using the signed-in identity's own management-canister
// `update_settings` - the backend is not a controller of those canisters, the
// owner is. Like every other management call in this dashboard it works on
// mainnet but is rejected by this project's local gateway (see
// `lib/candid/management.ts`).

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { getBackendActor } from "./actors";
import { listMyProjects } from "./backend";
import { readPublicInfo } from "./canisterStats";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";

export interface DeviceInfo {
  principal: string;
  label: string;
  addedAt: string;
}

export interface ControllerSyncResult {
  projectId: string;
  canisterName: string;
  canisterId: string;
  network: string;
  /** True when the canister now has the intended controller set. */
  ok: boolean;
  /** True when `update_settings` actually had to run. */
  changed: boolean;
  error?: string;
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const actor = await getBackendActor();
  const devices = await actor.list_devices();
  return devices.map((d) => ({
    principal: d.principal.toText(),
    label: d.label,
    addedAt: new Date(Number(d.added_at / 1_000_000n)).toISOString(),
  }));
}

/** The principal the signed-in identity acts as: its owner when it is a device. */
export async function myOwner(): Promise<string> {
  const actor = await getBackendActor();
  return (await actor.my_owner()).toText();
}

/** Registers the device on `backend` only; pair with `syncDeviceControllers`. */
export async function registerDevice(principal: string, label: string): Promise<void> {
  const actor = await getBackendActor();
  const result = await actor.add_device(Principal.fromText(principal.trim()), label.trim());
  if ("Err" in result) throw new Error(result.Err);
}

/** Deregisters the device on `backend` only; pair with `syncDeviceControllers`. */
export async function deregisterDevice(principal: string): Promise<void> {
  const actor = await getBackendActor();
  const result = await actor.remove_device(Principal.fromText(principal));
  if ("Err" in result) throw new Error(result.Err);
}

/** Owner plus every device, de-duplicated, with `self` always included. Used
 * as the user-side controller set for newly deployed canisters so a canister
 * deployed from one device stays controllable from the others. Falls back to
 * just `self` if `backend` can't be reached. */
export async function coOwnerPrincipals(self: Principal): Promise<Principal[]> {
  const ids = new Set<string>([self.toText()]);
  try {
    const actor = await getBackendActor();
    ids.add((await actor.my_owner()).toText());
    for (const device of await actor.list_devices()) ids.add(device.principal.toText());
  } catch {
    // keep self only - a deploy must not fail because the device list is unreadable
  }
  return [...ids].map((id) => Principal.fromText(id));
}

async function managementActor(network: string, target: Principal): Promise<ManagementService> {
  const agent = await getAgent(network);
  return Actor.createActor<ManagementService>(managementIdlFactory, {
    agent,
    canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
    effectiveCanisterId: target,
  });
}

/** Adds or removes `device` as a controller of every distinct canister across
 * all of the owner's projects. `update_settings` replaces the whole controller
 * list, so each canister's current list is read first and only edited; a
 * canister whose list can't be read (empty result) is skipped rather than
 * risk overwriting it. Never removes `self` (the signed-in identity). One
 * canister's failure does not stop the rest. */
export async function syncDeviceControllers(device: string, mode: "add" | "remove", self: string): Promise<ControllerSyncResult[]> {
  if (mode === "remove" && device === self) throw new Error("You cannot remove your own principal as a controller.");
  const projects = await listMyProjects();
  const seen = new Set<string>();
  const results: ControllerSyncResult[] = [];

  for (const project of projects) {
    for (const [canisterName, info] of Object.entries(project.canisters)) {
      const key = `${project.network}:${info.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = { projectId: project.id, canisterName, canisterId: info.id, network: project.network };
      try {
        const target = Principal.fromText(info.id);
        const { controllers } = await readPublicInfo(target, project.network);
        if (controllers.length === 0) throw new Error("could not read this canister's current controllers");
        const present = controllers.includes(device);
        if ((mode === "add" && present) || (mode === "remove" && !present)) {
          results.push({ ...base, ok: true, changed: false });
          continue;
        }
        const next = mode === "add" ? [...controllers, device] : controllers.filter((c) => c !== device);
        if (!next.includes(self)) throw new Error("refusing to change controllers: the signed-in principal is not currently a controller");
        const actor = await managementActor(project.network, target);
        await actor.update_settings({
          canister_id: target,
          settings: { controllers: [next.map((c) => Principal.fromText(c))], log_visibility: [] },
          sender_canister_version: [],
        });
        results.push({ ...base, ok: true, changed: true });
      } catch (e) {
        results.push({ ...base, ok: false, changed: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return results;
}
