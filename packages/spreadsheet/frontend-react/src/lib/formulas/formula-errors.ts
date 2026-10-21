/** Error codes understood by the spreadsheet engine (injectable as literals). */
export const ENGINE_ERROR_CODES = ['#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#N/A', '#NUM!', '#NULL!'] as const;

/** IntelliSheet-specific codes that the engine cannot represent as a literal. */
export const SILVER_ERROR_CODES = ['#CYCLE!', '#PARSE!'] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];
export type FormulaErrorCode = EngineErrorCode | (typeof SILVER_ERROR_CODES)[number];

export interface FormulaError {
	code: FormulaErrorCode;
	message: string;
}

const DESCRIPTIONS: Record<FormulaErrorCode, string> = {
	'#REF!': 'A referenced row or column does not exist',
	'#VALUE!': 'A value has the wrong type for this operation',
	'#DIV/0!': 'Division by zero',
	'#NAME?': 'Unknown function name',
	'#N/A': 'Value not available',
	'#NUM!': 'Invalid numeric value',
	'#NULL!': 'Empty intersection',
	'#CYCLE!': 'Circular reference',
	'#PARSE!': 'The formula could not be parsed'
};

/** Engine-specific codes normalised to IntelliSheet's vocabulary. */
const ENGINE_ALIASES: Record<string, FormulaErrorCode> = {
	'#CIRC!': '#CYCLE!',
	'#ERROR!': '#PARSE!',
	'#SPILL!': '#VALUE!',
	'#CALC!': '#VALUE!'
};

const ALL_CODES = new Set<string>([...ENGINE_ERROR_CODES, ...SILVER_ERROR_CODES]);

export function formulaError(code: FormulaErrorCode, message = DESCRIPTIONS[code]): FormulaError {
	return { code, message };
}

/**
 * Interprets a formula *result* (cached or computed) as an error code. Plain
 * text cells are never passed through this: a text cell reading "#N/A" is text.
 */
export function toFormulaErrorCode(value: unknown): FormulaErrorCode | null {
	if (typeof value !== 'string' || !value.startsWith('#')) return null;
	if (ENGINE_ALIASES[value]) return ENGINE_ALIASES[value];
	return ALL_CODES.has(value) ? (value as FormulaErrorCode) : null;
}

export function isEngineErrorCode(code: FormulaErrorCode): code is EngineErrorCode {
	return (ENGINE_ERROR_CODES as readonly string[]).includes(code);
}

export function describeFormulaError(code: FormulaErrorCode): string {
	return DESCRIPTIONS[code];
}

/** Thrown by the parser; carries the error the cell should display. */
export class FormulaParseError extends Error {
	constructor(
		readonly code: FormulaErrorCode,
		message: string
	) {
		super(message);
		this.name = 'FormulaParseError';
	}
}
