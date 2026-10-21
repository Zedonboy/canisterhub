import type { NewColumnInput } from '@/lib/storage';
import type { ColumnSettings, KnownColumnType, OptionColor } from '@/lib/types';
import type { SheetDraft } from '../types';
import { normalizeText, titleCase } from '../text';

function col(name: string, data_type: KnownColumnType, settings: ColumnSettings = {}, defaultInput?: string): NewColumnInput {
	return { name, data_type, settings, ...(defaultInput ? { defaultInput } : {}) };
}

function choice(name: string, values: Array<[string, OptionColor]>, defaultInput?: string): NewColumnInput {
	return col(name, 'enum', { options: values.map(([value, color]) => ({ value, color })) }, defaultInput);
}

interface Template {
	keywords: string[];
	name: string;
	description: string;
	columns: () => NewColumnInput[];
}

const TEMPLATES: Template[] = [
	{
		keywords: ['invoice', 'bill', 'payable', 'supplier', 'vendor'],
		name: 'Supplier Invoices',
		description: 'Invoices received from suppliers, what is still owed, and when it is due.',
		columns: () => [
			col('Supplier', 'text'),
			col('Invoice No.', 'text'),
			col('Amount', 'currency', { currency: 'USD' }),
			col('Issue Date', 'date', { column_group: 'Dates' }),
			col('Due Date', 'date', { column_group: 'Dates' }),
			choice('Status', [['Unpaid', 'amber'], ['Paid', 'green'], ['Disputed', 'red']], 'Unpaid'),
			col('Outstanding', 'text', { format: 'currency', currency: 'USD', column_formula: '=IF([Status] = "Paid", 0, [Amount])' }),
			col('Notes', 'text')
		]
	},
	{
		keywords: ['expense', 'spend', 'receipt', 'reimburs', 'purchase'],
		name: 'Expenses',
		description: 'Money spent, what it was for, and whether it is approved.',
		columns: () => [
			col('Description', 'text'),
			col('Date', 'date'),
			col('Amount', 'currency', { currency: 'USD' }),
			choice('Category', [['Travel', 'blue'], ['Software', 'violet'], ['Office', 'amber'], ['Meals', 'orange'], ['Utilities', 'teal'], ['Other', 'slate']]),
			col('Paid By', 'text'),
			col('Receipt', 'uri'),
			col('Approved', 'boolean')
		]
	},
	{
		keywords: ['inventory', 'stock', 'warehouse', 'sku', 'product'],
		name: 'Stock List',
		description: 'Items on hand, their value, and what needs reordering.',
		columns: () => [
			col('Item', 'text'),
			col('SKU', 'text'),
			choice('Category', [['Raw materials', 'slate'], ['Finished goods', 'blue'], ['Packaging', 'teal']]),
			col('Quantity', 'number', { decimals: 0 }),
			col('Reorder Level', 'number', { decimals: 0 }),
			col('Unit Price', 'currency', { currency: 'USD' }),
			col('Stock Value', 'text', { format: 'currency', currency: 'USD', column_formula: '=[Quantity] * [Unit Price]' }),
			col('Reorder Status', 'text', {
				format: 'text',
				colors: { Reorder: 'amber', OK: 'green' },
				column_formula: '=IF([Quantity] < [Reorder Level], "Reorder", "OK")'
			})
		]
	},
	{
		keywords: ['project', 'task', 'milestone', 'launch', 'plan', 'sprint', 'rollout'],
		name: 'Project Tracker',
		description: 'Tasks, who owns them, and whether they are on schedule.',
		columns: () => [
			col('Task', 'text'),
			col('Owner', 'text'),
			choice('Status', [['Not Started', 'slate'], ['In Progress', 'blue'], ['Blocked', 'red'], ['Done', 'green']], 'Not Started'),
			choice('Priority', [['Low', 'slate'], ['Medium', 'amber'], ['High', 'red']], 'Medium'),
			col('Start Date', 'date', { column_group: 'Schedule' }),
			col('Due Date', 'date', { column_group: 'Schedule' }),
			col('Notes', 'text')
		]
	},
	{
		keywords: ['sales', 'deal', 'pipeline', 'lead', 'opportunit', 'prospect'],
		name: 'Sales Pipeline',
		description: 'Open deals, their stage, and the weighted forecast.',
		columns: () => [
			col('Deal', 'text'),
			col('Account', 'text'),
			choice('Stage', [['Lead', 'slate'], ['Qualified', 'blue'], ['Proposal', 'violet'], ['Negotiation', 'amber'], ['Won', 'green'], ['Lost', 'red']], 'Lead'),
			col('Amount', 'currency', { currency: 'USD' }),
			col('Probability', 'number', { decimals: 0, suffix: '%' }),
			col('Weighted', 'text', { format: 'currency', currency: 'USD', column_formula: '=[Amount] * [Probability] / 100' }),
			col('Close Date', 'date'),
			col('Owner', 'text')
		]
	},
	{
		keywords: ['staff', 'employee', 'team', 'hr', 'payroll', 'hire', 'people'],
		name: 'Team Directory',
		description: 'Who works here, their role, and when they started.',
		columns: () => [
			col('Name', 'text'),
			col('Role', 'text'),
			choice('Department', [['Operations', 'blue'], ['Finance', 'green'], ['Sales', 'amber'], ['Engineering', 'violet']]),
			col('Email', 'text'),
			col('Start Date', 'date'),
			col('Salary', 'protected'),
			col('Active', 'boolean')
		]
	},
	{
		keywords: ['customer', 'client', 'contact', 'crm', 'account'],
		name: 'Customers',
		description: 'Customer accounts, their contacts, and how valuable they are.',
		columns: () => [
			col('Company', 'text'),
			col('Contact Name', 'text'),
			col('Email', 'text'),
			col('Phone', 'text'),
			choice('Status', [['Lead', 'slate'], ['Active', 'green'], ['At risk', 'amber'], ['Churned', 'red']], 'Lead'),
			col('Last Contacted', 'date'),
			col('Lifetime Value', 'currency', { currency: 'USD' })
		]
	},
	{
		keywords: ['budget', 'forecast', 'planned', 'variance'],
		name: 'Budget',
		description: 'Planned against actual spend, with the variance per line.',
		columns: () => [
			col('Line Item', 'text'),
			choice('Category', [['Staff', 'blue'], ['Marketing', 'amber'], ['Operations', 'teal'], ['Other', 'slate']]),
			col('Planned', 'currency', { currency: 'USD', column_group: 'Spend' }),
			col('Actual', 'currency', { currency: 'USD', column_group: 'Spend' }),
			col('Variance', 'text', { format: 'currency', currency: 'USD', column_formula: '=[Actual] - [Planned]' })
		]
	}
];

interface Modifier {
	pattern: RegExp;
	has: (columns: NewColumnInput[]) => boolean;
	column: () => NewColumnInput;
	note: string;
}

const hasName = (columns: NewColumnInput[], ...names: string[]) =>
	columns.some((column) => names.some((name) => normalizeText(column.name).includes(name)));

const MODIFIERS: Modifier[] = [
	{ pattern: /\b(owner|assign|responsible|who is)\b/, has: (c) => hasName(c, 'owner', 'paid by', 'assigned'), column: () => col('Owner', 'text'), note: 'Added Owner because you mentioned who is responsible.' },
	{ pattern: /\b(due|deadline|by when)\b/, has: (c) => hasName(c, 'due', 'close date'), column: () => col('Due Date', 'date'), note: 'Added Due Date because you mentioned a deadline.' },
	{ pattern: /\bpriorit/, has: (c) => hasName(c, 'priority'), column: () => choice('Priority', [['Low', 'slate'], ['Medium', 'amber'], ['High', 'red']], 'Medium'), note: 'Added Priority with Low, Medium and High.' },
	{ pattern: /\b(note|comment)/, has: (c) => hasName(c, 'note', 'comment'), column: () => col('Notes', 'text'), note: 'Added Notes for comments.' },
	{ pattern: /\b(amount|cost|price|value|budget|spend|revenue)\b/, has: (c) => c.some((column) => column.data_type === 'currency'), column: () => col('Amount', 'currency', { currency: 'USD' }), note: 'Added Amount as a Currency column.' },
	{ pattern: /\b(link|url|website)\b/, has: (c) => c.some((column) => column.data_type === 'uri'), column: () => col('Link', 'uri'), note: 'Added Link as a URL column.' },
	{ pattern: /\b(email)\b/, has: (c) => hasName(c, 'email'), column: () => col('Email', 'text'), note: 'Added Email.' }
];

function scoreTemplate(template: Template, words: string[]): number {
	return template.keywords.reduce((score, keyword) => score + (words.some((word) => word.startsWith(keyword)) ? 1 : 0), 0);
}

export function describeSheet(prompt: string): SheetDraft {
	const text = normalizeText(prompt);
	const words = text.split(' ');
	const notes: string[] = [];

	const ranked = TEMPLATES.map((template) => ({ template, score: scoreTemplate(template, words) })).sort((a, b) => b.score - a.score);
	const best = ranked[0].score > 0 ? ranked[0].template : null;

	let name: string;
	let description: string;
	let columns: NewColumnInput[];

	if (best) {
		name = best.name;
		description = best.description;
		columns = best.columns();
		const matched = best.keywords.find((keyword) => words.some((word) => word.startsWith(keyword)));
		notes.push(`Started from the ${best.name} layout because you mentioned “${matched}”.`);
	} else {
		const subject = prompt.match(
			/(?:track|manage|log|list|record|monitor|organi[sz]e|keep)\s+(?:of\s+)?(?:my |our |the |all )?([a-z][a-z\s-]{2,40}?)(?:[,.:;]| with| and| including| for| so|$)/i
		)?.[1];
		const cleanSubject = subject?.trim();
		name = cleanSubject ? titleCase(cleanSubject) : 'New Tracker';
		description = prompt.trim().slice(0, 200);
		const singular = cleanSubject ? titleCase(cleanSubject.replace(/s$/, '')) : 'Name';
		columns = [
			col(singular.split(' ').slice(-2).join(' ') || 'Name', 'text'),
			choice('Status', [['Not Started', 'slate'], ['In Progress', 'blue'], ['Done', 'green']], 'Not Started')
		];
		notes.push('No matching layout, so this starts with a name and a status. Add what you need.');
	}

	for (const modifier of MODIFIERS) {
		if (modifier.pattern.test(text) && !modifier.has(columns)) {
			columns.push(modifier.column());
			notes.push(modifier.note);
		}
	}

	const called = prompt.match(/(?:called|named|titled)\s+["“']?([^"”'.,\n]{2,60})["”']?/i)?.[1];
	if (called) {
		name = called.trim();
		notes.push(`Named it “${name}” as you asked.`);
	}

	if (columns.some((column) => column.settings?.column_formula)) {
		notes.push('Columns marked “column formula” are calculated for every row and can’t be typed over.');
	}
	return { name, description, columns, notes };
}
