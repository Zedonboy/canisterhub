import { parseCellInput } from '@/lib/editing/cell-input';
import type { Column } from '@/lib/types';
import type { ExtractResult, ExtractedRow } from '../types';
import { closestColumn, normalizeText, parseLooseDate, plural, similarity } from '../text';

const LABEL_GROUPS: string[][] = [
	['supplier', 'vendor', 'from', 'billed by', 'company', 'payee', 'merchant', 'seller', 'bill from'],
	['invoice no', 'invoice number', 'invoice', 'inv no', 'reference', 'ref', 'invoice id', 'bill no'],
	['amount', 'total', 'amount due', 'balance due', 'total due', 'grand total', 'price', 'cost', 'sum'],
	['due date', 'due', 'payment due', 'pay by', 'due by'],
	['issue date', 'invoice date', 'date issued', 'date', 'issued', 'billed on'],
	['description', 'details', 'item', 'memo', 'narration', 'particulars'],
	['status', 'state'],
	['category', 'type', 'account'],
	['quantity', 'qty', 'units'],
	['notes', 'note', 'comment', 'comments']
];

/** The column a document label refers to, via label synonyms then fuzzy name matching. */
function columnForLabel(label: string, columns: Column[]): Column | undefined {
	const key = normalizeText(label).replace(/\b(no|number|num)\b/, 'no').trim();
	if (!key) return undefined;
	const exact = columns.find((column) => normalizeText(column.name) === key);
	if (exact) return exact;
	const group = LABEL_GROUPS.find((labels) => labels.includes(key));
	if (group) {
		const column = columns.find((candidate) => group.includes(normalizeText(candidate.name).replace(/\b(no|number)\b/, 'no').trim()));
		if (column) return column;
		const loose = columns.find((candidate) => group.some((label) => normalizeText(candidate.name).includes(label)));
		if (loose) return loose;
	}
	return closestColumn(label, columns, 0.72);
}

function review(column: Column, raw: string): string | null {
	const value = raw.trim();
	if (!value) return null;
	if (column.data_type === 'date') {
		const date = parseLooseDate(value);
		if (!date) return `Couldn’t read “${value}” as a date.`;
		if (date.ambiguous) {
			const [year, month, day] = date.iso.split('-').map(Number);
			const label = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
			return `Read as ${label}. Confirm the day/month order.`;
		}
		return null;
	}
	if (column.data_type === 'enum') {
		const options = column.settings.options ?? [];
		if (options.some((option) => option.value.toLowerCase() === value.toLowerCase())) return null;
		const best = options.map((option) => ({ value: option.value, score: similarity(option.value, value) })).sort((a, b) => b.score - a.score)[0];
		return best && best.score > 0.5 ? `“${value}” isn’t an option. Did you mean ${best.value}?` : `“${value}” isn’t one of this column’s options.`;
	}
	const parsed = parseCellInput(column, column.data_type === 'currency' || column.data_type === 'number' ? value.replace(/[^\d.,()-]/g, '') : value);
	return parsed.ok ? null : parsed.reason;
}

/** Normalises a raw value so it parses for the column: ISO dates, bare numbers. */
function tidy(column: Column, raw: string): string {
	const value = raw.trim().replace(/^["']|["']$/g, '');
	if (column.data_type === 'date') return parseLooseDate(value)?.iso ?? value;
	if (column.data_type === 'enum') {
		return (column.settings.options ?? []).find((option) => option.value.toLowerCase() === value.toLowerCase())?.value ?? value;
	}
	if (column.data_type === 'currency' || column.data_type === 'number') return value.replace(/[^\d.-]/g, '') || value;
	return value;
}

function splitCells(line: string): string[] {
	if (line.includes('\t')) return line.split('\t');
	if (line.includes('|')) return line.split('|').filter((cell, i, all) => !(cell.trim() === '' && (i === 0 || i === all.length - 1)));
	if (/\s{2,}/.test(line.trim())) return line.trim().split(/\s{2,}/);
	// CSV with quoted cells.
	const cells: string[] = [];
	let current = '';
	let quoted = false;
	for (const char of line) {
		if (char === '"') quoted = !quoted;
		else if (char === ',' && !quoted) {
			cells.push(current);
			current = '';
		} else current += char;
	}
	cells.push(current);
	return cells;
}

export function extractRows(document: string, columns: Column[]): ExtractResult {
	const writable = columns.filter((column) => !column.settings.column_formula && column.data_type !== 'protected');
	const lines = document.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const notes: string[] = [];
	const unmapped = new Set<string>();

	// Table: a header line with at least two recognised column labels.
	for (let i = 0; i < lines.length; i++) {
		const header = splitCells(lines[i]).map((cell) => cell.trim());
		if (header.length < 2) continue;
		const mapped = header.map((label) => columnForLabel(label, writable));
		if (mapped.filter(Boolean).length < 2) continue;

		const rows: ExtractedRow[] = [];
		for (const line of lines.slice(i + 1)) {
			const cells = splitCells(line);
			if (cells.length < 2 || /^[-=|\s]+$/.test(line)) continue;
			if (/^(sub)?total\b/i.test(cells[0]?.trim() ?? '')) continue;
			const row: ExtractedRow = { values: {}, issues: {} };
			cells.forEach((cell, index) => {
				const column = mapped[index];
				if (!column) return;
				const value = tidy(column, cell);
				row.values[column.key] = value;
				const issue = review(column, cell.trim());
				if (issue) row.issues[column.key] = issue;
			});
			if (Object.keys(row.values).length > 0) rows.push(row);
		}
		header.forEach((label, index) => {
			if (!mapped[index] && label) unmapped.add(label);
		});
		notes.push(`Read a table with ${plural(rows.length, 'row')}, matching ${mapped.filter(Boolean).length} of ${header.length} headings to columns.`);
		return { rows, unmapped: [...unmapped], notes };
	}

	// Key: value pairs, e.g. an invoice email, become one row.
	const row: ExtractedRow = { values: {}, issues: {} };
	const strengths = new Map<string, number>();
	for (const line of lines) {
		const pair = line.match(/^([A-Za-z][A-Za-z .#/()-]{1,40}?)\s*[:=]\s*(.+)$/);
		if (!pair) continue;
		const [, label, raw] = pair;
		const column = columnForLabel(label, writable);
		if (!column) {
			unmapped.add(label.trim());
			continue;
		}
		// A label that is the column's own name beats a synonym such as "From".
		const strength = normalizeText(label) === normalizeText(column.name) ? 2 : 1;
		if (row.values[column.key] && (strengths.get(column.key) ?? 0) >= strength) continue;
		strengths.set(column.key, strength);
		row.values[column.key] = tidy(column, raw);
		delete row.issues[column.key];
		const issue = review(column, raw.trim());
		if (issue) row.issues[column.key] = issue;
	}

	const primary = writable.find((column) => column.settings.primary) ?? writable[0];
	if (primary && !row.values[primary.key]) {
		const from = lines.find((line) => /^(from|bill from|billed by|sender)\b/i.test(line))?.replace(/^[^:]*:\s*/, '');
		if (from) row.values[primary.key] = from.replace(/<.*?>/g, '').trim();
		else row.issues[primary.key] = `No ${primary.name} found. Fill it in before inserting.`;
	}

	if (Object.keys(row.values).length === 0) {
		return { rows: [], unmapped: [...unmapped], notes: ['Found no table or “Label: value” lines this sheet’s columns could use.'] };
	}
	notes.push(`Read “Label: value” lines as one row, filling ${plural(Object.keys(row.values).length, 'column')}.`);
	return { rows: [row], unmapped: [...unmapped], notes };
}

export const SAMPLE_DOCUMENTS: { id: string; label: string; text: string }[] = [
	{
		id: 'invoice-email',
		label: 'Invoice email',
		text: `From: accounts@brightwayoffice.ng
Subject: Invoice BW-2291 for March supplies

Hello,

Please find the details of your invoice below.

Supplier: Brightway Office Supplies
Invoice No: BW-2291
Invoice date: 14/03/2026
Due date: 04/05/2026
Amount due: $1,845.50
Status: unpaid
PO Reference: PO-7781

Thank you for your business.`
	},
	{
		id: 'statement-table',
		label: 'Supplier statement (table)',
		text: `Supplier\tInvoice No.\tInvoice Date\tDue Date\tAmount
Kora Tech Inc\tKT-5510\t2026-03-02\t2026-04-01\t$3,200.00
Kora Tech Inc\tKT-5524\t2026-03-16\t2026-04-15\t$980.00
Zenith Logistics\tZL-118\t03/03/2026\t02/04/2026\t$2,410.75
Total\t\t\t\t$6,590.75`
	}
];
