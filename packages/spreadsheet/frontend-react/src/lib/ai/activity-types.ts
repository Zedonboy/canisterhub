/**
 * Extracted out of lib/ai/types.ts (a 358-line Phase 11/AI-panel concern)
 * because `AiFeature`/`AI_FEATURE_LABELS`/`AI_FEATURE_COST` are the only
 * pieces the credits/activity store (stores/ai-activity.ts) needs, and
 * they're self-contained (no imports) at the top of that file. The rest of
 * ai/types.ts — the AI feature request/response shapes — stays deferred to
 * Phase 11.
 */

export type AiFeature =
	| 'describe-sheet'
	| 'formula-write'
	| 'formula-explain'
	| 'formula-fix'
	| 'cleanup'
	| 'ask'
	| 'explain-sheet'
	| 'audit'
	| 'fill-column'
	| 'import'
	| 'reconcile'
	| 'anomalies'
	| 'report'
	| 'changes'
	| 'describe-report'
	| 'explain-report'
	| 'describe-dashboard'
	| 'dashboard-insight'
	| 'form-wording';

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
	'describe-sheet': 'Describe-a-sheet',
	'formula-write': 'Formula copilot · write',
	'formula-explain': 'Formula copilot · explain',
	'formula-fix': 'Formula copilot · fix',
	cleanup: 'Data cleanup',
	ask: 'Ask your sheet',
	'explain-sheet': 'Explain this sheet',
	audit: 'Formula risk audit',
	'fill-column': 'AI column',
	import: 'Import from document',
	reconcile: 'Match & reconcile',
	anomalies: 'Anomaly alerts',
	report: 'Status report',
	changes: 'What changed?',
	'describe-report': 'Describe-a-report',
	'explain-report': 'Explain this report',
	'describe-dashboard': 'Describe-a-dashboard',
	'dashboard-insight': 'Dashboard insight',
	'form-wording': 'Improve form wording'
};

/** Mock credits each request costs, charged against the monthly limit. */
export const AI_FEATURE_COST: Record<AiFeature, number> = {
	'describe-sheet': 2,
	'formula-write': 1,
	'formula-explain': 1,
	'formula-fix': 1,
	cleanup: 3,
	ask: 3,
	'explain-sheet': 2,
	audit: 4,
	'fill-column': 3,
	import: 3,
	reconcile: 4,
	anomalies: 3,
	report: 3,
	changes: 1,
	'describe-report': 2,
	'explain-report': 2,
	'describe-dashboard': 2,
	'dashboard-insight': 2,
	'form-wording': 2
};
