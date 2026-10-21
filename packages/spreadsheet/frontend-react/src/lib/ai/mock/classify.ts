import type { Column } from '@/lib/types';
import type { ContextRow, FillRequest, FillResult } from '../types';
import { normalizeText, parseLooseDate, parseLooseNumber, similarity, titleCase, tokens } from '../text';
import { cellText } from './shared';

const LEXICON: Array<{ match: RegExp; words: string[] }> = [
	{ match: /travel|transport|trip/, words: ['uber', 'bolt', 'taxi', 'cab', 'flight', 'airline', 'airways', 'air peace', 'arik', 'hotel', 'hilton', 'marriott', 'trip', 'train', 'fuel', 'petrol', 'total energies', 'parking', 'toll'] },
	{ match: /software|saas|subscription|tech/, words: ['aws', 'amazon web', 'github', 'google', 'microsoft', 'slack', 'adobe', 'zoom', 'notion', 'figma', 'atlassian', 'jira', 'subscription', 'saas', 'licen', 'dropbox', 'openai', 'anthropic', 'heroku', 'vercel'] },
	{ match: /office|supplies|stationery/, words: ['stationery', 'paper', 'printer', 'ink', 'toner', 'chair', 'desk', 'office', 'supplies', 'officemate', 'staples', 'pens'] },
	{ match: /meal|food|entertain|restaurant/, words: ['restaurant', 'cafe', 'coffee', 'lunch', 'dinner', 'food', 'chicken', 'pizza', 'eatery', 'kitchen', 'dominos', 'kfc', 'cafe neo', 'starbucks'] },
	{ match: /utilit|power|telecom/, words: ['electric', 'electricity', 'power', 'internet', 'wifi', 'mtn', 'airtel', 'glo', '9mobile', 'water', 'dstv', 'spectranet', 'airtime', 'data bundle'] },
	{ match: /market|advert|promo/, words: ['ads', 'facebook', 'meta', 'instagram', 'campaign', 'promo', 'billboard', 'linkedin'] },
	{ match: /grocer|supermarket|household/, words: ['shoprite', 'spar', 'market', 'grocer', 'supermarket', 'justrite'] },
	{ match: /payroll|salar|wage/, words: ['salary', 'payroll', 'wages', 'bonus'] },
	{ match: /rent|lease|facilit/, words: ['rent', 'lease', 'service charge', 'facility'] },
	{ match: /equipment|hardware/, words: ['laptop', 'monitor', 'hardware', 'dell', 'hp ', 'lenovo', 'apple store', 'keyboard'] }
];

const POSITIVE = ['great', 'good', 'excellent', 'happy', 'love', 'thanks', 'thank', 'resolved', 'fast', 'helpful', 'perfect', 'pleased', 'recommend'];
const NEGATIVE = ['bad', 'late', 'broken', 'angry', 'refund', 'poor', 'slow', 'issue', 'problem', 'complaint', 'cancel', 'terrible', 'disappointed', 'wrong', 'missing', 'damaged'];

function inputText(row: ContextRow, sourceKeys: string[]): string {
	return sourceKeys.map((key) => cellText(row.data[key])).filter(Boolean).join(' · ');
}

/** Categories typed in the instruction after a colon, e.g. "Category: Travel, Software, Other". */
export function choicesFromInstruction(instruction: string): string[] {
	const list = instruction.split(':').slice(1).join(':');
	return list
		.split(/,|\bor\b|\//)
		.map((item) => item.replace(/["“”.]/g, '').trim())
		.filter((item) => item.length > 0 && item.length < 40);
}

function categorise(text: string, choices: string[]): { output: string; confidence: number } {
	const haystack = ` ${normalizeText(text)} `;
	let best = { output: '', score: 0 };
	for (const choice of choices) {
		const lexicon = LEXICON.find((entry) => entry.match.test(normalizeText(choice)));
		let score = 0;
		for (const word of lexicon?.words ?? []) if (haystack.includes(normalizeText(word)) || haystack.includes(` ${normalizeText(word)}`)) score += 2;
		for (const word of tokens(choice)) if (word.length > 3 && haystack.includes(word)) score += 1.5;
		if (score > best.score) best = { output: choice, score };
	}
	if (best.score > 0) return { output: best.output, confidence: Math.min(0.97, 0.6 + best.score * 0.1) };
	const fallback = choices.find((choice) => /other|misc|general|uncategor/i.test(choice));
	return { output: fallback ?? '', confidence: fallback ? 0.35 : 0 };
}

function extract(text: string, instruction: string): { output: string; confidence: number } {
	const want = normalizeText(instruction);
	if (/email/.test(want)) {
		const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
		return { output: email ?? '', confidence: email ? 0.95 : 0 };
	}
	if (/phone|mobile|number/.test(want) && !/invoice|order/.test(want)) {
		const phone = text.match(/(\+?\d[\d\s-]{7,}\d)/)?.[0];
		return { output: phone?.trim() ?? '', confidence: phone ? 0.85 : 0 };
	}
	if (/amount|total|price|cost/.test(want)) {
		const amount = text.match(/[$₦€£]?\s?\d[\d,]*(?:\.\d{2})?/g)?.map((part) => parseLooseNumber(part)).find((value) => value !== null);
		return { output: amount === undefined || amount === null ? '' : String(amount), confidence: amount ? 0.8 : 0 };
	}
	if (/date|when/.test(want)) {
		const found = text.match(/\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/)?.[0];
		const date = found ? parseLooseDate(found) : null;
		return { output: date?.iso ?? '', confidence: date ? (date.ambiguous ? 0.6 : 0.9) : 0 };
	}
	// Vendor / merchant / company: bank descriptions like "POS UBER *TRIP LAGOS 12-03".
	const cleaned = text
		.replace(/^(pos|web|trf|transfer|payment to|pmt|card|debit|purchase)\s*[:-]?\s*/i, '')
		.split(/[*#]|\s\d|\s-\s|·/)[0]
		.replace(
			/\b(ltd|limited|inc|llc|plc|sarl|gmbh|bv|ng|lagos|abuja|vi|ikeja|ikoyi|lekki|emea|us|uk|lunch|dinner|prepaid|subscription|monthly|data|bundle|airtime|conference|hall|team|trip|ride|technologies|communications|video)\b\.?/gi,
			''
		)
		.trim();
	// Keep acronyms such as AWS and MTN in capitals.
	const acronym = (word: string) => /^[BCDFGHJKLMNPQRSTVWXZ]{2,3}$/.test(word) || ['AWS', 'IBM', 'DHL', 'KFC', 'UPS'].includes(word);
	const name = cleaned
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => (acronym(word) ? word : titleCase(word)))
		.join(' ');
	return { output: name, confidence: name ? 0.75 : 0 };
}

function sentiment(text: string): { output: string; confidence: number } {
	const words = tokens(text);
	const positive = words.filter((word) => POSITIVE.some((p) => word.startsWith(p))).length;
	const negative = words.filter((word) => NEGATIVE.some((n) => word.startsWith(n))).length;
	if (positive === negative) return { output: 'Neutral', confidence: positive === 0 ? 0.55 : 0.5 };
	return positive > negative ? { output: 'Positive', confidence: Math.min(0.95, 0.65 + positive * 0.1) } : { output: 'Negative', confidence: Math.min(0.95, 0.65 + negative * 0.1) };
}

function summarise(text: string): { output: string; confidence: number } {
	const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
	return { output: first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first, confidence: 0.7 };
}

export function fillColumn(request: FillRequest, rows: ContextRow[], _target: Column): FillResult {
	const instruction = normalizeText(request.instruction);
	const choices = request.choices.length > 0 ? request.choices : choicesFromInstruction(request.instruction);
	const mode: FillResult['mode'] =
		choices.length > 0
			? 'categorise'
			: /sentiment|positive|negative|tone|mood/.test(instruction)
				? 'sentiment'
				: /summar|shorten|short version|tl ?dr/.test(instruction)
					? 'summarise'
					: 'extract';

	const values = rows.map((row) => {
		const input = inputText(row, request.sourceKeys);
		const result = !input
			? { output: '', confidence: 0 }
			: mode === 'categorise'
				? categorise(input, choices)
				: mode === 'sentiment'
					? sentiment(input)
					: mode === 'summarise'
						? summarise(input)
						: extract(input, request.instruction);
		// Snap free-text answers to an allowed choice when one is very close.
		if (mode !== 'categorise' && choices.length > 0 && result.output) {
			const snapped = choices.find((choice) => similarity(choice, result.output) > 0.85);
			if (snapped) result.output = snapped;
		}
		return { rowId: row.id, position: row.position, input, output: result.output, confidence: result.confidence };
	});
	return { mode, values };
}
