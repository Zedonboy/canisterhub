import type { AggregateOperation } from '@/lib/types';
import type { FormulaError, FormulaErrorCode } from './formula-errors';

export type FormulaState = 'idle' | 'loading-dependencies' | 'evaluating' | 'ready' | 'error';

export type FormulaScalar = string | number | boolean | null;

/** Which row a single-cell reference points at. */
export type RowSelector =
	| { kind: 'current' } // [Column] or [Column]@row
	| { kind: 'number'; rowNumber: number }; // [Column]12 (1-based sheet row number)

/**
 * A reference discovered in a formula. Column references are by *name*; the
 * runtime resolves names to column keys against the sheet's columns.
 */
export type FormulaReference =
	| { kind: 'cell'; column: string; row: RowSelector }
	/** [Column]a:[Column]b, or [Column]:[Column] when start/end are null. */
	| { kind: 'range'; column: string; start: number | null; end: number | null }
	/** CHILDREN([Column]) of the formula's row; `column` null means the formula's own column. */
	| { kind: 'children'; column: string | null };

export type FormulaPart =
	| { kind: 'text'; text: string }
	| { kind: 'ref'; ref: number }
	/**
	 * SUM/COUNT/COUNTA/AVG/MIN/MAX over a single range argument. The runtime may
	 * satisfy it with a backend aggregate instead of materialising the range.
	 */
	| { kind: 'aggregate'; operation: AggregateOperation; ref: number };

export interface ParsedFormula {
	source: string;
	parts: FormulaPart[];
	references: FormulaReference[];
}

export interface FormulaResult {
	state: FormulaState;
	/** Value to display: computed when available, otherwise the cached server value. */
	value: FormulaScalar;
	/** Present when state === 'error'. */
	error?: FormulaError;
	/** The server's cached value, for inspection. */
	cachedValue: FormulaScalar;
	/** True when `value` was produced by the client runtime. */
	computed: boolean;
}

/** A value handed to the engine: a scalar, or an error literal. */
export type EngineValue =
	| { type: 'value'; value: FormulaScalar }
	| { type: 'error'; code: FormulaErrorCode };

export type EngineSlot =
	| { kind: 'scalar'; value: EngineValue }
	| { kind: 'range'; values: EngineValue[] };

/** A formula rewritten to engine addresses once its slots are laid out. */
export type EngineTemplate = Array<string | { slot: number }>;

export interface EngineJob {
	slots: EngineSlot[];
	template: EngineTemplate;
}

export type EngineOutcome =
	| { ok: true; value: FormulaScalar }
	| { ok: false; code: FormulaErrorCode; message?: string };

export interface FormulaToken {
	tokenType: string;
	subtype: string;
	value: string;
	pos: number;
	end: number;
}
