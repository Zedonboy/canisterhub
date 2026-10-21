import type { AggregateOperation } from '@/lib/types';
import type { FormulaEngine } from './formula-engine';
import { FormulaParseError, formulaError, type FormulaError } from './formula-errors';
import type { FormulaPart, FormulaReference, FormulaToken, ParsedFormula } from './formula-types';

/**
 * Parses Smartsheet-style formulas using Formualizer's tokenizer, then maps
 * IntelliSheet references onto a template the runtime can rewrite for the engine.
 *
 * Supported references:
 *   [Column]  [Column]@row      cell in the formula's row
 *   [Column]12                  cell in sheet row 12
 *   [Column]3:[Column]40        rows 3..40 of one column
 *   [Column]:[Column]           the whole column
 *   CHILDREN([Column])          the formula row's direct children
 */

export type ParseOutcome = { ok: true; formula: ParsedFormula } | { ok: false; error: FormulaError };

const AGGREGATE_FUNCTIONS: Record<string, AggregateOperation> = {
	SUM: 'sum',
	COUNT: 'count',
	COUNTA: 'counta',
	AVG: 'avg',
	AVERAGE: 'avg',
	MIN: 'min',
	MAX: 'max'
};

/** Smartsheet function names that differ from the engine's. */
const FUNCTION_ALIASES: Record<string, string> = {
	AVG: 'AVERAGE'
};

export const ENGINE_AGGREGATE_NAMES: Record<AggregateOperation, string> = {
	sum: 'SUM',
	count: 'COUNT',
	counta: 'COUNTA',
	avg: 'AVERAGE',
	min: 'MIN',
	max: 'MAX'
};

const COLUMN_REF = /^\[([^\]]+)\](\d+)?$/;
const CACHE_LIMIT = 5_000;
const cache = new Map<string, ParseOutcome>();

export function parseFormula(engine: FormulaEngine, source: string): ParseOutcome {
	const cached = cache.get(source);
	if (cached) return cached;

	let outcome: ParseOutcome;
	try {
		outcome = { ok: true, formula: parseTokens(source, engine.tokenize(normalise(source))) };
	} catch (error) {
		outcome =
			error instanceof FormulaParseError
				? { ok: false, error: formulaError(error.code, error.message) }
				: { ok: false, error: formulaError('#PARSE!', String(error)) };
	}

	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	cache.set(source, outcome);
	return outcome;
}

function normalise(source: string): string {
	const trimmed = source.trim();
	return trimmed.startsWith('=') ? trimmed : `=${trimmed}`;
}

class TokenCursor {
	constructor(readonly tokens: FormulaToken[]) {}

	at(i: number): FormulaToken | undefined {
		return this.tokens[i];
	}

	/** Index of the next non-whitespace token at or after `i`. */
	skipWhitespace(i: number): number {
		while (this.tokens[i]?.tokenType === 'Whitespace') i++;
		return i;
	}
}

const isFuncOpen = (t?: FormulaToken) => t?.tokenType === 'Func' && t.subtype === 'Open';
const isFuncClose = (t?: FormulaToken) => t?.tokenType === 'Func' && t.subtype === 'Close';
const isRangeOperand = (t?: FormulaToken) => t?.tokenType === 'Operand' && t.subtype === 'Range';

function parseTokens(source: string, tokens: FormulaToken[]): ParsedFormula {
	const cursor = new TokenCursor(tokens);
	const references: FormulaReference[] = [];
	const referenceIds = new Map<string, number>();
	const parts: FormulaPart[] = [];

	const addReference = (ref: FormulaReference) => {
		const id = JSON.stringify(ref);
		let index = referenceIds.get(id);
		if (index === undefined) {
			index = references.push(ref) - 1;
			referenceIds.set(id, index);
		}
		return index;
	};

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];

		if (isFuncOpen(token)) {
			const name = token.value.slice(0, -1).toUpperCase();

			if (name === 'CHILDREN') {
				const { ref, next } = parseChildren(cursor, i);
				parts.push({ kind: 'ref', ref: addReference(ref) });
				i = next;
				continue;
			}

			const operation = AGGREGATE_FUNCTIONS[name];
			if (operation) {
				const argStart = cursor.skipWhitespace(i + 1);
				const arg = tryParseRangeArgument(cursor, argStart);
				if (arg) {
					const close = cursor.skipWhitespace(arg.next);
					if (isFuncClose(cursor.at(close))) {
						parts.push({ kind: 'aggregate', operation, ref: addReference(arg.ref) });
						i = close + 1;
						continue;
					}
				}
			}

			parts.push({ kind: 'text', text: `${FUNCTION_ALIASES[name] ?? name}(` });
			i++;
			continue;
		}

		if (isRangeOperand(token)) {
			const { ref, next } = parseReference(cursor, i);
			parts.push({ kind: 'ref', ref: addReference(ref) });
			i = next;
			continue;
		}

		parts.push({ kind: 'text', text: token.value });
		i++;
	}

	return { source, parts, references };
}

function parseChildren(cursor: TokenCursor, openIndex: number) {
	const argIndex = cursor.skipWhitespace(openIndex + 1);
	const arg = cursor.at(argIndex);

	if (isFuncClose(arg)) {
		return { ref: { kind: 'children', column: null } as FormulaReference, next: argIndex + 1 };
	}

	const match = isRangeOperand(arg) ? COLUMN_REF.exec(arg!.value) : null;
	const closeIndex = cursor.skipWhitespace(argIndex + 1);
	if (!match || match[2] !== undefined || !isFuncClose(cursor.at(closeIndex))) {
		throw new FormulaParseError('#PARSE!', 'CHILDREN() expects a single column reference like CHILDREN([Cost])');
	}
	return {
		ref: { kind: 'children', column: match[1].trim() } as FormulaReference,
		next: closeIndex + 1
	};
}

/** A range-like argument (explicit range, whole column, or CHILDREN). */
function tryParseRangeArgument(cursor: TokenCursor, index: number) {
	const token = cursor.at(index);
	if (isFuncOpen(token) && token!.value.toUpperCase() === 'CHILDREN(') {
		return parseChildren(cursor, index);
	}
	if (!isRangeOperand(token) || !COLUMN_REF.test(token!.value)) return null;
	const parsed = parseReference(cursor, index);
	return parsed.ref.kind === 'range' ? parsed : null;
}

function parseReference(cursor: TokenCursor, index: number): { ref: FormulaReference; next: number } {
	const token = cursor.at(index)!;
	const match = COLUMN_REF.exec(token.value);
	if (!match) {
		throw new FormulaParseError(
			'#REF!',
			`Unsupported reference "${token.value}". Use column references like [Quantity] or [Quantity]@row.`
		);
	}

	const column = match[1].trim();
	const rowNumber = match[2] === undefined ? null : Number(match[2]);
	const next = cursor.at(index + 1);
	const after = cursor.at(index + 2);

	// [Column]@row
	if (next?.tokenType === 'OpPrefix' && next.value === '@' && after?.value.toLowerCase() === 'row') {
		if (rowNumber !== null) throw new FormulaParseError('#PARSE!', `Invalid reference ${token.value}@row`);
		return { ref: { kind: 'cell', column, row: { kind: 'current' } }, next: index + 3 };
	}

	// [Column]a:[Column]b  /  [Column]:[Column]
	if (next?.tokenType === 'OpInfix' && next.value === ':' && isRangeOperand(after)) {
		const endMatch = COLUMN_REF.exec(after!.value);
		if (!endMatch) throw new FormulaParseError('#REF!', `Unsupported range end "${after!.value}"`);
		if (endMatch[1].trim().toLowerCase() !== column.toLowerCase()) {
			throw new FormulaParseError('#REF!', 'Ranges across multiple columns are not supported yet');
		}
		const endRow = endMatch[2] === undefined ? null : Number(endMatch[2]);
		if ((rowNumber === null) !== (endRow === null)) {
			throw new FormulaParseError('#PARSE!', 'A range must give row numbers on both ends or neither');
		}
		const [start, end] =
			rowNumber === null || endRow === null
				? [null, null]
				: [Math.min(rowNumber, endRow), Math.max(rowNumber, endRow)];
		return { ref: { kind: 'range', column, start, end }, next: index + 3 };
	}

	if (rowNumber !== null && rowNumber < 1) {
		throw new FormulaParseError('#REF!', `Row numbers start at 1 (${token.value})`);
	}

	return {
		ref: {
			kind: 'cell',
			column,
			row: rowNumber === null ? { kind: 'current' } : { kind: 'number', rowNumber }
		},
		next: index + 1
	};
}
