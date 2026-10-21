import type { DashboardInsight, DashboardWidgetSummary } from '../types';

/** A written paragraph stitching together a dashboard's KPI tiles — their numbers, already
 *  computed, not recalculated here. */
export function dashboardInsight(dashboardName: string, widgets: DashboardWidgetSummary[]): DashboardInsight {
	if (widgets.length === 0) {
		return { summary: `“${dashboardName}” has no KPI tiles yet, so there’s nothing to summarise.`, bullets: [] };
	}

	const headline = widgets
		.slice(0, 3)
		.map((widget) => `${widget.title.toLowerCase()} is ${widget.text}`)
		.join(', ');
	const summary = `${headline}.`;

	const withChange = widgets.filter((widget) => widget.changePct !== null);
	const risers = [...withChange].filter((widget) => (widget.changePct ?? 0) > 0).sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
	const fallers = [...withChange].filter((widget) => (widget.changePct ?? 0) < 0).sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));
	const flat = withChange.filter((widget) => widget.changePct === 0);

	const bullets: string[] = [];
	if (risers[0]) {
		bullets.push(
			`${risers[0].title} is up ${Math.round((risers[0].changePct ?? 0) * 100)}%${risers[0].compareLabel ? ` ${risers[0].compareLabel}` : ''}, from ${risers[0].compareText}.`
		);
	}
	if (fallers[0]) {
		bullets.push(
			`${fallers[0].title} is down ${Math.abs(Math.round((fallers[0].changePct ?? 0) * 100))}%${fallers[0].compareLabel ? ` ${fallers[0].compareLabel}` : ''}, from ${fallers[0].compareText}.`
		);
	}
	if (flat.length) bullets.push(`${flat.map((widget) => widget.title).join(', ')} ${flat.length === 1 ? 'is' : 'are'} unchanged.`);
	if (!withChange.length) bullets.push('No tiles here have a comparison set, so there’s no trend to call out yet.');

	return { summary, bullets: bullets.slice(0, 4) };
}
