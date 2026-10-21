import type { Plugin } from 'vite';
import { icpDevEnv } from '../lib/server/icp-dev-env.ts';

/**
 * Dev-only: sets the same `ic_env` cookie the deployed asset canister sets
 * in production, so `getCanisterEnv()` (see `lib/api/icp.ts`) works
 * identically either way. Computed once at server startup (mirrors the
 * SvelteKit app's `hooks.server.ts`, which did the same thing because
 * `vite.config.ts`'s `server.headers` doesn't reach per-request responses).
 */
function buildDevCookie(): string | null {
	const env = icpDevEnv();
	if (!env) return null;
	const value = `PUBLIC_CANISTER_ID:icp_backend=${env.canisterId}&ic_root_key=${env.rootKey}`;
	return `ic_env=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
}

/** Vite dev-server middleware replacing the SvelteKit app's `hooks.server.ts`. */
export function icpDevCookiePlugin(): Plugin {
	return {
		name: 'icp-dev-cookie',
		apply: 'serve',
		configureServer(server) {
			const devCookie = buildDevCookie();
			if (!devCookie) return;
			server.middlewares.use((_req, res, next) => {
				res.appendHeader('set-cookie', devCookie);
				next();
			});
		}
	};
}
