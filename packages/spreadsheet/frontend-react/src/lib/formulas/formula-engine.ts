import * as formualizer from 'formualizer/pkg/formualizer_wasm_bg.js';
import wasmUrl from 'formualizer/pkg/formualizer_wasm_bg.wasm?url';
import {
	FormulaParseError,
	isEngineErrorCode,
	toFormulaErrorCode,
	type FormulaErrorCode
} from './formula-errors';
import type {
	EngineJob,
	EngineOutcome,
	EngineValue,
	FormulaScalar,
	FormulaToken
} from './formula-types';

const SHEET = 'S';

let loading: Promise<FormulaEngine> | null = null;

/** Loads the Formualizer WASM module once and returns the shared engine. */
export function loadFormulaEngine(): Promise<FormulaEngine> {
	loading ??= (async () => {
		const imports = { './formualizer_wasm_bg.js': formualizer as unknown as WebAssembly.ModuleImports };
		const response = fetch(wasmUrl);
		const { instance } =
			typeof WebAssembly.instantiateStreaming === 'function'
				? await WebAssembly.instantiateStreaming(response, imports).catch(async () =>
						WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), imports)
					)
				: await WebAssembly.instantiate(await (await response).arrayBuffer(), imports);

		formualizer.__wbg_set_wasm(instance.exports);
		(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
		return new FormulaEngine();
	})();
	loading.catch(() => (loading = null));
	return loading;
}

/**
 * Thin synchronous facade over Formualizer. IntelliSheet formulas never reach the
 * engine verbatim: the runtime rewrites Smartsheet-style references into
 * engine addresses over a scratch sheet populated with resolved values.
 */
export class FormulaEngine {
	tokenize(source: string): FormulaToken[] {
		let tokenizer: formualizer.Tokenizer;
		try {
			tokenizer = new formualizer.Tokenizer(source);
		} catch (error) {
			throw new FormulaParseError('#PARSE!', String(error));
		}
		try {
			return tokenizer.tokens() as FormulaToken[];
		} finally {
			tokenizer.free();
		}
	}

	/**
	 * Evaluates many independent jobs in one scratch workbook. Each job gets its
	 * own horizontal band of rows: slot i occupies column i+1 (ranges run down
	 * the band) and the formula sits in the column after the last slot.
	 */
	evaluateBatch(jobs: EngineJob[]): EngineOutcome[] {
		if (jobs.length === 0) return [];

		const workbook = new formualizer.Workbook();
		try {
			workbook.addSheet(SHEET);
			const sheet = workbook.sheet(SHEET);
			const targets: Array<{ row: number; col: number } | EngineOutcome> = [];

			let bandStart = 1;
			for (const job of jobs) {
				const addresses: string[] = [];
				let bandHeight = 1;

				job.slots.forEach((slot, index) => {
					const col = index + 1;
					const values = slot.kind === 'scalar' ? [slot.value] : slot.values;
					const height = Math.max(values.length, 1);
					bandHeight = Math.max(bandHeight, height);
					writeValues(workbook, sheet, bandStart, col, values);

					const first = `${columnLetters(col)}${bandStart}`;
					addresses.push(
						slot.kind === 'scalar' ? first : `${first}:${columnLetters(col)}${bandStart + height - 1}`
					);
				});

				const target = { row: bandStart, col: job.slots.length + 1 };
				const formula = job.template
					.map((piece) => (typeof piece === 'string' ? piece : addresses[piece.slot]))
					.join('');

				try {
					workbook.setFormula(SHEET, target.row, target.col, formula);
					targets.push(target);
				} catch (error) {
					targets.push({ ok: false, code: '#PARSE!', message: String(error) });
				}
				bandStart += bandHeight;
			}

			workbook.evaluateAll();

			return targets.map((target) => {
				if ('ok' in target) return target;
				try {
					return toOutcome(workbook.evaluateCell(SHEET, target.row, target.col));
				} catch (error) {
					return { ok: false, code: '#VALUE!', message: String(error) };
				}
			});
		} finally {
			workbook.free();
		}
	}
}

function writeValues(
	workbook: formualizer.Workbook,
	sheet: formualizer.Sheet,
	startRow: number,
	col: number,
	values: EngineValue[]
) {
	if (values.length === 0) return;

	const plain: FormulaScalar[][] = [];
	const errors: Array<{ row: number; literal: string }> = [];
	values.forEach((value, i) => {
		if (value.type === 'value') {
			plain.push([value.value]);
		} else {
			plain.push([null]);
			errors.push({ row: startRow + i, literal: engineErrorLiteral(value.code) });
		}
	});

	if (plain.length === 1) {
		if (plain[0][0] !== null) workbook.setValue(SHEET, startRow, col, plain[0][0]);
	} else {
		sheet.setValues(startRow, col, plain);
	}
	for (const error of errors) workbook.setFormula(SHEET, error.row, col, `=${error.literal}`);
}

function engineErrorLiteral(code: FormulaErrorCode): string {
	// IntelliSheet-only codes (#CYCLE!, #PARSE!) have no engine literal; the runtime
	// short-circuits them before building a job. Fall back defensively.
	return isEngineErrorCode(code) ? code : '#VALUE!';
}

function toOutcome(raw: unknown): EngineOutcome {
	let value = raw;
	while (Array.isArray(value)) value = value[0]; // spilled/array results: top-left
	if (value === undefined || value === null) return { ok: true, value: null };

	const code = toFormulaErrorCode(value);
	if (code) return { ok: false, code };

	if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
		return { ok: true, value };
	}
	if (value instanceof Date) return { ok: true, value: value.toISOString().slice(0, 10) };
	return { ok: true, value: String(value) };
}

export function columnLetters(index: number): string {
	let n = index;
	let letters = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		letters = String.fromCharCode(65 + rem) + letters;
		n = Math.floor((n - 1) / 26);
	}
	return letters;
}
