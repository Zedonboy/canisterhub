import { parseCellInput } from '@/lib/editing/cell-input';
import { isFormulaCell, type CellValue, type Column } from '@/lib/types';
import type { CleanupProposal, CleanupResult } from '../types';
import { companyKey, normalizeText, parseLooseDate, parseLooseNumber, plural, similarity } from '../text';
import { cellText } from './shared';

export interface CleanupCell {
	rowId: string;
	value: CellValue;
}

const SYNONYMS: Array<[RegExp, RegExp]> = [
	[/^(done|completed?|finished|closed)$/, /complete|done|closed/],
	[/^(wip|in ?progress|ongoing|started|working)$/, /progress/],
	[/^(to ?do|todo|pending|not ?started|new|open)$/, /not started|to do|open|new/],
	[/^(settled|cleared|paid ?off|paid)$/, /^paid$/],
	[/^(outstanding|owed|due|not ?paid|unpaid)$/, /unpaid|outstanding/],
	[/^(disputed?|query|queried|on hold)$/, /disput|hold/]
];

function parsed(column: Column, raw: string): CellValue | undefined {
	const result = parseCellInput(column, raw);
	return result.ok ? result.value : undefined;
}

export function cleanColumn(column: Column, cells: CleanupCell[]): CleanupResult {
	const proposals: CleanupProposal[] = [];
	const texts = cells
		.filter((cell) => cell.value !== null && cell.value !== undefined && !isFormulaCell(cell.value) && !Array.isArray(cell.value))
		.map((cell) => ({ ...cell, text: typeof cell.value === 'string' ? cell.value : cellText(cell.value) }))
		.filter((cell) => cell.text !== '');

	// 1. Extra spaces.
	const spaced = texts.filter((cell) => typeof cell.value === 'string' && cell.text !== cell.text.trim().replace(/\s{2,}/g, ' '));
	if (spaced.length > 0) {
		proposals.push({
			id: 'whitespace',
			kind: 'whitespace',
			title: `Trim extra spaces in ${plural(spaced.length, 'cell')}`,
			detail: 'Leading, trailing or doubled spaces make identical values look different to filters and totals.',
			from: [...new Set(spaced.map((cell) => `“${cell.text}”`))].slice(0, 4),
			to: 'Trimmed text',
			updates: spaced.map((cell) => ({ rowId: cell.rowId, columnKey: column.key, value: cell.text.trim().replace(/\s{2,}/g, ' ') }))
		});
	}
	const trimmed = texts.map((cell) => ({ ...cell, text: cell.text.trim().replace(/\s{2,}/g, ' ') }));

	// 2. Enum values that aren't options.
	if (column.data_type === 'enum') {
		const options = column.settings.options ?? [];
		const byTarget = new Map<string, { from: Set<string>; rows: string[] }>();
		for (const cell of trimmed) {
			if (options.some((option) => option.value === cell.text)) continue;
			const key = normalizeText(cell.text);
			let target =
				options.find((option) => normalizeText(option.value) === key)?.value ??
				SYNONYMS.map(([from, to]) => (from.test(key) ? options.find((option) => to.test(normalizeText(option.value)))?.value : undefined)).find(Boolean);
			if (!target) {
				const best = options.map((option) => ({ value: option.value, score: similarity(option.value, cell.text) })).sort((a, b) => b.score - a.score)[0];
				if (best && best.score >= 0.6) target = best.value;
			}
			if (!target) continue;
			const entry = byTarget.get(target) ?? { from: new Set<string>(), rows: [] };
			entry.from.add(cell.text);
			entry.rows.push(cell.rowId);
			byTarget.set(target, entry);
		}
		for (const [target, entry] of byTarget) {
			proposals.push({
				id: `option:${target}`,
				kind: 'option',
				title: `Map ${[...entry.from].map((value) => `“${value}”`).join(', ')} to ${target}`,
				detail: `${plural(entry.rows.length, 'cell')} hold a value that isn’t one of this column’s options, so they don’t show as a coloured choice or match filters.`,
				from: [...entry.from],
				to: target,
				updates: entry.rows.map((rowId) => ({ rowId, columnKey: column.key, value: target }))
			});
		}
		return { columnKey: column.key, scanned: cells.length, proposals };
	}

	// 3. Dates typed in different formats.
	if (column.data_type === 'date') {
		const fixes = trimmed
			.map((cell) => ({ cell, date: /^\d{4}-\d{2}-\d{2}$/.test(cell.text) ? null : parseLooseDate(cell.text) }))
			.filter((entry): entry is { cell: (typeof trimmed)[number]; date: NonNullable<ReturnType<typeof parseLooseDate>> } => entry.date !== null);
		if (fixes.length > 0) {
			const ambiguous = fixes.filter((entry) => entry.date.ambiguous).length;
			proposals.push({
				id: 'dates',
				kind: 'date',
				title: `Standardise ${plural(fixes.length, 'date')} to YYYY-MM-DD`,
				detail:
					ambiguous > 0
						? `${plural(ambiguous, 'date')} could be read either way round (e.g. 03/04). Read as day first. Check those before applying.`
						: 'Mixed formats sort and filter unpredictably. Every date will use one format.',
				from: [...new Set(fixes.map((entry) => entry.cell.text))].slice(0, 5),
				to: fixes[0].date.iso,
				updates: fixes.flatMap((entry) => {
					const value = parsed(column, entry.date.iso);
					return value === undefined ? [] : [{ rowId: entry.cell.rowId, columnKey: column.key, value }];
				})
			});
		}
		return { columnKey: column.key, scanned: cells.length, proposals };
	}

	// 4. Numbers stored as text.
	if (column.data_type === 'number' || column.data_type === 'currency') {
		const fixes = trimmed
			.filter((cell) => typeof cell.value === 'string')
			.map((cell) => ({ cell, number: parseLooseNumber(cell.text) }))
			.filter((entry): entry is { cell: (typeof trimmed)[number]; number: number } => entry.number !== null);
		if (fixes.length > 0) {
			proposals.push({
				id: 'numbers',
				kind: 'number',
				title: `Convert ${plural(fixes.length, 'number')} stored as text`,
				detail: 'Text like “1,250.00” is skipped by SUM and sorts alphabetically. These become real numbers.',
				from: [...new Set(fixes.map((entry) => entry.cell.text))].slice(0, 5),
				to: fixes[0].number.toLocaleString(),
				updates: fixes.flatMap((entry) => {
					const value = parsed(column, String(entry.number));
					return value === undefined ? [] : [{ rowId: entry.cell.rowId, columnKey: column.key, value }];
				})
			});
		}
		return { columnKey: column.key, scanned: cells.length, proposals };
	}

	// 5. Different spellings of the same name (text columns).
	if (column.data_type === 'text') {
		const groups = new Map<string, Map<string, string[]>>();
		for (const cell of trimmed) {
			const key = companyKey(cell.text) || normalizeText(cell.text);
			if (!key) continue;
			const spellings = groups.get(key) ?? new Map<string, string[]>();
			spellings.set(cell.text, [...(spellings.get(cell.text) ?? []), cell.rowId]);
			groups.set(key, spellings);
		}

		// Fold near-identical keys (typos) into the more common group.
		const keys = [...groups.keys()].slice(0, 400);
		const size = (key: string) => [...(groups.get(key)?.values() ?? [])].reduce((sum, rows) => sum + rows.length, 0);
		for (let i = 0; i < keys.length; i++) {
			for (let j = i + 1; j < keys.length; j++) {
				const a = keys[i];
				const b = keys[j];
				if (!groups.has(a) || !groups.has(b) || Math.min(a.length, b.length) < 5) continue;
				if (similarity(a, b) < 0.88) continue;
				const [keep, fold] = size(a) >= size(b) ? [a, b] : [b, a];
				const target = groups.get(keep)!;
				for (const [spelling, rows] of groups.get(fold)!) target.set(spelling, [...(target.get(spelling) ?? []), ...rows]);
				groups.delete(fold);
			}
		}

		for (const [key, spellings] of groups) {
			if (spellings.size < 2) continue;
			// Most common spelling wins; ties go to normal capitalisation, then the fuller name.
			const casing = (value: string) => (value !== value.toLowerCase() && value !== value.toUpperCase() ? 1 : 0);
			const ranked = [...spellings.entries()].sort(
				(a, b) => b[1].length - a[1].length || casing(b[0]) - casing(a[0]) || b[0].length - a[0].length
			);
			const canonical = ranked[0][0];
			const others = ranked.slice(1);
			const rows = others.flatMap(([, ids]) => ids);
			proposals.push({
				id: `merge:${key}`,
				kind: 'merge',
				title: `Merge ${spellings.size} spellings of “${canonical}”`,
				detail: `${plural(rows.length, 'cell')} ${rows.length === 1 ? 'uses' : 'use'} a different spelling of the same name, so it’s counted as ${spellings.size} different entries.`,
				from: others.map(([spelling]) => spelling),
				to: canonical,
				updates: rows.map((rowId) => ({ rowId, columnKey: column.key, value: canonical }))
			});
		}
	}

	return { columnKey: column.key, scanned: cells.length, proposals: proposals.sort((a, b) => b.updates.length - a.updates.length) };
}
