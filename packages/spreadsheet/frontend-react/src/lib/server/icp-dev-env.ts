import { execSync } from 'node:child_process';

export interface IcpDevEnv {
	apiUrl: string;
	rootKey: string;
	canisterId: string;
}

/**
 * Looks up the local ICP replica's API URL/root key and the `icp_backend`
 * canister's id via the `icp` CLI — the local-dev equivalent of what the
 * deployed asset canister already does for production (see
 * `hooks.server.ts` and `vite.config.ts`, the only two callers).
 *
 * Never throws: returns `null` when the `icp` CLI is missing, the local
 * network isn't running, or the canister hasn't been deployed yet.
 * IntelliSheet has two other storage backends (Local, Server) that work
 * with none of this, so a missing ICP toolchain should never break `npm run
 * dev` — ICP-backed sheets are simply unreachable until you run
 * `icp network start -d && icp deploy icp_backend`.
 */
export function icpDevEnv(canisterName = 'icp_backend'): IcpDevEnv | null {
	const environment = process.env.ICP_ENVIRONMENT || 'local';
	try {
		const status = JSON.parse(
			execSync(`icp network status -e ${environment} --json`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
		) as { root_key: string; api_url: string };
		const canisterId = execSync(`icp canister status ${canisterName} -e ${environment} -i`, {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		return { apiUrl: status.api_url, rootKey: status.root_key, canisterId };
	} catch {
		return null;
	}
}
