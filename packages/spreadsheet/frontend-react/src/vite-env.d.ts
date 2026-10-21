/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Base URL of the Rust API, used only when the user picks "Server" in the sidebar. */
	readonly PUBLIC_API_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
