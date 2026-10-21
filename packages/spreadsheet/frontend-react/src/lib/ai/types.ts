import type { ReportFilterOp, SummaryFunction } from '@/lib/reports/types';
import type { CellUpdate, NewColumnInput, SheetChangeEntry } from '@/lib/storage';
import type {
	AggregateOperation,
	AggregateResponse,
	CellValue,
	Column,
	RowData,
	RowPage,
	RowQueryParams,
	SheetSource
} from '@/lib/types';

// AiFeature/AI_FEATURE_LABELS/AI_FEATURE_COST live in ./activity-types (pulled forward in
// Phase 2a for stores/ai-activity.ts, before the rest of this file existed) — re-exported
// here so this stays the single import surface the rest of the AI subsystem expects.
export type { AiFeature } from './activity-types';
export { AI_FEATURE_LABELS, AI_FEATURE_COST } from './activity-types';

export type ContextRow = Pick<RowData, 'id' | 'parent_id' | 'position' | 'depth' | 'has_children' | 'data'>;

/**
 * What the model sees of a sheet: its schema and a sample of rows with
 * Protected values masked. Anything more it asks for through `SheetTools`.
 */
export interface SheetContext {
	sheetId: string;
	name: string;
	description: string | null;
	source: SheetSource;
	writable: boolean;
	rowCount: number;
	columns: Column[];
	rows: ContextRow[];
	/** True when `rows` is a sample rather than the whole sheet. */
	sampled: boolean;
}

/** Read-only queries the model may run, backed by the sheet's storage adapter. */
export interface SheetTools {
	queryRows(params: RowQueryParams): Promise<RowPage>;
	aggregate(operation: AggregateOperation, columnKey: string, parentId?: string): Promise<AggregateResponse>;
}

/** A row the UI can jump to. */
export interface RowLink {
	id: string;
	position: number;
	label: string;
}

export type Severity = 'high' | 'medium' | 'low';

// -- Describe-a-sheet ----------------------------------------------------------------

export interface SheetDraft {
	name: string;
	description: string;
	columns: NewColumnInput[];
	/** What the AI assumed, shown under the draft. */
	notes: string[];
}

// -- Formula copilot -------------------------------------------------------------------

export interface FormulaSuggestion {
	formula: string;
	explanation: string;
	warnings: string[];
}

export interface FormulaExplanation {
	summary: string;
	steps: string[];
}

export interface FormulaFix {
	formula: string;
	reason: string;
}

// -- Data cleanup ------------------------------------------------------------------------

export interface CleanupProposal {
	id: string;
	kind: 'merge' | 'date' | 'number' | 'option' | 'whitespace';
	title: string;
	detail: string;
	/** Original spellings or values being replaced. */
	from: string[];
	/** Display text of the replacement. */
	to: string;
	updates: CellUpdate[];
}

export interface CleanupResult {
	columnKey: string;
	scanned: number;
	proposals: CleanupProposal[];
}

// -- Ask your sheet ----------------------------------------------------------------------

export interface AskStep {
	tool: string;
	args: string;
	result: string;
}

export interface AskAnswer {
	answer: string;
	steps: AskStep[];
	rows: RowLink[];
	/** Set when the answer covers only part of the matching rows. */
	caveat: string | null;
}

// -- Explain this sheet ------------------------------------------------------------------

export interface SheetBrief {
	purpose: string;
	sections: { title: string; items: string[] }[];
}

// -- Formula risk audit ------------------------------------------------------------------

export interface AuditFinding {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
	cells: { rowId: string; position: number; columnKey: string }[];
	fix?: { label: string; updates: CellUpdate[] };
}

// -- AI column ---------------------------------------------------------------------------

export interface FillRequest {
	instruction: string;
	sourceKeys: string[];
	/** Allowed answers, e.g. an enum column's options or a list typed in the instruction. */
	choices: string[];
}

export interface FillValue {
	rowId: string;
	position: number;
	input: string;
	output: string;
	confidence: number;
}

export interface FillResult {
	mode: 'categorise' | 'extract' | 'sentiment' | 'summarise';
	values: FillValue[];
}

// -- Import from document ----------------------------------------------------------------

export interface ExtractedRow {
	/** Raw text per column key, parsed per column type on insert. */
	values: Record<string, string>;
	/** Review notes per column key. */
	issues: Record<string, string>;
}

export interface ExtractResult {
	rows: ExtractedRow[];
	/** Labels in the document that matched no column. */
	unmapped: string[];
	notes: string[];
}

// -- Match & reconcile -------------------------------------------------------------------

export interface ReconcileSide {
	label: string;
	rows: ContextRow[];
	amountKey: string;
	dateKey: string | null;
	nameKey: string;
}

export interface ReconcileMatch {
	leftId: string;
	rightId: string;
	score: number;
	reasons: string[];
}

export interface ReconcileResult {
	matches: ReconcileMatch[];
	unmatchedLeft: string[];
	unmatchedRight: string[];
}

// -- Anomaly alerts ----------------------------------------------------------------------

export interface Insight {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
	rows: RowLink[];
}

// -- Status report -----------------------------------------------------------------------

export interface StatusReport {
	title: string;
	/** Plain text with blank-line separated sections, ready to edit and copy. */
	body: string;
}

// -- What changed? -----------------------------------------------------------------------

export interface ChangeSummary {
	headline: string;
	bullets: string[];
}

// -- Describe-a-report ---------------------------------------------------------------

export interface ReportDraftFilter {
	column: string;
	op: ReportFilterOp;
	value: string;
}

export interface ReportDraft {
	match: 'all' | 'any';
	filters: ReportDraftFilter[];
	groupBy: string | null;
	/** Group by days overdue rather than the exact value; only meaningful when `groupBy` names a date column. */
	aging: boolean;
	summaries: { column: string; fn: SummaryFunction }[];
	sort: { column: string; direction: 'asc' | 'desc' } | null;
	/** What the AI assumed, shown under the draft. */
	notes: string[];
}

// -- Explain this report -----------------------------------------------------------------

export interface ReportBrief {
	summary: string;
	bullets: string[];
}

// -- Describe-a-dashboard ----------------------------------------------------------------

export interface DashboardKpiDraft {
	title: string;
	/** Value column; `null` counts rows. */
	column: string | null;
	fn: SummaryFunction;
	match: 'all' | 'any';
	filters: ReportDraftFilter[];
	trendColumn: string | null;
}

export interface DashboardDraft {
	widgets: DashboardKpiDraft[];
	notes: string[];
}

// -- Dashboard insight --------------------------------------------------------------------

/** One KPI tile's current reading, already formatted — what the insight widget summarises. */
export interface DashboardWidgetSummary {
	title: string;
	text: string;
	compareLabel: string | null;
	compareText: string | null;
	/** Fraction, e.g. 0.12 for +12%; `null` when there's nothing to compare against. */
	changePct: number | null;
}

export interface DashboardInsight {
	summary: string;
	bullets: string[];
}

// -- Improve form wording -----------------------------------------------------------------

export interface FormFieldWording {
	fieldId: string;
	label: string;
	help: string;
}

export interface FormWording {
	fields: FormFieldWording[];
	confirmation: string;
	/** What the AI changed, shown before applying. */
	notes: string[];
}

export type { SheetChangeEntry, CellValue };
