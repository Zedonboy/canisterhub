import type { ChangeSummary, SheetChangeEntry } from '../types';
import { plural } from '../text';

function number(label: string, pattern: RegExp): number {
	const match = label.match(pattern);
	if (!match) return 0;
	return match[1] ? Number(match[1].replace(/,/g, '')) : 1;
}

export function summarizeChanges(entries: SheetChangeEntry[], since: string): ChangeSummary {
	if (entries.length === 0) {
		return { headline: `No changes ${since}.`, bullets: [] };
	}

	let cellsEdited = 0;
	let rowsAdded = 0;
	let rowsRemoved = 0;
	let undos = 0;
	let redos = 0;
	const columnChanges: string[] = [];
	const structure: string[] = [];
	const aiActions: string[] = [];

	for (const entry of entries) {
		if (entry.kind === 'undo') {
			undos++;
			continue;
		}
		if (entry.kind === 'redo') {
			redos++;
			continue;
		}
		const label = entry.label.replace(/^AI:\s*/, '');
		if (entry.label.startsWith('AI:')) aiActions.push(label);
		if (/^(Edit|Clear) /.test(label)) cellsEdited += number(label, /(?:Edit|Clear) (?:([\d,]+) )?cells?/);
		else if (entry.label.startsWith('AI:') && entry.rowsChanged) cellsEdited += entry.rowsChanged;
		rowsAdded += entry.rowsAdded;
		rowsRemoved += entry.rowsRemoved;
		// Only writes that changed the column list count, not labels that merely mention columns.
		if (entry.columnsChanged) columnChanges.push(label);
		if (/^(Indent|Outdent)/.test(label)) structure.push(label);
	}

	const parts: string[] = [];
	if (cellsEdited) parts.push(`${plural(cellsEdited, 'cell')} edited`);
	if (rowsAdded) parts.push(`${plural(rowsAdded, 'row')} added`);
	if (rowsRemoved) parts.push(`${plural(rowsRemoved, 'row')} removed`);
	if (columnChanges.length) parts.push(`${plural(columnChanges.length, 'column change')}`);
	if (structure.length) parts.push(`${plural(structure.length, 'nesting change')}`);
	const headline = `${since[0].toUpperCase()}${since.slice(1)}: ${parts.length ? parts.join(', ') : 'only undo and redo'}${aiActions.length ? `, including ${plural(aiActions.length, 'AI action')}` : ''}.`;

	const bullets: string[] = [];
	for (const change of columnChanges) bullets.push(change);
	for (const change of structure) bullets.push(change);
	for (const action of aiActions) bullets.push(`AI: ${action}`);
	if (undos || redos) bullets.push(`${undos ? `${plural(undos, 'change')} undone` : ''}${undos && redos ? ', ' : ''}${redos ? `${plural(redos, 'change')} redone` : ''}.`);
	const last = entries[entries.length - 1];
	bullets.push(`Latest: “${last.label}” at ${new Date(last.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`);

	return { headline, bullets: [...new Set(bullets)].slice(0, 12) };
}
