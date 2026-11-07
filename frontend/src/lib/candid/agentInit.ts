import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";

export interface AgentProjectContext {
  projectId: string;
  packageCanisters: Record<string, string[]>;
}

const ProjectCanister = IDL.Record({
  canister_id: IDL.Principal,
  package_name: IDL.Text,
});
const ProjectContext = IDL.Record({
  project_id: IDL.Text,
  canisters: IDL.Vec(ProjectCanister),
});

function projectContextValue(context: AgentProjectContext) {
  return {
    project_id: context.projectId,
    canisters: Object.entries(context.packageCanisters).flatMap(([packageName, ids]) =>
      ids.map((id) => ({ package_name: packageName, canister_id: Principal.fromText(id) })),
    ),
  };
}

/** The one standard install argument for every CanisterHub package. */
export function encodeProjectContext(context: AgentProjectContext): Uint8Array {
  return new Uint8Array(IDL.encode(
    [ProjectContext],
    [projectContextValue(context)],
  ));
}

// Compatibility name for code outside this repository that imported the old
// agent-specific encoder. Its wire format is now the universal contract.
export const encodeAgentInit = encodeProjectContext;
