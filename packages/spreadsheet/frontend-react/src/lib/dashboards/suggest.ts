import { columnKind } from '@/lib/reports/columns';
import type { Column } from '@/lib/types';
import { newId } from '@/lib/reports/columns';
import type { KpiWidget } from './types';

/** A sensible first KPI for a sheet: the sum of its first number column, or a row count. */
export function suggestKpi(sheetId: string, columns: Column[]): KpiWidget {
	const visible = [...columns].sort((a, b) => a.position - b.position).filter((column) => column.data_type !== 'protected');
	const numeric = visible.find((column) => columnKind(column) === 'number');
	return {
		id: newId('kpi'),
		kind: 'kpi',
		title: numeric ? `Total ${numeric.name}` : 'Row count',
		sheetId,
		column: numeric?.name ?? null,
		fn: numeric ? 'sum' : 'count',
		match: 'all',
		filters: [],
		compareDays: null,
		trendColumn: visible.find((column) => column.data_type === 'date')?.name ?? null,
		trendBucket: 'month'
	};
}
