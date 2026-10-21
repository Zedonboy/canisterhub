import { sheetRepository, type NewColumnInput } from '@/lib/storage';
import type { CellValue, OptionColor, Sheet } from '@/lib/types';

/**
 * Local example sheets with the kind of mess the AI features exist for:
 * inconsistent spellings and dates, numbers stored as text, a duplicate
 * invoice, an outlier, overdue work, and two sheets that need reconciling.
 */

type DemoValue = CellValue | undefined;

interface DemoSheet {
	name: string;
	description: string;
	columns: NewColumnInput[];
	/** Row values by column name; `depth: 1` rows are nested under the row above. */
	rows: Array<Record<string, DemoValue> & { depth?: number }>;
}

const f = (formula: string) => ({ formula, value: null });
const text = (name: string, settings: NewColumnInput['settings'] = {}): NewColumnInput => ({ name, data_type: 'text', settings });
const typed = (name: string, data_type: NewColumnInput['data_type'], settings: NewColumnInput['settings'] = {}): NewColumnInput => ({ name, data_type, settings });
const choice = (name: string, options: Array<[string, OptionColor]>): NewColumnInput => ({
	name,
	data_type: 'enum',
	settings: { options: options.map(([value, color]) => ({ value, color })) }
});

const OUTSTANDING = '=IF([Status] = "Paid", 0, [Amount])';

const DEMO_SHEETS: DemoSheet[] = [
	{
		name: 'Supplier Invoices (AI demo)',
		description: 'Messy supplier invoices: duplicate spellings, mixed date formats, statuses typed by hand.',
		columns: [
			text('Supplier'),
			text('Invoice No.'),
			typed('Amount', 'currency', { currency: 'USD' }),
			typed('Issue Date', 'date', { column_group: 'Dates' }),
			typed('Due Date', 'date', { column_group: 'Dates' }),
			choice('Status', [['Unpaid', 'amber'], ['Paid', 'green'], ['Disputed', 'red']]),
			text('Outstanding', { format: 'currency', currency: 'USD' }),
			text('Notes')
		],
		rows: [
			{ Supplier: 'Acme Ltd', 'Invoice No.': 'AC-1042', Amount: 1250, 'Issue Date': '2026-07-02', 'Due Date': '2026-08-01', Status: 'Paid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'ACME Limited', 'Invoice No.': 'AC-1057', Amount: '1,480.00', 'Issue Date': '14/07/2026', 'Due Date': '13/08/2026', Status: 'paid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Zenith Logistics', 'Invoice No.': 'ZL-118', Amount: 2410.75, 'Issue Date': '2026-07-03', 'Due Date': '2026-08-02', Status: 'Paid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Brightway Office Supplies', 'Invoice No.': 'BW-2250', Amount: 845.5, 'Issue Date': '5 Jul 2026', 'Due Date': '4 Aug 2026', Status: 'PAID', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Kora Tech Inc', 'Invoice No.': 'KT-5510', Amount: 3200, 'Issue Date': '2026-08-02', 'Due Date': '2026-09-01', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Kora Tech', 'Invoice No.': 'KT-5510', Amount: 3200, 'Issue Date': '2026-08-02', 'Due Date': '2026-09-01', Status: 'Unpaid', Outstanding: f(OUTSTANDING), Notes: 'Received twice?' },
			{ Supplier: 'Acme Ltd.', 'Invoice No.': 'AC-1063', Amount: 990, 'Issue Date': '03/08/2026', 'Due Date': '02/09/2026', Status: 'unpaid ', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'zenith logistics ', 'Invoice No.': 'ZL-124', Amount: '2,105.00', 'Issue Date': '2026-08-04', 'Due Date': '2026-09-03', Status: 'Outstanding', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Lagos Power Co', 'Invoice No.': 'LP-7781', Amount: 612.4, 'Issue Date': '2026-08-06', 'Due Date': '2026-08-20', Status: 'Paid', Outstanding: 0 },
			{ Supplier: 'Harbour Freight Services', 'Invoice No.': 'HF-0091', Amount: 48500, 'Issue Date': '2026-08-07', 'Due Date': '2026-10-06', Status: 'Disputed', Outstanding: f(OUTSTANDING), Notes: 'Quote was 4,850' },
			{ Supplier: 'Brightway Office Supply', 'Invoice No.': 'BW-2271', Amount: 1120, 'Issue Date': '08/10/2026', 'Due Date': '2026-09-09', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Acme Ltd', 'Invoice No.': 'AC-1071', Amount: 1310, 'Issue Date': '2026-08-12', 'Due Date': '2026-09-11', Status: 'settled', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Zenith Logistics', 'Invoice No.': 'ZL-131', Amount: 2250, 'Issue Date': '2026-08-14', 'Due Date': '2026-09-13', Status: 'Unpaid', Outstanding: f('=[Amount] - 100') },
			{ Supplier: 'Kora Tech Inc', 'Invoice No.': 'KT-5524', Amount: 980, 'Issue Date': '2026-08-16', 'Due Date': '2026-09-15', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Acme Ltd', 'Invoice No.': 'AC-1080', Amount: 1275, 'Issue Date': '18 August 2026', 'Due Date': '2026-09-17', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'ACME Limited', 'Invoice No.': 'AC-1084', Amount: 1190, 'Issue Date': '2026-08-20', 'Due Date': '2026-09-19', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Brightway Office Supplies', 'Invoice No.': 'BW-2283', Amount: 760.25, 'Issue Date': '2026-08-21', 'Due Date': '2026-09-20', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Lagos Power Co', 'Invoice No.': 'LP-7802', Amount: 640.1, 'Issue Date': '2026-08-22', 'Due Date': '2026-09-05', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Harbour Freight Services', 'Invoice No.': 'HF-0097', Amount: 4180, 'Issue Date': '2026-08-25', 'Due Date': '2026-10-24', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Kora Tech', 'Invoice No.': 'KT-5539', Amount: 3050, 'Issue Date': '2026-08-27', 'Due Date': '2026-09-26', Status: 'Disputed', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Brightway Office Supplies', 'Invoice No.': 'BW-2290', Amount: 915, 'Issue Date': '2026-08-29', 'Due Date': '2026-09-28', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Zenith Logistics', 'Invoice No.': 'ZL-140', Amount: 2330, 'Issue Date': '2026-09-01', 'Due Date': '2026-10-01', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'Acme Ltd', 'Invoice No.': 'AC-1092', Amount: 1405, 'Issue Date': '2026-09-03', 'Due Date': '2026-10-03', Status: 'Unpaid', Outstanding: f(OUTSTANDING) },
			{ Supplier: 'TOTAL', Outstanding: f('=SUM([Outstanding]1:[Outstanding]23)') }
		]
	},
	{
		name: 'Expenses — August (AI demo)',
		description: 'Card transactions exported from the bank, waiting to be categorised.',
		columns: [
			text('Description'),
			typed('Date', 'date'),
			typed('Amount', 'currency', { currency: 'USD' }),
			choice('Category', [['Travel', 'blue'], ['Software', 'violet'], ['Office', 'amber'], ['Meals', 'orange'], ['Utilities', 'teal'], ['Other', 'slate']]),
			text('Merchant')
		],
		rows: [
			['UBER *TRIP LAGOS 0802', '2026-08-02', 18.4],
			['AWS EMEA SARL 0803', '2026-08-03', 212.77],
			['CAFE NEO VI LUNCH', '2026-08-04', 24.5],
			['MTN DATA BUNDLE 20GB', '2026-08-05', 35],
			['SLACK TECHNOLOGIES LLC', '2026-08-06', 96],
			['OFFICEMATE STATIONERY IKEJA', '2026-08-07', 58.3],
			['BOLT RIDE LEKKI', '2026-08-08', 9.8],
			['GITHUB INC SUBSCRIPTION', '2026-08-09', 44],
			['IKEJA ELECTRIC PREPAID', '2026-08-10', 120],
			['CHICKEN REPUBLIC VI', '2026-08-11', 16.25],
			['AIR PEACE LOS-ABV FLIGHT', '2026-08-12', 245],
			['HILTON LAGOS CONFERENCE HALL', '2026-08-13', 9800],
			['GOOGLE WORKSPACE', '2026-08-14', 72],
			['SPECTRANET INTERNET', '2026-08-15', 60],
			['PRINTER TONER - OFFICEMATE', '2026-08-18', 88],
			['DOMINOS PIZZA TEAM LUNCH', '2026-08-19', 64.9],
			['FIGMA MONTHLY', '2026-08-20', 45],
			['UBER *TRIP IKOYI', '2026-08-21', 12.6],
			['POS SHOPRITE LEKKI', '2026-08-22', 41.15],
			['ZOOM VIDEO COMMUNICATIONS', '2026-08-25', 15.99]
		].map(([Description, Date, Amount]) => ({ Description, Date, Amount }))
	},
	{
		name: 'Bank Statement — August (AI demo)',
		description: 'Business account export. Payments are negative.',
		columns: [text('Description'), typed('Date', 'date'), typed('Amount', 'currency', { currency: 'USD' }), text('Reconciled')],
		rows: [
			['TRF ACME LTD LAGOS NG', '2026-08-03', -1250],
			['TRF ZENITH LOGISTICS', '2026-08-05', -2410.75],
			['POS BRIGHTWAY OFFICE', '2026-08-06', -845.5],
			['LAGOS POWER CO PREPAY', '2026-08-21', -612.4],
			['TRF ACME LIMITED', '2026-08-15', -1480],
			['KORA TECH INC WEB PMT', '2026-09-02', -3200],
			['MONTHLY ACCOUNT FEE', '2026-08-31', -12.5],
			['TRF HARBOUR FREIGHT', '2026-08-10', -4850],
			['INWARD TRF FROM UNKNOWN', '2026-08-18', 700],
			['TRF ACME LTD', '2026-09-12', -1310]
		].map(([Description, Date, Amount]) => ({ Description, Date, Amount }))
	},
	{
		name: 'Ledger — August (AI demo)',
		description: 'Payments recorded by the accounts team.',
		columns: [
			text('Payee'),
			text('Reference'),
			typed('Date', 'date'),
			typed('Amount', 'currency', { currency: 'USD' }),
			choice('Account', [['Suppliers', 'blue'], ['Utilities', 'teal'], ['Logistics', 'orange']]),
			typed('Bank Account No.', 'protected')
		],
		rows: [
			{ Payee: 'Acme Ltd', Reference: 'AC-1042', Date: '2026-08-01', Amount: 1250, Account: 'Suppliers', 'Bank Account No.': '0123456789' },
			{ Payee: 'Zenith Logistics', Reference: 'ZL-118', Date: '2026-08-04', Amount: 2410.75, Account: 'Logistics', 'Bank Account No.': '2233445566' },
			{ Payee: 'Brightway Office Supplies', Reference: 'BW-2250', Date: '2026-08-06', Amount: 845.5, Account: 'Suppliers', 'Bank Account No.': '9988776655' },
			{ Payee: 'Lagos Power Co', Reference: 'LP-7781', Date: '2026-08-20', Amount: 612.4, Account: 'Utilities', 'Bank Account No.': '1122334455' },
			{ Payee: 'ACME Limited', Reference: 'AC-1057', Date: '2026-08-13', Amount: 1480, Account: 'Suppliers', 'Bank Account No.': '0123456789' },
			{ Payee: 'Kora Tech Inc', Reference: 'KT-5510', Date: '2026-09-01', Amount: 3200, Account: 'Suppliers', 'Bank Account No.': '5566778899' },
			{ Payee: 'Harbour Freight Services', Reference: 'HF-0091', Date: '2026-08-09', Amount: 4850, Account: 'Logistics', 'Bank Account No.': '6677889900' },
			{ Payee: 'Acme Ltd', Reference: 'AC-1071', Date: '2026-09-11', Amount: 1310, Account: 'Suppliers', 'Bank Account No.': '0123456789' },
			{ Payee: 'Brightway Office Supplies', Reference: 'BW-2271 (cheque)', Date: '2026-09-09', Amount: 1120, Account: 'Suppliers', 'Bank Account No.': '9988776655' }
		]
	},
	{
		name: 'Office Move Plan (AI demo)',
		description: 'Nested project plan: phases with tasks, owners, budgets and due dates.',
		columns: [
			text('Task'),
			text('Owner'),
			choice('Status', [['Not Started', 'slate'], ['In Progress', 'blue'], ['Blocked', 'red'], ['Done', 'green']]),
			typed('Due Date', 'date'),
			typed('Budget', 'currency', { currency: 'USD', column_group: 'Spend' }),
			typed('Actual', 'currency', { currency: 'USD', column_group: 'Spend' })
		],
		rows: [
			{ Task: 'Phase 1 · Find the space', Budget: f('=SUM(CHILDREN([Budget]))'), Actual: f('=SUM(CHILDREN([Actual]))') },
			{ depth: 1, Task: 'Shortlist three buildings', Owner: 'Ada Okafor', Status: 'Done', 'Due Date': '2026-07-10', Budget: 500, Actual: 450 },
			{ depth: 1, Task: 'Negotiate the lease', Owner: 'Mateo Silva', Status: 'Done', 'Due Date': '2026-08-01', Budget: 2000, Actual: 2600 },
			{ depth: 1, Task: 'Legal review of lease', Owner: 'Priya Raman', Status: 'In Progress', 'Due Date': '2026-08-20', Budget: 1500, Actual: 900 },
			{ Task: 'Phase 2 · Fit-out', Budget: f('=SUM(CHILDREN([Budget]))'), Actual: f('=SUM(CHILDREN([Actual]))') },
			{ depth: 1, Task: 'Floor plan and seating', Owner: 'Hana Sato', Status: 'Done', 'Due Date': '2026-08-15', Budget: 1200, Actual: 1150 },
			{ depth: 1, Task: 'Install network cabling', Owner: 'Jonas Berg', Status: 'Blocked', 'Due Date': '2026-09-05', Budget: 6500, Actual: 3100 },
			{ depth: 1, Task: 'Order furniture', Owner: 'Lena Fischer', Status: 'In Progress', 'Due Date': '2026-09-10', Budget: 9000, Actual: 4200 },
			{ depth: 1, Task: 'Meeting room AV', Owner: 'Jonas Berg', Status: 'Not Started', 'Due Date': '2026-09-30', Budget: 4000 },
			{ Task: 'Phase 3 · Move in', Budget: f('=SUM(CHILDREN([Budget]))'), Actual: f('=SUM(CHILDREN([Actual]))') },
			{ depth: 1, Task: 'Book movers', Owner: 'Omar Haddad', Status: 'Not Started', 'Due Date': '2026-10-01', Budget: 2500 },
			{ depth: 1, Task: 'Label and pack desks', Owner: 'Chiamaka Eze', Status: 'Not Started', 'Due Date': '2026-10-08', Budget: 300 },
			{ depth: 1, Task: 'Move day', Owner: 'Ada Okafor', Status: 'Not Started', 'Due Date': '2026-10-15', Budget: 1800 }
		]
	}
];

export const DEMO_SHEET_NAMES = DEMO_SHEETS.map((sheet) => sheet.name);

/** Creates any demo sheets that don't exist yet. Returns the sheets created. */
export async function createDemoSheets(): Promise<Sheet[]> {
	const existing = new Set((await sheetRepository.listSheets(undefined, ['local'])).map((sheet) => sheet.name));
	const created: Sheet[] = [];

	for (const demo of DEMO_SHEETS) {
		if (existing.has(demo.name)) continue;
		const sheet = await sheetRepository.createSheet({ name: demo.name, description: demo.description, columns: demo.columns });
		const keys = new Map((await sheetRepository.listColumns(sheet.id)).map((column) => [column.name, column.key]));

		const rows = demo.rows.map(({ depth: _depth, ...values }) => {
			const data: Record<string, CellValue> = {};
			for (const [name, value] of Object.entries(values)) {
				const key = keys.get(name);
				if (key && value !== undefined) data[key] = value;
			}
			return data;
		});
		const inserted = await sheetRepository.insertRows(sheet.id, { count: rows.length, rows, label: 'Load demo data' });
		const nested = inserted.filter((_, index) => (demo.rows[index].depth ?? 0) > 0).map((row) => row.id);
		if (nested.length > 0) await sheetRepository.indentRows(sheet.id, nested);
		created.push(await sheetRepository.getSheet(sheet.id));
	}
	return created;
}
