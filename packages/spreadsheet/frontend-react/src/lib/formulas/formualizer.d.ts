// Formualizer ships a wasm-bindgen "bundler" build whose entry statically
// imports the .wasm file. IntelliSheet instantiates the wasm itself (see
// formula-engine.ts), so it imports the JS glue module directly.
declare module 'formualizer/pkg/formualizer_wasm_bg.js' {
	export * from 'formualizer/pkg/formualizer_wasm.js';
	export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
