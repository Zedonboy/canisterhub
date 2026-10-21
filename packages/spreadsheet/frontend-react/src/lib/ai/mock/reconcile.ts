import type { ReconcileMatch, ReconcileResult, ReconcileSide } from '../types';
import { parseLooseDate, similarity, tokenOverlap } from '../text';
import { cellNumber, cellText } from './shared';

function dayNumber(text: string): number | null {
	const date = parseLooseDate(text);
	if (!date) return null;
	const [year, month, day] = date.iso.split('-').map(Number);
	return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function reconcile(left: ReconcileSide, right: ReconcileSide, dayWindow = 3): ReconcileResult {
	const read = (side: ReconcileSide) =>
		side.rows
			.map((row) => ({
				id: row.id,
				amount: cellNumber(row.data[side.amountKey]),
				day: side.dateKey ? dayNumber(cellText(row.data[side.dateKey])) : null,
				name: cellText(row.data[side.nameKey])
			}))
			.filter((row) => row.amount !== null && row.amount !== 0);

	const lefts = read(left);
	const rights = read(right);
	const candidates: ReconcileMatch[] = [];

	for (const a of lefts) {
		for (const b of rights) {
			if (Math.abs(Math.abs(a.amount!) - Math.abs(b.amount!)) > 0.01) continue;
			const reasons = [`Same amount, ${Math.abs(a.amount!).toLocaleString(undefined, { minimumFractionDigits: 2 })}`];
			let score = 0.55;

			if (a.day !== null && b.day !== null) {
				const gap = Math.abs(a.day - b.day);
				if (gap > dayWindow * 3) continue;
				if (gap <= dayWindow) {
					score += 0.25 * (1 - gap / (dayWindow + 1));
					reasons.push(gap === 0 ? 'Same date' : `${gap} ${gap === 1 ? 'day' : 'days'} apart`);
				} else {
					score -= 0.1;
					reasons.push(`${gap} days apart, outside the ${dayWindow}-day window`);
				}
			}

			const nameScore = Math.max(tokenOverlap(a.name, b.name), similarity(a.name, b.name));
			if (nameScore >= 0.5) {
				score += 0.2 * nameScore;
				reasons.push(`Names look alike (${Math.round(nameScore * 100)}%)`);
			} else {
				score -= 0.05;
			}
			if (score >= 0.6) candidates.push({ leftId: a.id, rightId: b.id, score: Math.min(0.99, score), reasons });
		}
	}

	candidates.sort((x, y) => y.score - x.score);
	const usedLeft = new Set<string>();
	const usedRight = new Set<string>();
	const matches: ReconcileMatch[] = [];
	for (const candidate of candidates) {
		if (usedLeft.has(candidate.leftId) || usedRight.has(candidate.rightId)) continue;
		usedLeft.add(candidate.leftId);
		usedRight.add(candidate.rightId);
		matches.push(candidate);
	}

	return {
		matches,
		unmatchedLeft: left.rows.filter((row) => !usedLeft.has(row.id) && cellNumber(row.data[left.amountKey])).map((row) => row.id),
		unmatchedRight: right.rows.filter((row) => !usedRight.has(row.id) && cellNumber(row.data[right.amountKey])).map((row) => row.id)
	};
}
