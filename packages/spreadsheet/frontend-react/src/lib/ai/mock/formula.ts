import type { Column } from '@/lib/types';
import type { FormulaExplanation, FormulaFix, FormulaSuggestion } from '../types';
import { closestColumn, normalizeText, referencedColumnNames } from '../text';
import { columnsInText, isNumericColumn } from './shared';

const ref = (column: Column) => `[${column.name}]`;
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

function operationFor(text: string): { fn: string; word: string } {
	if (/\b(average|avg|mean)\b/.test(text)) return { fn: 'AVG', word: 'average' };
	if (/\b(count|how many|number of)\b/.test(text)) return { fn: 'COUNT', word: 'count' };
	if (/\b(max|maximum|highest|largest|biggest)\b/.test(text)) return { fn: 'MAX', word: 'highest' };
	if (/\b(min|minimum|lowest|smallest)\b/.test(text)) return { fn: 'MIN', word: 'lowest' };
	return { fn: 'SUM', word: 'total' };
}

/** An enum option (or quoted value) named in the prompt, with its column. */
function mentionedOption(prompt: string, columns: Column[]): { column: Column; value: string } | null {
	const quoted = prompt.match(/["“']([^"”']+)["”']/)?.[1];
	const text = ` ${normalizeText(prompt)} `;
	for (const column of columns) {
		for (const option of column.settings.options ?? []) {
			const value = normalizeText(option.value);
			if (value && (text.includes(` ${value} `) || normalizeText(quoted ?? '') === value)) return { column, value: option.value };
		}
	}
	if (quoted) {
		const column = columns.find((candidate) => candidate.data_type === 'enum' || /status|stage/i.test(candidate.name));
		if (column) return { column, value: quoted };
	}
	return null;
}

function flagLabels(prompt: string, left: Column, right?: Column): [string, string] {
	const quoted = [...prompt.matchAll(/["“']([^"”']+)["”']/g)].map((match) => match[1]);
	if (quoted.length >= 2) return [quoted[0], quoted[1]];
	if (quoted.length === 1) return [quoted[0], ''];
	const names = normalizeText(`${left.name} ${right?.name ?? ''} ${prompt}`);
	if (names.includes('reorder')) return ['Reorder', 'OK'];
	if (names.includes('budget') || names.includes('planned')) return ['Over budget', 'OK'];
	if (names.includes('overdue') || names.includes('due')) return ['Overdue', ''];
	return ['Flag', ''];
}

export function writeFormula(prompt: string, columns: Column[], target?: Column): FormulaSuggestion {
	const text = normalizeText(prompt);
	const usable = columns.filter((column) => column.key !== target?.key && column.data_type !== 'protected');
	const mentioned = columnsInText(prompt, usable);
	const numeric = mentioned.filter(isNumericColumn);
	const number = prompt.match(/(-?\d[\d,]*\.?\d*)\s*(%|k\b)?/);
	const numberValue = number ? Number(number[1].replace(/,/g, '')) * (number[2] === 'k' ? 1000 : 1) : null;
	const warnings: string[] = [];
	let formula = '';

	const option = mentionedOption(prompt, usable);
	const lessThan = /\b(below|under|less than|fewer than|lower than|smaller than)\b/.test(text);
	const atMost = /\bat most\b/.test(text);
	const greaterThan = /\b(above|over|more than|greater than|exceeds?|higher than|bigger than)\b/.test(text);
	const atLeast = /\bat least\b/.test(text);

	if (/\b(children|child rows?|subtasks?|sub rows?|items under|rows under|roll ?up|rolls up|each (aisle|phase|group|section))\b/.test(text) || /\b(this|the) (aisle|phase|group|section|parent)\b/.test(text)) {
		const { fn } = operationFor(text);
		const column = numeric[0] ?? mentioned[0];
		if (fn === 'COUNT' && option) {
			formula = `=COUNTIF(CHILDREN(${ref(option.column)}), ${quote(option.value)})`;
		} else if (column) {
			formula = `=${fn}(CHILDREN(${ref(column)}))`;
		}
	} else if (/\b(share|percent|percentage|proportion|of the total|of total)\b/.test(text) && numeric[0]) {
		formula = `=${ref(numeric[0])}@row / SUM(${ref(numeric[0])}:${ref(numeric[0])})`;
	} else if ((lessThan || greaterThan || atMost || atLeast || /\b(flag|mark|label|whether)\b/.test(text)) && mentioned.length > 0) {
		let left = numeric[0] ?? mentioned[0];
		let right = numeric[1];
		const operator = lessThan ? '<' : atMost ? '<=' : greaterThan ? '>' : atLeast ? '>=' : null;
		// "below their reorder level" names only the threshold; compare the quantity-like column against it.
		if (operator && !right && numberValue === null && /reorder|level|minimum|min\b|threshold|limit|target|budget|planned/i.test(left.name)) {
			const threshold = left;
			const partner = usable.find(
				(column) => column.key !== threshold.key && isNumericColumn(column) && /qty|quantity|stock|on hand|units|actual|spent|amount|count/i.test(column.name)
			);
			if (partner) {
				right = threshold;
				left = partner;
			}
		}
		if (operator && (right || numberValue !== null)) {
			const [yes, no] = flagLabels(prompt, left, right);
			const threshold = right ? ref(right) : String(numberValue);
			formula = `=IF(${ref(left)} ${operator} ${threshold}, ${quote(yes)}, ${quote(no)})`;
		} else if (option) {
			const [yes, no] = flagLabels(prompt, option.column);
			formula = `=IF(${ref(option.column)} = ${quote(option.value)}, ${quote(yes === 'Flag' ? '✓' : yes)}, ${quote(no)})`;
		}
	} else if (numeric.length >= 2) {
		const [a, b] = numeric;
		if (/\b(minus|difference|subtract|variance|remaining|left over|less)\b/.test(text)) formula = `=${ref(a)} - ${ref(b)}`;
		else if (/\b(plus|add|combined|together)\b/.test(text)) formula = `=${ref(a)} + ${ref(b)}`;
		else if (/\b(divided|per|ratio)\b/.test(text)) formula = `=IF(${ref(b)} = 0, 0, ${ref(a)} / ${ref(b)})`;
		else formula = `=${ref(a)} * ${ref(b)}`;
	} else if (/\b(total|sum|average|avg|mean|count|max|min|highest|lowest)\b/.test(text) && numeric[0]) {
		const { fn } = operationFor(text);
		formula = `=${fn}(${ref(numeric[0])}:${ref(numeric[0])})`;
	} else if (option && /\b(count|how many|number of)\b/.test(text)) {
		formula = `=COUNTIF(${ref(option.column)}:${ref(option.column)}, ${quote(option.value)})`;
	}

	if (!formula) {
		const examples = usable.filter(isNumericColumn).slice(0, 2).map((column) => column.name);
		return {
			formula: '',
			explanation: '',
			warnings: [
				examples.length >= 2
					? `Couldn’t match that to this sheet. Name the columns, e.g. “flag rows where ${examples[0]} is below ${examples[1]}”.`
					: 'Couldn’t match that to this sheet. Name the columns you want to use, as they appear in the header.'
			]
		};
	}

	for (const name of referencedColumnNames(formula)) {
		const column = columns.find((candidate) => candidate.name === name);
		if (column && !isNumericColumn(column) && /[*/+-]/.test(formula) && !/IF\(|COUNT/.test(formula)) {
			warnings.push(`“${column.name}” isn’t a number column, so rows with text in it will show #VALUE!.`);
		}
	}
	return { formula, explanation: explainFormula(formula, columns).summary, warnings };
}

// -- Explaining ---------------------------------------------------------------------------

/** Splits "a, b, c" at top level, respecting parentheses and quotes. */
function splitTopLevel(source: string, separators: string[]): { parts: string[]; ops: string[] } {
	const parts: string[] = [];
	const ops: string[] = [];
	let depth = 0;
	let inQuote = false;
	let start = 0;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '"') inQuote = !inQuote;
		if (inQuote) continue;
		if (char === '(') depth++;
		if (char === ')') depth--;
		if (depth !== 0) continue;
		const match = separators.find((separator) => source.startsWith(separator, i));
		if (match) {
			// Keep "<=" and ">=" and "<>" whole.
			if ((match === '<' || match === '>' || match === '=') && ['<=', '>=', '<>'].some((op) => source.startsWith(op, i - 1) || source.startsWith(op, i))) {
				const pair = ['<=', '>=', '<>'].find((op) => source.startsWith(op, i));
				if (!pair) continue;
				parts.push(source.slice(start, i));
				ops.push(pair);
				i += pair.length - 1;
				start = i + 1;
				continue;
			}
			parts.push(source.slice(start, i));
			ops.push(match);
			i += match.length - 1;
			start = i + 1;
		}
	}
	parts.push(source.slice(start));
	return { parts: parts.map((part) => part.trim()), ops };
}

const OPERATOR_WORDS: Record<string, string> = {
	'<': 'is less than',
	'<=': 'is at most',
	'>': 'is more than',
	'>=': 'is at least',
	'<>': 'is not',
	'=': 'is',
	'&': 'followed by',
	'+': 'plus',
	'-': 'minus',
	'*': 'times',
	'/': 'divided by'
};

const FUNCTION_WORDS: Record<string, string> = { SUM: 'the total of', AVG: 'the average of', AVERAGE: 'the average of', COUNT: 'the number of values in', COUNTA: 'the number of filled cells in', MIN: 'the lowest value in', MAX: 'the highest value in' };

function describeReference(expr: string): string | null {
	let match = expr.match(/^\[([^\]]+)\]:\[\1\]$/);
	if (match) return `the whole ${match[1]} column`;
	match = expr.match(/^\[([^\]]+)\](\d+):\[\1\](\d+)$/);
	if (match) return `${match[1]} in rows ${Number(match[2]).toLocaleString()}–${Number(match[3]).toLocaleString()}`;
	match = expr.match(/^\[([^\]]+)\]@row$/);
	if (match) return `${match[1]} on this row`;
	match = expr.match(/^\[([^\]]+)\](\d+)$/);
	if (match) return `${match[1]} in row ${Number(match[2]).toLocaleString()}`;
	match = expr.match(/^\[([^\]]+)\]$/);
	if (match) return match[1];
	return null;
}

function humanize(raw: string): string {
	const expr = raw.trim();
	if (!expr) return 'nothing';
	if (/^"(.*)"$/.test(expr)) return expr === '""' ? 'blank' : `“${expr.slice(1, -1)}”`;
	if (/^-?\d+(\.\d+)?$/.test(expr)) return expr;
	const reference = describeReference(expr);
	if (reference) return reference;

	if (expr.startsWith('(') && expr.endsWith(')')) {
		const inner = expr.slice(1, -1);
		if (splitTopLevel(inner, [',']).parts.length === 1) return humanize(inner);
	}

	for (const group of [['<=', '>=', '<>', '<', '>', '='], ['&'], ['+', '-'], ['*', '/']]) {
		const { parts, ops } = splitTopLevel(expr, group);
		if (ops.length > 0 && parts.every(Boolean)) {
			return parts.map((part, i) => (i === 0 ? humanize(part) : `${OPERATOR_WORDS[ops[i - 1]]} ${humanize(part)}`)).join(' ');
		}
	}

	const call = expr.match(/^([A-Z][A-Z0-9.]*)\((.*)\)$/s);
	if (call) {
		const [, name, inner] = call;
		const args = splitTopLevel(inner, [',']).parts;
		if (name === 'IF') return `if ${humanize(args[0])}, shows ${humanize(args[1] ?? '""')}; otherwise ${humanize(args[2] ?? '""')}`;
		if (name === 'IFERROR') return `${humanize(args[0])}, or ${humanize(args[1] ?? '""')} if that fails`;
		if (name === 'CHILDREN') return `${args[0] ? humanize(args[0]) : 'this column'} across this row’s child rows`;
		if (name === 'COUNTIF') {
			const children = args[0]?.match(/^CHILDREN\(\[([^\]]+)\]\)$/);
			if (children) return `the number of child rows where ${children[1]} is ${humanize(args[1] ?? '""')}`;
			return `the number of cells in ${humanize(args[0])} equal to ${humanize(args[1] ?? '""')}`;
		}
		if (name === 'AND') return args.map(humanize).join(' and ');
		if (name === 'OR') return args.map(humanize).join(' or ');
		if (name === 'ROUND') return `${humanize(args[0])} rounded to ${args[1] ?? 0} decimal places`;
		if (name === 'TODAY') return 'today’s date';
		if (FUNCTION_WORDS[name]) return `${FUNCTION_WORDS[name]} ${args.map(humanize).join(' and ')}`;
		return `${name} of ${args.map(humanize).join(', ')}`;
	}
	return expr;
}

export function explainFormula(formula: string, columns: Column[]): FormulaExplanation {
	const source = formula.trim().replace(/^=/, '');
	const text = humanize(source);
	const summary = source.startsWith('IF(')
		? `${text[0].toUpperCase()}${text.slice(1)}.`
		: `Shows ${text}.`;

	const steps: string[] = [];
	for (const name of referencedColumnNames(formula)) {
		const column = columns.find((candidate) => candidate.name === name);
		steps.push(column ? `Reads ${name} (${column.data_type === 'text' && column.settings.format ? `${column.settings.format} formula` : column.data_type})` : `Refers to ${name}, which isn’t a column in this sheet`);
	}
	if (/CHILDREN\(/.test(formula)) steps.push('CHILDREN looks only at rows nested under this one');
	if (/\]:\[/.test(formula)) steps.push('A whole-column range keeps working as rows are added');
	if (/\]\d+:\[[^\]]+\]\d+/.test(formula)) steps.push('A fixed row range ignores rows added outside it');
	if (/@row/.test(formula)) steps.push('@row pins the reference to the row the formula is in');
	if (/\bIF\(/.test(formula)) steps.push('IF picks between two results');
	return { summary, steps };
}

// -- Fixing ------------------------------------------------------------------------------

export function fixFormula(formula: string, errorCode: string | null, columns: Column[]): FormulaFix | null {
	let source = formula.trim();
	if (!source) return null;
	if (!source.startsWith('=')) return { formula: `=${source}`, reason: 'Formulas start with “=”.' };

	const missing = referencedColumnNames(source).filter((name) => !columns.some((column) => column.name === name));
	if (missing.length > 0) {
		const replacements: string[] = [];
		for (const name of missing) {
			const replacement = closestColumn(name, columns, 0.45);
			if (!replacement) continue;
			source = source.split(`[${name}]`).join(`[${replacement.name}]`);
			replacements.push(`[${name}] → [${replacement.name}]`);
		}
		if (replacements.length > 0) {
			return { formula: source, reason: `No column is named ${missing.map((name) => `“${name}”`).join(', ')}. Closest match: ${replacements.join(', ')}.` };
		}
		return null;
	}

	const opens = (source.match(/\(/g) ?? []).length;
	const closes = (source.match(/\)/g) ?? []).length;
	if (opens > closes) return { formula: source + ')'.repeat(opens - closes), reason: `Added ${opens - closes === 1 ? 'a missing closing bracket' : `${opens - closes} missing closing brackets`}.` };
	if ((source.match(/"/g) ?? []).length % 2 === 1) return { formula: `${source}"`, reason: 'Closed an unfinished piece of text.' };

	if (errorCode === '#DIV/0!' && !/^=IFERROR\(/i.test(source)) {
		return { formula: `=IFERROR(${source.slice(1)}, 0)`, reason: 'Some rows divide by zero. This shows 0 for those rows instead of an error.' };
	}
	if (errorCode === '#VALUE!') {
		const text = referencedColumnNames(source).find((name) => {
			const column = columns.find((candidate) => candidate.name === name);
			return column && !isNumericColumn(column);
		});
		if (text && !/^=IFERROR\(/i.test(source)) {
			return { formula: `=IFERROR(${source.slice(1)}, "")`, reason: `“${text}” isn’t a number column, so rows with text there fail. This leaves those rows blank.` };
		}
	}
	return null;
}
