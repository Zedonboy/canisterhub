import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { icpBindgen } from '@icp-sdk/bindgen/plugins/vite';
import { defineConfig, type ProxyOptions } from 'vite';
import { icpDevEnv } from './src/lib/server/icp-dev-env.ts';
import { icpDevCookiePlugin } from './src/dev/icp-dev-cookie-plugin.ts';

/**
 * Proxies the agent's relative `/api/*` calls to the local replica — the dev
 * equivalent of the boundary node that fronts a deployed asset canister.
 * (Ported from the SvelteKit app's vite.config.ts; the `ic_env` cookie side
 * of this is set by `icpDevCookiePlugin` instead of `hooks.server.ts`.)
 */
function icpDevProxy(): Record<string, string | ProxyOptions> | undefined {
	const env = icpDevEnv();
	if (!env) {
		console.warn(
			'[icp] Local network or "icp_backend" canister not found — ICP-backed sheets won\'t be reachable in dev.\n' +
				'      Run `icp network start -d && icp deploy icp_backend` to enable them.'
		);
		return undefined;
	}
	return { '/api': { target: env.apiUrl, changeOrigin: true } };
}

export default defineConfig(({ command }) => ({
	plugins: [
		tailwindcss(),
		react(),
		icpDevCookiePlugin(),
		icpBindgen({ didFile: '../icp_backend/icp_backend.did', outDir: './src/bindings' })
	],
	// Expose PUBLIC_API_URL via import.meta.env (works whether or not .env exists).
	envPrefix: ['VITE_', 'PUBLIC_'],
	resolve: {
		alias: {
			'@': path.resolve(import.meta.dirname, './src')
		}
	},
	server: {
		// Keep the React migration build alongside the Svelte app on 5180.
		port: 5181,
		strictPort: true,
		// Only during `vite dev`, never for `vite build` (which must not shell out to `icp`).
		proxy: command === 'serve' ? icpDevProxy() : undefined
	},
	preview: {
		port: 4181,
		strictPort: true
	},
	optimizeDeps: {
		// Formualizer ships a wasm-bindgen bundle; we instantiate the .wasm ourselves.
		exclude: ['formualizer']
	}
}));
