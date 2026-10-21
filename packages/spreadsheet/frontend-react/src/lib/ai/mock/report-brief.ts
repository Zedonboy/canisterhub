import { findAvailable, SUMMARY_LABELS } from '@/lib/reports/columns';
import type { ReportResult } from '@/lib/reports/types';
import type { ReportBrief } from '../types';
import { plural } from '../text';

/** A written summary of a report's current result — its numbers woven into prose, not recomputed. */
export function explainReport(result: ReportResult, reportName: string): ReportBrief {
	const rowCount = result.rows.length;
	if (rowCount === 0) {
		return { summary: `“${reportName}” has no matching rows right now.`, bullets: [] };
	}

	const totalsText = Object.entries(result.totals)
		.filter(([, value]) => value.text)
		.map(([name, value]) => `${SUMMARY_LABELS[value.fn]} of ${findAvailable(result.columns, name)?.label ?? name} is ${value.text}`);

	let summary = `${plural(rowCount, 'row')} match${rowCount === 1 ? 'es' : ''}${result.sheetCount > 1 ? ` across ${result.sheetCount} sheets` : ''}`;
	summary += totalsText.length ? `. ${totalsText.join('; ')}.` : '.';

	const bullets: string[] = [];
	if (result.groups && result.groups.length > 0) {
		const byCount = [...result.groups].sort((a, b) => b.rows.length - a.rows.length);
		const largest = byCount[0];
		const share = Math.round((largest.rows.length / rowCount) * 100);
		bullets.push(`“${largest.label}” is the largest group: ${plural(largest.rows.length, 'row')} (${share}% of the total).`);

		if (byCount.length > 1) {
			const smallest = byCount[byCount.length - 1];
			bullets.push(`${plural(result.groups.length, 'group')} in all; the smallest is “${smallest.label}” with ${plural(smallest.rows.length, 'row')}.`);
		}

		const summaryColumn = Object.keys(largest.summaries)[0];
		if (summaryColumn) {
			const byValue = result.groups
				.filter((group) => group.summaries[summaryColumn]?.value !== null)
				.sort((a, b) => (b.summaries[summaryColumn].value ?? 0) - (a.summaries[summaryColumn].value ?? 0));
			const top = byValue[0];
			if (top && top !== largest) {
				const label = findAvailable(result.columns, summaryColumn)?.label ?? summaryColumn;
				bullets.push(`“${top.label}” has the highest ${SUMMARY_LABELS[top.summaries[summaryColumn].fn]} of ${label}: ${top.summaries[summaryColumn].text}.`);
			}
		}
	}

	if (result.notices.length) {
		bullets.push(`Note: ${result.notices.map((notice) => `${notice.sheetName} ${notice.message}`).join(' ')}`);
	}

	return { summary, bullets: bullets.slice(0, 5) };
}
