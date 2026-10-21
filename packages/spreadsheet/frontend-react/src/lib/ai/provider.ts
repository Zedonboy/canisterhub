import type { AvailableColumn, ReportResult } from '@/lib/reports/types';
import type { Column, Sheet } from '@/lib/types';
import { askSheet } from './mock/ask';
import { findAnomalies } from './mock/anomalies';
import { auditFormulas } from './mock/audit';
import { summarizeChanges } from './mock/changes';
import { fillColumn } from './mock/classify';
import { cleanColumn, type CleanupCell } from './mock/cleanup';
import { draftDashboard } from './mock/dashboard-draft';
import { dashboardInsight } from './mock/dashboard-insight';
import { describeSheet } from './mock/describe';
import { explainSheet } from './mock/explain-sheet';
import { extractRows } from './mock/extract';
import { explainFormula, fixFormula, writeFormula } from './mock/formula';
import { improveWording, type WordingField } from './mock/form-wording';
import { reconcile } from './mock/reconcile';
import { statusReport } from './mock/report';
import { explainReport } from './mock/report-brief';
import { draftReportQuery } from './mock/report-draft';
import { delay, hashString } from './text';
import type {
	AskAnswer,
	AuditFinding,
	ChangeSummary,
	CleanupResult,
	ContextRow,
	DashboardDraft,
	DashboardInsight,
	DashboardWidgetSummary,
	ExtractResult,
	FillRequest,
	FillResult,
	FormulaExplanation,
	FormulaFix,
	FormulaSuggestion,
	FormWording,
	Insight,
	ReconcileResult,
	ReconcileSide,
	ReportBrief,
	ReportDraft,
	SheetBrief,
	SheetChangeEntry,
	SheetContext,
	SheetDraft,
	SheetTools,
	StatusReport
} from './types';

/**
 * Everything IntelliSheet asks of an AI model. The UI only talks to this interface,
 * so the mock below can be replaced by a provider that relays to Claude
 * through the IntelliSheet API without changing any component.
 */
export interface AiProvider {
	readonly name: string;
	/** True for canned or rule-based results; the UI labels them "Mock AI". */
	readonly mock: boolean;
	describeSheet(prompt: string): Promise<SheetDraft>;
	writeFormula(prompt: string, columns: Column[], target?: Column): Promise<FormulaSuggestion>;
	explainFormula(formula: string, columns: Column[]): Promise<FormulaExplanation>;
	fixFormula(formula: string, errorCode: string | null, columns: Column[]): Promise<FormulaFix | null>;
	cleanColumn(column: Column, cells: CleanupCell[]): Promise<CleanupResult>;
	ask(question: string, context: SheetContext, tools: SheetTools): Promise<AskAnswer>;
	explainSheet(context: SheetContext): Promise<SheetBrief>;
	audit(context: SheetContext): Promise<AuditFinding[]>;
	fillColumn(request: FillRequest, rows: ContextRow[], target: Column): Promise<FillResult>;
	extractRows(document: string, columns: Column[]): Promise<ExtractResult>;
	reconcile(left: ReconcileSide, right: ReconcileSide, dayWindow?: number): Promise<ReconcileResult>;
	findAnomalies(context: SheetContext): Promise<Insight[]>;
	statusReport(context: SheetContext, tools: SheetTools): Promise<StatusReport>;
	summarizeChanges(entries: SheetChangeEntry[], since: string): Promise<ChangeSummary>;
	draftReportQuery(prompt: string, available: AvailableColumn[]): Promise<ReportDraft>;
	explainReport(result: ReportResult, reportName: string): Promise<ReportBrief>;
	draftDashboard(prompt: string, sheet: Sheet, columns: Column[]): Promise<DashboardDraft>;
	dashboardInsight(dashboardName: string, widgets: DashboardWidgetSummary[]): Promise<DashboardInsight>;
	improveFormWording(formName: string, fields: WordingField[]): Promise<FormWording>;
}

/** Simulated model latency: 450–1,150ms, stable for the same input. */
function thinking(seed: string, extra = 0): Promise<void> {
	return delay(450 + (hashString(seed) % 700) + extra);
}

export const mockAiProvider: AiProvider = {
	name: 'Mock AI',
	mock: true,
	async describeSheet(prompt) {
		await thinking(prompt);
		return describeSheet(prompt);
	},
	async writeFormula(prompt, columns, target) {
		await thinking(prompt);
		return writeFormula(prompt, columns, target);
	},
	async explainFormula(formula, columns) {
		await thinking(formula, -200);
		return explainFormula(formula, columns);
	},
	async fixFormula(formula, errorCode, columns) {
		await thinking(formula, -100);
		return fixFormula(formula, errorCode, columns);
	},
	async cleanColumn(column, cells) {
		await thinking(column.key, 300);
		return cleanColumn(column, cells);
	},
	async ask(question, context, tools) {
		await thinking(question);
		return askSheet(question, context, tools);
	},
	async explainSheet(context) {
		await thinking(context.sheetId, 400);
		return explainSheet(context);
	},
	async audit(context) {
		await thinking(context.sheetId, 500);
		return auditFormulas(context);
	},
	async fillColumn(request, rows, target) {
		await thinking(request.instruction, Math.min(1_500, rows.length * 4));
		return fillColumn(request, rows, target);
	},
	async extractRows(document, columns) {
		await thinking(document, 300);
		return extractRows(document, columns);
	},
	async reconcile(left, right, dayWindow) {
		await thinking(`${left.label}${right.label}`, 400);
		return reconcile(left, right, dayWindow);
	},
	async findAnomalies(context) {
		await thinking(context.sheetId, 300);
		return findAnomalies(context);
	},
	async statusReport(context, tools) {
		await thinking(context.sheetId, 400);
		return statusReport(context, tools);
	},
	async summarizeChanges(entries, since) {
		await thinking(since, -150);
		return summarizeChanges(entries, since);
	},
	async draftReportQuery(prompt, available) {
		await thinking(prompt);
		return draftReportQuery(prompt, available);
	},
	async explainReport(result, reportName) {
		await thinking(reportName, 300);
		return explainReport(result, reportName);
	},
	async draftDashboard(prompt, sheet, columns) {
		await thinking(prompt);
		return draftDashboard(prompt, sheet, columns);
	},
	async dashboardInsight(dashboardName, widgets) {
		await thinking(dashboardName, 400);
		return dashboardInsight(dashboardName, widgets);
	},
	async improveFormWording(formName, fields) {
		await thinking(formName, 200);
		return improveWording(formName, fields);
	}
};

/** The provider the app uses. Swap for a Claude relay provider when the API endpoint exists. */
export const ai: AiProvider = mockAiProvider;
