import { columnKind } from '@/lib/reports/columns';
import { newId } from '@/lib/utils/id';
import type { Column } from '@/lib/types';
import type { ChartDefinition, ChartSeries } from './types';

/** Kept separate from chart execution so sheet actions can suggest a chart cheaply. */

/** A sensible first chart for a sheet: a summary of its first number column by an option, date or name column. */
export function suggestChart(columns: Column[]): Pick<ChartDefinition, 'type' | 'category' | 'dateBucket' | 'series' | 'sort' | 'limit' | 'name'> {
	const visible = [...columns].sort((a, b) => a.position - b.position).filter((column) => column.data_type !== 'protected');
	const category =
		visible.find((column) => column.data_type === 'enum') ??
		visible.find((column) => column.data_type === 'date') ??
		visible.find((column) => column.settings.primary) ??
		visible.find((column) => column.data_type === 'text');
	const numeric = visible.find((column) => columnKind(column) === 'number' && column.key !== category?.key);
	const isDate = category?.data_type === 'date';
	const series: ChartSeries = { id: newId('series'), column: numeric?.name ?? null, fn: numeric ? 'sum' : 'count' };
	const valueLabel = numeric ? `${numeric.name}` : 'Rows';
	return {
		type: isDate ? 'line' : 'bar',
		category: category?.name ?? null,
		dateBucket: 'month',
		series: [series],
		sort: isDate ? 'category' : 'value-desc',
		limit: isDate ? null : 12,
		name: category ? `${valueLabel} by ${category.name}` : valueLabel
	};
}
